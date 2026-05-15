# homebridge-myhome-unik

Homebridge platform plugin for **Legrand MyHome / BTicino** home automation gateways. Exposes lights, blinds, thermostats, scenarios, dry contacts, and energy meters to Apple HomeKit via the [Homebridge](https://homebridge.io) Dynamic Platform API.

## Requirements

- Homebridge ≥ 1.6 (or 2.x)
- Node.js ≥ 18
- A Legrand MyHome gateway (F452, F454, F455, MH200, …) reachable on the local network over TCP port 20000

## Installation

```bash
npm install -g homebridge-myhome-unik
```

Or install via the Homebridge UI plugin search.

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
| `maxConcurrent` | integer | auto | Max simultaneous TCP command connections (1–10). If omitted the plugin queries the gateway model and sets an appropriate value automatically (F454/F455 → 4, F452/MH200 → 3, unknown → 2) |

### Accessory arrays

#### `lights`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name in HomeKit |
| `dimmer` | boolean | no | Enable brightness control (levels 2–10) |

#### `blinds`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | OWN `WHERE` address |
| `name` | string | no | Display name |
| `time` | integer | yes | Seconds for full travel (up or down) |
| `timeSlat` | integer | no | Extra seconds for slat rotation (venetian blinds only) |
| `slatPercent` | integer | no | Position % below which slat rotation occurs (venetian blinds only) |

#### `thermostats`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Zone probe address |
| `zone` | integer | yes | Central unit zone number |
| `name` | string | no | Display name |

#### `scenarios`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Scenario number (WHO=0) |
| `name` | string | no | Display name |

Exposed as a momentary switch — pressing it triggers the scenario, then resets to off after 500 ms. Prefer gateway scenarios over HomeKit scenes when controlling many devices at once (single command vs. one command per device).

#### `contacts`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Auxiliary/dry contact address (WHO=9) |
| `name` | string | no | Display name |

Read-only contact sensor.

#### `energies`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | integer | yes | Energy meter address (WHO=18) |
| `name` | string | no | Display name |

Exposed as a light sensor (watts reported as lux). Polls every 30 s.

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
