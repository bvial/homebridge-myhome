# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge platform plugin (`homebridge-myhome-unik`) that bridges **Legrand MyHome** (BTicino) home automation gateways with Apple HomeKit via Homebridge. Uses the **Dynamic Platform API** (Homebridge >=1.6). **TypeScript with strict mode** (Node.js >=18). Requires a build step: `npm run build` compiles `*.ts` → `dist/`.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm test             # Build + run automated test suite (node --test)
node test.ts         # Manual integration test against a real gateway (compile first)
```

## Architecture

### Entry Point & Registration

[index.ts](index.ts) registers `OwnPlatform` as a Dynamic Platform using the 2-argument `api.registerPlatform(PLATFORM_NAME, OwnPlatform)`. Re-exports `PLUGIN_NAME` and `PLATFORM_NAME` from [lib/constants.ts](lib/constants.ts). Previously `index.js` imported these back from itself (circular require); the `constants.ts` module breaks that cycle.

### Dynamic Platform Lifecycle

1. **Startup**: Homebridge creates the platform, then calls `configureAccessory()` once per cached accessory (persisted from previous runs).
2. **`didFinishLaunching`**: The platform queries the gateway model (`detectGatewayModel`), sets `maxConcurrent` (from config or auto-detected), then calls `discoverDevices()` to reconcile config against cached accessories — creating new ones, updating existing, and removing stale.
3. **UUID generation**: `api.hap.uuid.generate('myhome-' + type + '-' + id)` ensures stable identifiers across restarts.
4. **Handler pattern**: Each accessory gets an `OwnXxxAccessory` handler (stored in `activeHandlers[]`) that attaches HomeKit services and characteristic handlers to the `platformAccessory`.

### Core Classes

| File | Class(es) | Role |
|------|-----------|------|
| [lib/OwnPlatform.ts](lib/OwnPlatform.ts) | `OwnPlatform` | Dynamic Platform; owns `OwnClient` (as `controller`), dispatches packets via `activeHandlers`, runs keep-alive watchdog |
| [lib/OwnNet.ts](lib/OwnNet.ts) | `OwnConnection`, `OwnMonitor`, `OwnClient` | TCP networking, OpenWebNet auth handshake, command queue (concurrency auto-detected or config-driven) |
| [lib/OwnAccessory.ts](lib/OwnAccessory.ts) | `OwnLightAccessory`, `OwnBlindAccessory`, `OwnThermostatAccessory`, `OwnScenarioAccessory`, `OwnContactAccessory`, `OwnEnergyAccessory` | HomeKit accessory implementations using `onGet`/`onSet` API |
| [lib/OwnProtcol.ts](lib/OwnProtcol.ts) | `OwnProtcol` | Stateless packet parsing/encoding utilities and WHO constants |

### Communication Model

The plugin connects to a Legrand gateway over **raw TCP on port 20000** using the **OpenWebNet (OWN) protocol**:

- **MONITOR connection** (`*99*1##`): persistent; receives all state-change events pushed by the gateway.
- **COMMAND connections** (`*99*9##`): short-lived, queued; concurrency limit auto-detected from gateway model at startup (see `maxConcurrent` below) or overridden via config.

**Authentication**: The gateway either accepts the connection immediately (`*#*1##`) or sends a nonce. The client responds using `calcPass()` in `OwnNet.ts` — a bit-rotation/XOR chain applied to the configured password integer.

**Packet format**: `*WHO*WHAT*WHERE##` for commands, `*#WHO*WHERE*DIM*VAL##` for dimension reads. Multiple packets can arrive concatenated in one TCP data event; `OwnConnection` handles this with a while-loop regex scan.

### Accessory Behavior Notes

- **`OwnLightAccessory`**: Supports dimmer mode (config `dimmer: true`). Brightness maps to OWN levels 2-10; brightness=0 sends an off command. Also handles extended packets `*1*1000#X*WHERE##` (sent by the gateway when a light is triggered by a scenario or automation rule): `X=0` → off, `X>0` → on.
- **`OwnBlindAccessory`**: Position modeled by timing movement against configured `time` (seconds for full travel). Supports venetian blinds with `timeSlat`/`slatPercent`. On first `updateStatus()` resets to known state by issuing a full down command.
- **`OwnThermostatAccessory`**: Uses two addresses — `id` for the zone probe and `#0#<zone>` for central unit commands. Error on set when not in HEAT mode throws `HapStatusError`.
- **`OwnScenarioAccessory`**: Momentary switch — triggers scenario then resets to off after 500ms.
- **`OwnContactAccessory`**: Read-only dry contact sensor (WHO=9/auxiliary).
- **`OwnEnergyAccessory`**: Energy meter exposed as LightSensor (watts as lux). Polls every 30s.

### Reconnect Logic

`OwnMonitor` (in `OwnNet.ts`) is the single reconnect mechanism:
- After 30 s without a packet, sends a keep-alive probe (`*#13**15##` via WHO=13).
- Retries up to 3 times; on the 3rd failure triggers a full reconnect.
- Reconnect delay grows with each failed attempt (`reconnectSeconds × reconnectAttempts`, capped at 300 s).
- If authentication fails (`auth-failed`), reconnection is permanently disabled until Homebridge restarts.

### WHO Codes in Use

| Code | Subsystem |
|------|-----------|
| 0 | Scenario |
| 1 | Lighting |
| 2 | Automation (blinds) |
| 4 | Thermostat/Temperature |
| 9 | Auxiliary (dry contacts) |
| 13 | Gateway (keep-alive probe, model query) |
| 15/25 | CEN / CEN PLUS (physical button press events — received on monitor, silently ignored) |
| 18 | Energy management |
| 3 | Load control — received on monitor, silently ignored |
| 5 | Alarm — received on monitor, silently ignored |
| 7 | Video door entry — received on monitor, silently ignored |
| 16 | Sound system — received on monitor, silently ignored |
| 17 | Scenario/scene activation — received on monitor, silently ignored |
| 22 | Sound diffusion — received on monitor, silently ignored |
| 1001 | Auto-diagnostic (SCS bus device presence/serial scan) — silently ignored |
| 1000/1004/1013 | Diagnostic / heating diagnostic / device diagnostic — silently ignored |

## Configuration

See [config.schema.json](config.schema.json). The platform config block requires `host`. Optional: `port` (default 20000), `password` (numeric string), `maxConcurrent` (integer 1–10, default auto-detected). If `maxConcurrent` is omitted the plugin sends `*#13**15##` (DIM 15 = Device Type) at startup to identify the gateway model and sets the limit accordingly:

| Model code (DIM 15) | Gateway | `maxConcurrent` |
|---------------------|---------|-----------------|
| 200 | F454 | 4 |
| 6, 7 | F452, F452V | 3 |
| 4 | MH200 | 3 |
| 2, 11, 13 | MHServer, MHServer2, H4684 | 2 |
| unknown / no response | — | 2 |

The gateway responds with `*#13**15*<code>##`; if no data packet is received before ACK, model is treated as unknown. Startup log: `maxConcurrent auto-set to N (gateway: <Name> (code <N>))`. Accessories are declared under `lights[]`, `blinds[]`, `thermostats[]`, `scenarios[]`, `contacts[]`, and `energies[]` arrays, each with a numeric `id` (OWN `WHERE` address).

## Known Issues / Quirks

- `lib/OwnProtcol.ts` is intentionally misspelled ("Protcol") throughout the codebase — do not rename.
- `test.ts` is a manual live-gateway test script, not an automated test suite. It is excluded from the TypeScript build (`tsconfig.json` `exclude`) and must be run via `ts-node` or compiled separately.
- `tsconfig.json` keeps `"ignoreDeprecations": "6.0"` intentionally: `moduleResolution: "node10"` is deprecated in TypeScript 6 but migrating to `node16` requires either switching the project to ESM or adding `resolution-mode` attributes to all `homebridge` type imports (Homebridge 2 ships as ESM). Until the project migrates to ESM output, this suppression is load-bearing.
