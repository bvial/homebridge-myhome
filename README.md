# homebridge-myhome-unik

Homebridge platform plugin for **Legrand MyHome / BTicino** home automation gateways. Exposes lights, blinds, thermostats, scenarios, dry contacts, energy meters, and door relays through HomeKit and Matter using the [Homebridge](https://homebridge.io) Dynamic Platform API.

## Requirements

- Homebridge ≥ 2.4.0 (2.x); development tests use stable Homebridge 2.5.0
- Node.js 22 (≥ 22.13.0), 24, or 26
- A Legrand MyHome gateway (F452, F454, F455, MH200, …) reachable on the local network over TCP port 20000

## Installation

```bash
npm install -g homebridge-myhome-unik
```

Or install via the Homebridge UI plugin search.

## Matter

Set `expose` in the MyHome platform configuration to select the protocols:

| Value | Published accessories |
|-------|-----------------------|
| `homekit` (default) | HomeKit |
| `matter` | Matter |
| `both` | HomeKit and Matter, sharing the same device state and command queue |

Enable Matter on the Homebridge bridge as well: add `"matter": { "enabled": true }`
to the existing top-level `bridge` object, or to this platform's `_bridge` object
when using a child bridge. Homebridge must enable Matter before the plugin starts.
`expose: "matter"` reports a configuration error if Matter is disabled; `both`
publishes HomeKit and logs a warning in that case.

Example MyHome platform configuration:

```json
{
  "platform": "MyHome",
  "host": "192.168.1.35",
  "expose": "both",
  "lights": [{ "id": 1, "name": "Living room", "dimmer": true }],
  "thermostats": [{ "id": 1, "zone": 1, "name": "Heating", "matterMode": "heat" }]
}
```

Restart Homebridge, then use its Matter pairing code to add the bridge to a
compatible controller. Matter requires IPv6 connectivity and local discovery
between Homebridge and the controller. Pairing both protocols into the same
application exposes two tiles for each device. Changing `expose` removes the
accessories from the deselected protocol, so automations referring to those
accessories may need to be recreated.

| Device | Matter behavior |
|--------|-----------------|
| Lights | On/off and dimming |
| Blinds | Open, close, STOP, and position using the shared travel-time estimate |
| Thermostats | Temperature and manual setpoint, plus a separate automatic-program switch |
| Contacts | Contact, motion/occupancy, leak, smoke, or CO detection according to `sensorType` |
| Energy meters | Instantaneous electrical power; no cumulative energy is invented from power samples |
| Door relays | Momentary unlock; the displayed relay state does not confirm that the physical door is locked |
| Doorbells | Button events; application support and presentation vary |
| Scenarios | A virtual outlet action that resets after activation |

Brightness targets are applied immediately; a controller-requested fade duration
is not reproduced. Continuous dimming and stop commands are supported.
An OFF from HomeKit or the wall switch cancels continuous Matter dimming.

Control commands for each device are sent in order and report success only after
the gateway acknowledges them. Gateway rejections, disconnections and timeouts
are returned to the requesting application. A gateway ACK confirms acceptance
of the command, not physical feedback from a door lock or blind motor.

For thermostats, `matterMode` selects `heat` (default), `cool`, or `both`. Select
only the functions the zone supports. The separate programme switch enables
the MyHome scheduled programme; switching it off returns to manual control.
Matter's automatic heat/cool mode is not used to represent a MyHome schedule.
Temperature writes while the programme is active are rejected: switch to manual
control first. Matter does not make the OpenWebNet local temperature offset
writable; a remote +1°C offset while retaining the central schedule remains
unsupported by the documented gateway protocol.

Device identifiers and context are cached across restarts. Both protocols use
one controller per device, so blind calibration, position tracking, polling, and
gateway commands are shared. Energy display, button automations, and composed
thermostat controls depend on the Matter application used.

## Device discovery

The plugin includes a discovery tool that connects to the gateway and generates a draft config fragment:

```bash
npm run scan -- 192.168.1.35
# With password and custom address range:
npm run scan -- 192.168.1.35 20000 12345 --max-addr 50
# Show raw CONFIG-scan packets for debugging:
npm run scan -- 192.168.1.35 20000 12345 --verbose
```

The tool runs two phases:
1. **CONFIG scan** — queries the gateway's internal device list (F454/F455 only)
2. **STATUS scan** — probes basic addresses 1..N, thermostat zones up to 99,
   meters at `5N` and dry-contact interfaces at `3N`

Discovery requires a matching state reply, not just an ACK. An ACK only confirms
gateway acceptance of the request. Devices whose firmware returns no state reply
must be configured manually; they are not replaced with guessed accessories.

The output is a JSON fragment you paste into your Homebridge platform config, then adjust:
- Rename entries to meaningful names
- Set `time` (travel seconds) for blinds
- Set `timeSlat` / `slatPercent` for venetian blinds
- Verify `zone` for thermostats
- Add `"dimmer": true` for dimmer-capable lights
- Add scenarios manually (they have no detectable status)

## Configuration

Add a platform block to your Homebridge `config.json`:

```json
{
  "platform": "MyHome",
  "name": "MyHome",
  "host": "192.168.1.35",
  "port": 20000,
  "password": "12345",
  "lights": [...],
  "blinds": [...],
  "thermostats": [...],
  "scenarios": [...],
  "contacts": [...],
  "energies": [...]
}
```

### Platform options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `host` | string | — | **Required.** IP address or hostname of the gateway |
| `expose` | string | `homekit` | `homekit`, `matter`, or `both`; Matter must also be enabled on the Homebridge bridge |
| `port` | integer | `20000` | TCP port |
| `password` | string | `""` | Numeric for legacy authentication; up to 30 alphanumeric characters for SHA-1/SHA-256 authentication. Empty for trusted-IP access. |
| `maxConcurrent` | integer | auto | Max simultaneous TCP command connections (1–10). If omitted the plugin queries the gateway model (`*#13**15##`) at startup and sets the limit automatically: F454 → 4, F452/F452V/MH200 → 3, others/unknown → 2 |
| `autoDiscover` | boolean | `false` | Scan the gateway at startup for devices not yet in config and register them as placeholder accessories (`Light 5`, `Blind 3`, etc.). Add the discovered devices to `config.json` and restart to make them permanent — the placeholder is then automatically removed. |
| `autoDiscoverMaxAddr` | integer | `20` | Maximum address (1..N) probed per WHO type during auto-discovery. Higher values find more devices but lengthen the startup scan. Range 1–99. |

### Accessory arrays

#### `lights`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name in HomeKit |
| `dimmer` | boolean | no | Enable brightness control: OWN levels 2–10 mean 20–100%, in 10% steps. Nonzero targets below 20% use level 2. Extended `1000#WHAT` and DIM 1 state reports are decoded too. |
| `where` | string | no | Custom raw OWN `WHERE` address (e.g. `"68#4#01"` on a local bus). Defaults to `String(id)`. |

#### `blinds`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name |
| `where` | string | no | Raw shutter address, e.g. `68#4#01` on a local bus; defaults to `id` |
| `time` | number | unless both directional times are set | Default seconds for full linear travel; excludes slat rotation |
| `timeUp` / `timeDown` | number | no | Override `time` independently for opening and closing; positive, at most 3600 seconds |
| `timeSlat` | number | no | Extra seconds for slat rotation; must be positive when `slatPercent` is positive |
| `slatPercent` | integer | no | Virtual position range occupied by slat rotation, 0–99; both slat options must be zero or both positive |
| `calibrateOnStart` | boolean | no | Legacy default `true`: full closing calibration at startup. `false`: restore the cache without automatic movement. Overridden by `calibration`. |
| `calibration` | string | no | `always`, `whenUnknown` (at startup), or `manual`; explicit `manual` adds a calibration control |
| `calibrationSwitch` | boolean | no | Add a linked calibration switch to both protocols; default `false`, always shown with explicit `calibration: "manual"` |
| `postStopGraceMs` | integer | no | Filter one same-direction phantom after a wall STOP; default 150 ms, range 0–1000; 0 disables the filter |

Example with different opening and closing times:

```json
{ "id": 21, "name": "Living room blind", "timeUp": 20.5, "timeDown": 22,
  "calibration": "whenUnknown", "calibrationSwitch": true }
```

Position is estimated from elapsed monotonic time, including fractional movement
and slat-zone transitions. Delayed callbacks do not lose travel time. The estimate
continues while STOP is waiting in the queue; an overshoot is retained instead of
being snapped back to the requested target. Wall STOPs cancel the automatic target,
and newer targets cancel superseded, unsent commands. STOPs have priority over
unrelated commands and ten reserved queue entries. Unsent movement commands expire
after five seconds, including delayed handshakes.

The cache stores `blindState` (position, confidence, timestamp and movement marker)
alongside the legacy `blindPosition`. STOPs and motion starts trigger persistence;
intermediate 10% checkpoints are batched for HomeKit. Confidence is `estimated`,
`calibrated`, `measured` (hardware DIM 10 feedback), or `unknown`. A disconnect, interrupted movement or cache older than
24 hours at startup makes it unknown. HomeKit then reports StatusFault and retains
the last estimate; Matter reports a null current position. Timed actuators still
accept partial-position writes using that estimate, as before 0.5.0. Their accuracy
depends on the travel times and last known position. A full opening/closing or
calibration can establish a new reference. Only an explicit hardware report of
unknown position (DIM 10 level 255) prevents partial-position writes until corrected.

Calibration times a complete closing run from actual command dispatch, including
slat time. A natural STOP after the full duration completes calibration; otherwise
a safety STOP is sent after a one-second margin. A refusal or an early STOP leaves
the timed reference unknown. A manual STOP near an endpoint does not by itself
prove an exact 0% or 100% position.

Advanced actuators' DIM 10 reports correct the estimate and supply measured positions.
Level 255 remains unknown, and disabled actuator states prevent new movements.
A "command not executed" report fails that movement but allows a later user request;
it does not permanently disable the shutter in the plugin.
A timed calibration never overrides an explicit unknown hardware report. Commands
continue to use basic UP/DOWN/STOP for compatibility. The slat options describe a
combined virtual travel range; independent tilt control is not exposed.

For HomeKit/Siri troubleshooting, look for `Blind target requested` in the
Homebridge log. It records the requested target and the plugin's current state.
`Blind position failed` includes the reason a command was refused or failed.

#### `thermostats`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Zone probe address |
| `zone` | integer | yes | Central unit zone number |
| `where` | string | no | Override the control address. Use `#1` for zone 1 on a 99-zone central unit, or `#0` for that central unit itself. Legacy default: `#0#<zone>`. |
| `matterMode` | string | no | Functions exposed by Matter: `heat` (default), `cool`, or `both` |
| `name` | string | no | Display name |

Supports HEAT, COOL, OFF and AUTO modes. The target temperature characteristic is exposed to HomeKit in the range 5°C..30°C; values reported by the gateway outside this range (e.g. `0` when a zone is OFF) are clamped to avoid HAP warnings. A linked `TemperatureSensor` service is added so the Home app can graph temperature history.

Mode and manual-setpoint changes reported by the central unit take precedence over
older remote commands. Obsolete writes are cancelled before transmission, including
during TCP connection setup, and a late ACK cannot restore an older mode or setpoint.
OFF uses generic command 303 for both heating and cooling. Zone addresses `#N` use
311 for AUTO; central-unit addresses use 3100 to resume the stored programme.
Activity comes from valve/fan-coil reports, not merely the heating/cooling season.

#### `scenarios`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Stable accessory identifier; also the scenario number unless `scenario` is supplied |
| `scenario` | integer | no | Scenario number 1–20 on the module; defaults to `id` |
| `where` | string | yes | Module address 01–99, optionally on a local bus (e.g. `23#4#01`) |
| `name` | string | no | Display name |

Scenarios are exposed as an auto-reset switch — pressing it triggers the scenario, then resets to off after 500 ms. Prefer gateway scenarios over HomeKit scenes when controlling many devices at once (single command vs. one command per device).

**Migration:** add the module's `where` to existing scenarios. WHO 0 has no general
address 0; the old `*0*<id>*0##` command was not a documented scenario activation.
For example, `{ "id": 101, "scenario": 3, "where": "23" }` sends `*0*3*23##`.

> **Note:** the historical `asButton` option (which exposed the scenario as a `StatelessProgrammableSwitch`) was removed in 0.4.7. A stateless programmable switch is emit-only in HomeKit — it could not receive taps from the Home app, so `asButton: true` silently disabled scenario activation. If you had `asButton: true` in your config, simply remove that key; the previously-registered SPS service is cleaned up automatically at next startup.

#### `contacts`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Legacy AUX address, or channel/ZN for a standard contact/IR interface |
| `name` | string | no | Display name |
| `protocol` | string | no | `auxiliary` (legacy WHO 9, default), `dry-contact` (WHO 25), or `ir` (WHO 25) |
| `where` | string | no | Raw address override. Defaults to `id` for AUX or `3<id>` for WHO 25. |
| `sensorType` | string | no | One of `contact` (default), `motion`, `occupancy`, `leak`, `smoke`, `co`. Selects the HomeKit service used to display the dry contact. |

Read-only contact sensor. For `motion`/`occupancy`/`leak`/`smoke`/`co` types: contact CLOSED = safe/idle, contact OPEN = triggered/alarm. **Changing `sensorType` at runtime removes the old service.**

Standard dry contacts use WHO 25 (`31` = closed, `32` = open). For `protocol: "ir"`,
`31` means detection instead. Example: `{ "id": 11, "protocol": "ir", "sensorType": "motion" }`
reads address `311`. Event (`#1`) and status-response (`#0`) variants are supported.

#### `energies`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Raw energy address, or stable identifier when `where` is set |
| `name` | string | no | Display name |
| `where` | string | no | Raw address override: meters use `5N` (e.g. `51`), energy actuators use `7N#0` (e.g. `71#0`) |
| `asOutlet` | boolean | no | Expose as `Outlet` with Eve Consumption characteristic instead of `LightSensor` (default `false`). |

Default mode: light sensor (watts reported as lux). With `asOutlet: true` the meter is exposed as an Outlet whose `In Use` reflects power draw, plus the Eve custom Consumption characteristic for proper Eve.app energy graphing. Polls every 30 s. **Changing this flag at runtime removes the old service.**

#### `doors` (door entry / video door — WHO=7)

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Door entry / video door address (WHO=7) |
| `name` | string | no | Display name |
| `openCommand` | string | no | OWN command to send when the lock is opened (default `*7*19*<id>##`) |
| `doorbell` | boolean | no | Add a linked `Doorbell` service that fires `SINGLE_PRESS` on incoming WHO=7 packets matching the address |

Exposed as `LockMechanism`. Setting the lock to UNSECURED sends the open command; the lock auto-resets to SECURED after 3 s (the relay is momentary). With `doorbell: true`, an incoming bus packet (e.g. an intercom button press) fires a HomeKit doorbell event for automation.

## Known Limitations

- **UUID stability**: HomeKit accessory UUIDs are derived from `myhome-${type}-${id}`. Changing the `type` of a config entry (e.g. moving an `id` from `lights` to `contacts`) generates a new UUID, unregisters the old accessory, and registers a new one. HomeKit automations referencing the old accessory will need to be recreated.
- **Tile flips**: When you toggle `asOutlet` or `sensorType`, the plugin removes the old service from the accessory at next startup. HomeKit automations bound to the old service will need to be recreated.

## Example configuration

```json
{
  "platform": "MyHome",
  "name": "MyHome",
  "host": "192.168.1.35",
  "password": "12345",
  "lights": [
    { "id": 11, "name": "Living room" },
    { "id": 12, "name": "Kitchen", "dimmer": true }
  ],
  "blinds": [
    { "id": 21, "name": "Living room blind", "time": 25 },
    { "id": 22, "name": "Bedroom venetian", "time": 20, "timeSlat": 3, "slatPercent": 10 }
  ],
  "thermostats": [
    { "id": 1, "zone": 1, "name": "Living room thermostat" }
  ],
  "scenarios": [
    { "id": 1, "where": "23", "name": "Good night" },
    { "id": 2, "where": "23", "name": "All off" }
  ],
  "contacts": [
    { "id": 1, "protocol": "dry-contact", "name": "Front door" }
  ],
  "energies": [
    { "id": 51, "name": "Main meter" }
  ]
}
```

## How it works

The plugin opens two types of TCP connections to the gateway:

- **Monitor connection** (persistent): receives all state-change events pushed by the gateway in real time.
- **Command connections** (short-lived): one connection per command, queued with a configurable concurrency limit. The gateway model is queried at startup to set the optimal limit automatically.

Authentication is negotiated with the gateway: legacy numeric nonce/response
(`calcPass`), or SHA-1/SHA-256 mutual authentication as specified by Legrand HMAC
v1.1. The server proof is verified before commands are sent. Authentication failure
stops both command dispatch and monitoring until restart.

The monitor connection is watched by a keep-alive probe (`*#13**15##`). If the probe fails three times consecutively the connection is re-established with increasing back-off (up to 5 minutes between attempts).

See [the protocol review](docs/PROTOCOL_REVIEW.md) for the official specifications,
the validated scope and the remaining hardware-dependent limitations.
