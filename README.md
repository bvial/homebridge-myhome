# homebridge-myhome-unik

Homebridge platform plugin for **Legrand MyHome / BTicino** home automation gateways. Exposes lights, blinds, thermostats, scenarios, dry contacts, and energy meters to Apple HomeKit via the [Homebridge](https://homebridge.io) Dynamic Platform API.

## Requirements

- Homebridge ≥ 2.0
- Node.js ≥ 18
- A Legrand MyHome gateway (F452, F454, F455, MH200, …) reachable on the local network over TCP port 20000

## Installation

```bash
npm install -g homebridge-myhome-unik
```

Or install via the Homebridge UI plugin search.

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
2. **STATUS scan** — probes each address (1..N) for all device types; works on all gateways

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
| `port` | integer | `20000` | TCP port |
| `password` | string | `""` | Numeric password (leave empty if none) |
| `maxConcurrent` | integer | auto | Max simultaneous TCP command connections (1–10). If omitted the plugin queries the gateway model (`*#13**15##`) at startup and sets the limit automatically: F454 → 4, F452/F452V/MH200 → 3, others/unknown → 2 |
| `autoDiscover` | boolean | `false` | Scan the gateway at startup for devices not yet in config and register them as placeholder accessories (`Light 5`, `Blind 3`, etc.). Add the discovered devices to `config.json` and restart to make them permanent — the placeholder is then automatically removed. |
| `autoDiscoverMaxAddr` | integer | `20` | Maximum address (1..N) probed per WHO type during auto-discovery. Higher values find more devices but lengthen the startup scan. Range 1–99. |

### Accessory arrays

#### `lights`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name in HomeKit |
| `dimmer` | boolean | no | Enable brightness control (levels 2–10). When a light is triggered by a gateway scenario or automation rule, the gateway sends an extended packet (`*1*1000#X*WHERE##`) that is handled transparently. |
| `where` | string | no | Custom raw OWN `WHERE` address for special relay configurations (e.g. `"68#4#01"` for group/sub-unit relays). Defaults to `String(id)`. |

#### `blinds`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name |
| `time` | integer | yes | Seconds for full travel (up or down) |
| `timeSlat` | integer | no | Extra seconds for slat rotation (venetian blinds only) |
| `slatPercent` | integer | no | Position % below which slat rotation occurs (venetian blinds only) |
| `calibrateOnStart` | boolean | no | Default `true`. When `true`, the blind moves fully down on first Homebridge start to establish a known position (0%). Set to `false` to restore the last cached position from `accessory.context.blindPosition` without moving the blind — useful if you don't want blinds to move on every Homebridge restart. The position is automatically cached on every STOP and at every 10% boundary during movement. |

#### `thermostats`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Zone probe address |
| `zone` | integer | yes | Central unit zone number |
| `name` | string | no | Display name |

Supports HEAT, COOL, OFF and AUTO modes. The target temperature characteristic is exposed to HomeKit in the range 5°C..30°C; values reported by the gateway outside this range (e.g. `0` when a zone is OFF) are clamped to avoid HAP warnings. A linked `TemperatureSensor` service is added so the Home app can graph temperature history.

#### `scenarios`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Scenario number (WHO=0) |
| `name` | string | no | Display name |
| `asButton` | boolean | no | Expose as `StatelessProgrammableSwitch` instead of Switch (default `false`). Switch with auto-reset preserves existing automations; button is semantically correct for momentary scenarios. **Changing this flag at runtime removes the old service.** |

Default mode: momentary switch — pressing it triggers the scenario, then resets to off after 500 ms. With `asButton: true` the scenario is exposed as a Stateless Programmable Switch (Home app shows it as a button rather than a toggle). Prefer gateway scenarios over HomeKit scenes when controlling many devices at once (single command vs. one command per device).

#### `contacts`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Auxiliary/dry contact address (WHO=9) |
| `name` | string | no | Display name |
| `sensorType` | string | no | One of `contact` (default), `motion`, `occupancy`, `leak`, `smoke`, `co`. Selects the HomeKit service used to display the dry contact. |

Read-only contact sensor. For `motion`/`occupancy`/`leak`/`smoke`/`co` types: contact CLOSED = safe/idle, contact OPEN = triggered/alarm. **Changing `sensorType` at runtime removes the old service.**

#### `energies`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Energy meter address (WHO=18) |
| `name` | string | no | Display name |
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
- **Tile flips**: When you toggle `asButton`, `asOutlet`, or `sensorType`, the plugin removes the old service from the accessory at next startup. HomeKit automations bound to the old service will need to be recreated.

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
    { "id": 1, "name": "Good night" },
    { "id": 2, "name": "All off" }
  ],
  "contacts": [
    { "id": 1, "name": "Front door" }
  ],
  "energies": [
    { "id": 1, "name": "Main meter" }
  ]
}
```

## How it works

The plugin opens two types of TCP connections to the gateway:

- **Monitor connection** (persistent): receives all state-change events pushed by the gateway in real time.
- **Command connections** (short-lived): one connection per command, queued with a configurable concurrency limit. The gateway model is queried at startup to set the optimal limit automatically.

Authentication uses the OpenWebNet HMAC-style nonce/response mechanism (`calcPass`).

The monitor connection is watched by a keep-alive probe (`*#13**15##`). If the probe fails three times consecutively the connection is re-established with exponential back-off (up to 5 minutes between attempts).
