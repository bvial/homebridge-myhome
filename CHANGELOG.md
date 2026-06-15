# Changelog

All notable changes to this project are documented here.

## [0.4.1]

### Fixed
- **CRITICAL — Blind manual operation not reflected in HomeKit after first cycle.**
  `evaluatePosition()` cleared the position-tracking timeout but never reset
  the field to `undefined`, causing the `!this.positionTimeout` guard in `onData`
  to permanently block subsequent state updates. Symptom: after autocalibration,
  the first manual UP/STOP cycle worked, then all later wall-switch movements
  were silently ignored.
- **Calibration safety STOP not always sent.** The init timer is meant as a
  safety net guaranteeing a STOP after the full travel time. `endCalibration()`
  was clearing this timer when a premature gateway STOP arrived, defeating the
  guarantee. Now the timer fires unconditionally — duplicate STOPs are harmless.
- **Blind direction mapping inverted.** On BTicino installations, the gateway
  broadcasts `*2*1*<id>##` for DOWN/closing and `*2*2*<id>##` for UP/opening.
  Previous versions mapped these incorrectly, causing HomeKit to display
  "closing" while the blind opened (and vice versa). Both incoming packet
  interpretation and outgoing commands (moveUp, moveDown, calibration init)
  are now aligned with the BTicino convention.

### Unchanged from 0.4.0
- Blind position tracking, caching, calibrateOnStart, all other behavior.

## [0.4.0]

### Added
- **Door / Video Door (WHO=7)** support: new `doors[]` config entry exposes a
  `LockMechanism` for momentary door release (default `*7*19*<id>##`, customizable
  via `openCommand`). Optional `doorbell: true` adds a linked `Doorbell` service
  that fires `SINGLE_PRESS` when an incoming WHO=7 packet matches the address.
- **`maxConcurrent` config option**: wired up to override the auto-detected gateway
  command queue concurrency (1–10). Documented but previously ignored.
- **`leak`, `smoke`, `co` sensor types** for `contacts[]`: dry contacts can now be
  exposed as `LeakSensor`, `SmokeSensor`, or `CarbonMonoxideSensor` services.
- **Tests for opt-in code paths**: identify blink, sensor type flips,
  asButton/asOutlet/door category assignments, COOL thermostat, configuredName
  persistence, init timer with `timeSlat`.
- **CHANGELOG.md** (this file).

### Changed
- **Plugin verifier compliance**: `package.json` now includes `displayName`,
  the `homebridge-platform` keyword, additional discovery keywords (`legrand`,
  `bticino`, `myhome`, `openwebnet`), and the repository/bugs URLs use HTTPS.
- **Homebridge requirement clarified**: README and CLAUDE.md now explicitly
  require Homebridge ≥ 2.0 (`peerDependencies` was already enforcing it).
- **Per-tick blind position logs** moved from `info` to `debug` to reduce log
  spam during movement (multiple blinds simultaneously).
- **`sendOrThrow` now throws `RESOURCE_BUSY`** (HAP −70403) when the command
  queue is full, instead of `SERVICE_COMMUNICATION_FAILURE`. HomeKit retries
  busy errors with a different policy.
- **Accessory categories** now adapt to opt-in flags: scenarios with
  `asButton: true` use `PROGRAMMABLE_SWITCH` (15), energy with `asOutlet: true`
  uses `OUTLET` (7), doors use `DOOR_LOCK` (6).
- **`configureAccessory` no longer eagerly creates handlers** — defers to
  `discoverDevices` to avoid using stale `context.device` when config changed
  between sessions (e.g. `asButton` toggled).
- **Thermostat `CurrentTemperature` `minStep`** set to `0.1` (matches the
  linked `TemperatureSensor`).
- **Thermostat `validValues`** uses named characteristic constants instead of
  raw `[0, 1, 2, 3]`.
- **Contact sensor service selection** refactored to a single `SENSOR_MAP` lookup
  table (replacing the duplicated switch+map pattern).
- **`heatingCoolingState`** field renamed to `currentHeatingCoolingState` for
  consistency with the HAP characteristic name (and the `targetHeatingCoolingState`
  sibling).
- **Magic numbers extracted**: `IDENTIFY_JOG_MS`, `BLIND_MIN_TICK_MS`,
  `COMMAND_QUEUE_CAPACITY`, `COMMAND_TIMEOUT_MS` are now named constants in
  `lib/utils.ts`.
- **`config.schema.json` validations**: `id` (≥ 1), `time` (≥ 1), `zone` (≥ 1),
  `port` (1–65535), `maxConcurrent` (1–10), `slatPercent` (0–100). Surfaces
  validation in the Homebridge UI before save.

### Fixed
- **NACK in `STATE.CONNECTING`**: gateway rejection of session type now ends the
  connection cleanly with a clear error log, instead of mis-parsing the packet
  as a nonce and reporting a misleading "wrong password" error.
- **Light/Blind identify timers** are now stored in private fields and cleared
  on `destroy()`, preventing callbacks on destroyed instances.
- **Energy meter `onData` now early-returns when destroyed**, plus
  `eveWattsChar` is nulled in `destroy()` for clean object teardown.
- **Blind `moveStop`/`moveUp`/`moveDown` and init `updateStatus`** now check
  `sendCommand` return value: on queue-full, `commandSent`/`homeKitMovement` are
  reset so the blind cannot get stuck in a "command pending" state with no
  actual command queued.
- **`characteristic-warning` listener** is now removed in `destroy()`.
- **Type guards** added before config casts in `createHandler` — corrupted
  `accessory.context.device` no longer silently passes a malformed object to
  the constructor.
- **Service-flip cleanup** is now bidirectional for `asButton`, `asOutlet`,
  and `sensorType` (previously only one direction cleaned up).

## [0.3.6] — 2026-05-16

Last release before this changelog was added. See git history for details.
