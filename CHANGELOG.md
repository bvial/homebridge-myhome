# Changelog

All notable changes to this project are documented here.

## [0.4.4] — Unreleased

### Fixed
- **Blind direction mapping inverted (regression observed in field).** On
  BTicino installations the gateway broadcasts `*2*1*<id>##` for DOWN/closing
  and `*2*2*<id>##` for UP/opening. The plugin had these reversed, causing
  HomeKit to display "closing" when the user manually opened the blind via the
  wall switch (and vice versa). Both incoming packet interpretation and
  outgoing commands are now aligned with the BTicino convention:
    - `onData` direction `'1'` → `DECREASING`, direction `'2'` → `INCREASING`
    - `moveUp()` sends `*2*2*<id>##`
    - `moveDown()` sends `*2*1*<id>##`
    - Calibration init sends `*2*1*<id>##`
- **Calibration safety STOP not always sent.** The init timer is meant as a
  safety net guaranteeing a STOP after the full travel time. `endCalibration()`
  was clearing this timer when a premature gateway STOP arrived, defeating the
  guarantee. Now the timer fires unconditionally — duplicate STOPs are
  harmless (motor already off).
- **Thermostat HAP "value 0 exceeded minimum of 5" warning at startup.**
  The `TargetTemperature` characteristic exposes `minValue=5/maxValue=30` but
  the field was initialized to `0`. HomeKit's first read produced a warning.
  Fix: initialize `targetTemperature` to `20°C` (sane default within range)
  and clamp every `updateCharacteristicTargetTemperature()` value to `[5, 30]`
  so gateway packets reporting out-of-range setpoints (e.g. `0` when the zone
  is OFF) no longer trigger the warning.

## [0.4.3] — 2026-06-15

### Reverted
- **`inverted` blind option removed.** Introduced briefly in the previous tag
  to swap UP/DOWN OWN codes for some installations, the option's default
  flip caused regressions in setups that did not opt out explicitly. Reverted
  to the 0.4.0 direction mapping. (A correct fix lands in 0.4.4 by aligning
  the mapping to the BTicino convention.)

## [0.4.2] — 2026-06-15

### Fixed
- **CRITICAL — Blind manual operation not reflected in HomeKit after first
  cycle.** `evaluatePosition()` cleared the position-tracking timeout but
  never reset the field to `undefined`, causing the `!this.positionTimeout`
  guard in `onData` to permanently block subsequent state updates. Symptom:
  after autocalibration, the first manual UP/STOP cycle worked, then all
  later wall-switch movements were silently ignored.

### Added
- **`inverted` blind config option** to swap UP/DOWN OWN direction codes.
  *(Reverted in 0.4.3.)*

## [0.4.1] — 2026-06-15

### Fixed
- **`log.success` → `log.info`** for compatibility with Homebridge 2.0.x
  (the `log.success` method was added in 2.1; some installations were on 2.0
  and could not load the plugin).

### Added
- **Custom `where` for lights** — optional raw OWN `WHERE` address for
  special relay configurations (e.g. `"68#4#01"`). Defaults to `String(id)`.
  Light command and status-query regexes accept `[\d#]+` for the address
  field so non-numeric addresses are recognized in incoming monitor packets.
- **Blind position cache + `calibrateOnStart`** — the last known position is
  cached to `accessory.context.blindPosition` on every STOP and at every 10%
  boundary during movement. With `calibrateOnStart: false` the cached
  position is restored at startup without moving the blind.
- **Auto-discovery of devices** — `autoDiscover: true` (default `false`)
  scans the gateway at startup for devices not yet in config and registers
  them as placeholder accessories (`Light 5`, `Blind 3`, …). New
  `autoDiscoverMaxAddr` (default 20) caps the probe range. Shared
  `lib/scanHelper.ts` is reused by the standalone `scan.ts` CLI tool.
- **Bug fix audit pass on the blind state machine** — STOP packets now
  always trigger `evaluatePosition()` even when `positionTimeout` is pending;
  position snap on STOP only applies during HomeKit movement; `initPhase` is
  cleared when `position === 0`; `homeKitMovement` is restored on rapid
  retarget; `move()` retry path increments `moveRetries` and gives up after
  `BLIND_MAX_MOVE_RETRIES`; `startMoveTracking` give-up calls
  `stopMoveTracking()`; `identify` jog protects ongoing movements.

## [0.4.0] — 2026-06-13

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
