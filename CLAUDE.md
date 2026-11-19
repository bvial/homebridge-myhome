# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge platform plugin (`homebridge-myhome-unik`) that bridges **Legrand MyHome** (BTicino) home automation gateways with HomeKit and Matter via Homebridge. Uses the **Dynamic Platform API** (Homebridge >=2.4, 2.x). **TypeScript with strict mode** (Node.js 22 >=22.13.0, 24 or 26). Requires a build step: `npm run build` compiles `*.ts` → `dist/`.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm test             # Build + run automated test suite (node --test)
node test.js         # Manual integration test against a real gateway (compile first)
```

## Architecture

### Entry Point & Registration

[index.ts](index.ts) registers `OwnPlatform` using `api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OwnPlatform)`. Re-exports `PLUGIN_NAME` and `PLATFORM_NAME` from [lib/constants.ts](lib/constants.ts).

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
| [lib/OwnDevice.ts](lib/OwnDevice.ts) | `OwnDevice` | Shared command, snapshot and event contract for both protocols |
| [lib/OwnMatterBridge.ts](lib/OwnMatterBridge.ts) | `OwnMatterBridge` | Matter descriptors, commands, state projection and cache reconciliation |
| [lib/OwnBlindController.ts](lib/OwnBlindController.ts) | `OwnBlindController` | Protocol-neutral motor operations, cancellation, calibration and position confidence |
| [lib/BlindPositionEstimator.ts](lib/BlindPositionEstimator.ts) | `BlindPositionEstimator` | Fractional monotonic travel-time integration with independent directional durations and slat zone |

### HomeKit and Matter

The platform's `expose` option is `homekit` (default), `matter`, or `both`. Matter
also requires the bridge's Matter API to be enabled. Each physical device has
one controller in `activeHandlers`; both adapters call its `execute()` and
observe its `snapshot()`/`subscribe()` contract. Matter-only mode uses an
unpublished HAP service container for the existing device controller. Never
instantiate a second blind state machine or energy poller for the other protocol.

`configureMatterAccessory()` restores `context.deviceContext` into this container
when no HAP cache is available. Matter descriptors are registered after discovery
and before starting the monitor. Snapshot updates are deferred outside Matter
command transactions, and shutdown prevents pending startup work from reconnecting.

Dimmers compose the public LevelControl behavior and override its command logic
hooks, including the WithOnOff variants that Homebridge 2.4 does not forward through
its handler registry. Do not also register `handlers.levelControl`: Homebridge would
replace the composed behavior. Cached dimmer endpoints must be reconstructed to
restore these hooks because Homebridge compares behavior keys rather than classes.

Thermostat `matterMode` (`heat`, `cool`, `both`; default `heat`) selects Matter
capabilities. MyHome's scheduled `auto` mode is exposed as a separate programme
switch, not Matter's automatic heat/cool mode. Temperature writes in scheduled
mode remain rejected. Scenarios use a commandable virtual outlet with auto-reset;
doorbells emit GenericSwitch events. Power is converted from W to Matter mW.

### Communication Model

The plugin connects to a Legrand gateway over **raw TCP on port 20000** using the **OpenWebNet (OWN) protocol**:

- **MONITOR connection** (`*99*1##`): persistent; receives all state-change events pushed by the gateway.
- **COMMAND connections** (`*99*9##`): short-lived, queued; concurrency limit auto-detected from gateway model at startup (see `maxConcurrent` below) or overridden via config.

**Authentication**: Trusted-IP connections are accepted immediately. Legacy nonces use `calcPass()` in `OwnNet.ts`. `*98*1##` / `*98*2##` negotiate SHA-1/SHA-256 mutual authentication implemented in `OwnAuth.ts` against Legrand HMAC v1.1. It is a hash of ASCII hex fields, not `crypto.createHmac`. Verify the server proof before emitting `connected`. Any authentication failure blocks the whole client, including queued discovery commands.

**Packet format**: `*WHO*WHAT*WHERE##` for commands, `*#WHO*WHERE*DIM*VAL##` for dimension reads. Multiple packets can arrive concatenated in one TCP data event; `OwnConnection` handles this with a while-loop regex scan.

### Accessory Behavior Notes

- **Matter restoration**: Homebridge >= 2.5.0 restores composed thermostat/occupancy
  features in place. Detect it via `api.versionGreaterOrEqual`, preserving the 2.4
  reconstruction path. Custom dimmer LevelControl classes still require reconstruction
  on both versions; behavior-key/feature checks cannot compare their device hooks.

- **`OwnLightAccessory`**: WHAT 2..10 means 20..100% (WHO 1 v1.2), not a remapped 1..100% scale. DIM 1 reports level 100..200 plus speed; subtract 100. Decode via `OwnProtcol.decodeLightState`, including `1000#WHAT`, and filter the exact WHERE. Relative/timed WHATs must not become brightness levels. Later bus observations take precedence over ACK fallback; HAP writes reassert the actual level after commit.
- **`OwnBlindAccessory`**: HAP facade over one `OwnBlindController`; Matter calls the same facade. `timeUp`/`timeDown` fall back to `time`. Position is fractional and monotonic-time-based, not callback-count-based. Each target replaces unsent older commands using generation guards, including after TCP handshake. STOP uses reserved capacity and priority, preserving per-device ordering. Monitor STOPs override automatic movement unless correlated with a sent STOP or a completed full run; status-channel replies never mask monitor events. Timed calibration (`always`, `whenUnknown`, `manual`) requires an uninterrupted full closing duration including slat time and either its natural end-stop or an acknowledged safety STOP. `calibrateOnStart` retains its legacy meaning when the new policy is absent. `blindState` holds confidence/timestamp/dirty marker, `blindPosition` remains for migration. Start/STOP persistence is immediate; intermediate checkpoints are batched. Timed partial targets use the last estimate even when confidence is unknown; only an explicit DIM 10 position 255 prevents them. Reference courses are reserved for calibration and endpoint targets, never partial targets. Direction mapping remains `*2*1*` = opening, `*2*2*` = closing. Tests inject the clock and exercise public commands/events, not obsolete timer flags.
  Natural end-stop STOPs after the full travel duration complete calibration without waiting for the extra margin. Advanced DIM 10 reports supply measured positions (255 = unknown) and disabled/rejected states. Never overwrite explicit unknown hardware feedback with a timed reference. `where` supports local buses; independent tilt and native GoToLevel writes are not exposed.
- **`OwnThermostatAccessory`**: Uses two addresses — `id` for the zone probe and `#0#<zone>` for central unit commands. Supports HEAT, COOL, OFF, and AUTO modes. TargetTemperature is writable in both HEAT and COOL modes (DIM 14 mode byte `*1` = Heat, `*2` = Cool). Linked `TemperatureSensor` service provides temperature history graphing in the Home app. `targetTemperature` is exposed to HomeKit with `minValue=5`/`maxValue=30` and clamped on every update so out-of-range setpoints from the gateway (e.g. `0` when the zone is OFF) do not trigger HAP warnings.
- **`OwnScenarioAccessory`**: Exposed as a `Switch` with auto-reset after 500ms (preserves automations). The historical `asButton` option (which used `StatelessProgrammableSwitch`) was removed in 0.4.7 because SPS is emit-only in HomeKit — it cannot receive taps from the Home app, so `asButton: true` silently disabled activation. Any pre-existing SPS service from an older install is cleaned up at startup.
- **`OwnContactAccessory`**: `protocol` selects legacy WHO 9 `auxiliary` or standard WHO 25 `dry-contact`/`ir`. WHO 25 uses 31#0/1 and 32#0/1 at 3N addresses. 31 means closed for a contact and detected for IR; polarity must not be conflated. `sensorType` selects the HAP/Matter presentation. CEN button frames are ignored rather than routed as contact events.
- **`OwnEnergyAccessory`**: Default mode is `LightSensor` with watts displayed as lux (legacy). Optional `asOutlet: true` config exposes it as `Outlet` with the Eve Consumption custom characteristic (UUID `E863F10D-079E-48FF-8F27-9C2605A29F52`) for proper Eve.app integration. Polls every 30s.

### Service-flip cleanup

When `asOutlet` or `sensorType` is changed in config, the accessory removes the previously-registered service of the other type at next startup so that only one primary service remains. This prevents both LightSensor+Outlet (or multiple sensor variants) from being attached to the same accessory. The scenario accessory also removes any leftover `StatelessProgrammableSwitch` service from the deprecated `asButton: true` mode.

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
| 15/25 | CEN / CEN PLUS; WHO 25 contact/IR states are routed, button events are ignored |
| 18 | Energy management |
| 3 | Load control — received on monitor, silently ignored |
| 5 | Alarm — received on monitor, silently ignored |
| 7 | Video door entry — routed to configured door adapters |
| 16 | Sound system — received on monitor, silently ignored |
| 17 | Scenario/scene activation — received on monitor, silently ignored |
| 22 | Sound diffusion — received on monitor, silently ignored |
| 1001 | Auto-diagnostic (SCS bus device presence/serial scan) — silently ignored |
| 1000/1004/1013 | Diagnostic / heating diagnostic / device diagnostic — silently ignored |

## Configuration

See [config.schema.json](config.schema.json). The platform config block requires `host`. Optional: `port` (default 20000), `password` (numeric legacy or alphanumeric HMAC), `maxConcurrent` (integer 1–10, default auto-detected). If `maxConcurrent` is omitted the plugin sends `*#13**15##` (DIM 15 = Device Type) at startup to identify the gateway model and sets the limit accordingly:

| Model code (DIM 15) | Gateway | `maxConcurrent` |
|---------------------|---------|-----------------|
| 200 | F454 | 4 |
| 6, 7 | F452, F452V | 3 |
| 4 | MH200 | 3 |
| 2, 11, 13 | MHServer, MHServer2, H4684 | 2 |
| unknown / no response | — | 2 |

The gateway responds with `*#13**15*<code>##`; if no data packet is received before ACK, model is treated as unknown. Startup log: `maxConcurrent auto-set to N (gateway: <Name> (code <N>))`. Accessories are declared under `lights[]`, `blinds[]`, `thermostats[]`, `scenarios[]`, `contacts[]`, `energies[]`, and `doors[]` arrays, each with a numeric `id` (OWN `WHERE` address).

### Auto-discovery

When `autoDiscover: true`, the STATUS scan probes WHO 1/2/9 at 1..N, WHO 4 up to min(N,99), WHO 18 at 5N and WHO 25 at 3N. An ACK alone never establishes device presence: a matching state reply is required. Placeholder UUIDs remain `myhome-auto-${who}-${id}` and promotion compares full bus addresses. Blinds default to `time: 30`, `calibrateOnStart: false`. WHO 25 placeholders use explicit raw WHERE and `protocol: "dry-contact"`; users should select IR presentation when appropriate. Scenarios and doors require manual configuration.

`startMonitor()` is deferred until the auto-discovery scan resolves (typically 2–9 s) to avoid saturating the command queue with concurrent monitor keep-alive probes during the scan. The shared scan logic lives in [lib/scanHelper.ts](lib/scanHelper.ts) and is also used by the standalone `scan.ts` CLI tool.

## Known Issues / Quirks

- `lib/OwnProtcol.ts` is intentionally misspelled ("Protcol") throughout the codebase — do not rename.
- `test.js` is a manual live-gateway test script, not an automated test suite. It runs against compiled output in `dist/` and requires a live gateway.
- `tsconfig.json` keeps `"ignoreDeprecations": "6.0"` intentionally: `moduleResolution: "node10"` is deprecated in TypeScript 6 but migrating to `node16` requires either switching the project to ESM or adding `resolution-mode` attributes to all `homebridge` type imports (Homebridge 2 ships as ESM). Until the project migrates to ESM output, this suppression is load-bearing.
