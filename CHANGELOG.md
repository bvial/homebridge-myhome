# Changelog

All notable changes to this project are documented here.

## [0.4.9] — 2026-07-14

### Fixed
- **Manual (wall-switch) blind operations at an end-stop are no longer ignored
  (long-standing bug, present since ≤ 0.4.6).** This gateway emits `*2*0*`
  (STOP) immediately before every direction packet, including manual ones. The
  post-STOP spurious-packet filter used `position === target` as its "at rest"
  signal — but at an end-stop (position 0 or 100) that is permanently true, so
  every manual command issued from a fully-open/closed blind was swallowed as a
  phantom and never reached HomeKit. The filter now suppresses only a direction
  packet that **matches the direction the blind was last moving** (the real F454
  phantom re-emits the same direction); a genuine manual command from an
  end-stop is the opposite direction and passes through. New field
  `lastMovingDirection` tracks this; three regression tests added.

## [0.4.8] — 2026-07-14


### Removed
- **`asButton` option on scenarios (BREAKING)** — a HomeKit
  `StatelessProgrammableSwitch` is emit-only in HomeKit: it cannot receive
  taps from the Home app, so `asButton: true` silently disabled scenario
  activation. Scenarios are always exposed as an auto-reset Switch now.
  Existing installs that had `asButton: true` should remove the key from
  their `config.json`; any leftover SPS service is cleaned up automatically
  at next startup.

### Fixed
- **Thermostat DIM 14 mode byte parsed.** Setpoint packets
  `*#4*<zone>*14*<temp>*<mode>##` now use the second field (`*1` = Heat,
  `*2` = Cool) to keep HomeKit's `TargetHeatingCoolingState` in sync with
  gateway-side mode changes. Previously the mode byte was discarded, causing
  a silent HEAT/COOL desync when the setpoint was updated externally.
- **AUTO mode confirmation packet no longer logs as error.**
  `*4*3100*<zone>##` (weekly-program confirmation) was falling into the
  "not decoded" `log.error` branch, polluting logs on every AUTO switch. It
  now decodes as "AUTO Weekly Program" at debug level.
- **Auto-discovered accessories no longer leak as ghosts.** When
  `discoverDevices()` ran with `autoDiscover: true`, auto-discovered entries
  were preserved from the `stale` unregister step but then dropped from the
  in-memory `cachedAccessories` list, leaving them registered in Homebridge
  but invisible to the plugin. The keeper rule is now consistent between the
  stale filter and the cache rebuild.
- **Monitor buffer regex anchored.** The packet-splitting regex in
  `OwnConnection.onData` now anchors to the start of the buffer (`^…$`),
  guaranteeing O(n) parsing under all conditions.
- **Monitor keep-alive probe timeout no longer silent.** `checkMonitor()`
  now emits a debug log when the probe fails to receive a reply, making
  gateway saturation visible in the logs.

### Changed
- **`BLIND_QUEUE_BUSY_THRESHOLD` → `COMMAND_QUEUE_BUSY_THRESHOLD`** in
  `lib/utils.ts` (old name kept as a deprecated alias). The threshold applies
  to every accessory's `sendOrThrow`, not just blinds — the new name reflects
  that scope.
- **`OwnPlatform` now `implements OwnPlatformLike` explicitly** and the
  `as unknown as OwnPlatformLike` cast in `createHandler` was removed. Any
  future divergence between the platform and the interface is now a compile-
  time error.
- **Default-name derivation centralized** in the `OwnAccessory` base class.
  Sub-classes pass their type label (`'light'`, `'blind'`, …) to `super()`
  instead of mutating `config.name` themselves — one source of truth.
- **`Restoring cached accessory` logs downgraded from info to debug** to
  reduce startup noise on large installations.

### Tooling
- **ESLint now runs `@typescript-eslint`.** Previously the config used only
  `@eslint/js`, so all `// eslint-disable-next-line @typescript-eslint/...`
  hints in the source were dead code. Run `npm run lint` to check.
- **`scan.ts --max-addr` now validates its argument** and falls back to the
  default (20) with a warning if a non-integer is passed.

### Fixed (second pass)
- **Dimmer light: brightness slider now syncs the `On` state.** Setting
  `Brightness > 0` from HomeKit on a lamp that was `On=false` now correctly
  updates `this.value = true` and pushes `On=true` to HomeKit — previously
  the lamp turned on physically but the tile stayed showing "off".
- **Monitor keep-alive: prevent parallel probes.** A `checkInFlight` guard
  now short-circuits `checkMonitor()` if a previous `*#13**15##` probe is
  still in flight. Under a slow gateway the previous behaviour could stack
  two or three concurrent probes on the command queue and trigger a
  premature reconnect while the gateway was actually responding.
- **TCP half-close detection.** `OwnConnection` now listens for the socket
  `end` event and tears down the connection immediately. Previously a
  gateway that sent FIN without RST left the socket in read-only mode until
  the 30-second monitor watchdog kicked in.

### Fixed (blind synchronization)
- **Manual command after HomeKit STOP no longer silently discarded.** The
  F454 post-STOP grace window (150 ms during which a spurious direction
  packet is filtered) was previously armed after **every** STOP, including
  echoes of HomeKit-issued STOPs. As a result, a user who pressed the wall
  switch UP/DOWN within 150 ms of a HomeKit STOP saw the blind move but
  HomeKit stayed showing STOPPED. The grace window is now armed only for
  physical STOPs (i.e. not the echo of a HomeKit command), which is the
  only situation where the F454 quirk actually happens.
- **TargetPosition now tracks live position during manual movements.**
  Previously, while the blind moved physically (wall switch), HomeKit
  displayed a stale `TargetPosition` inherited from the last HomeKit
  command, so users saw `TargetPosition ≠ CurrentPosition` for the entire
  manual movement. Each position tick during a manual movement now updates
  `TargetPosition` to the live position so the Home app stays consistent.
- **Rapid direction reversal (UP→DOWN without intervening STOP) tracked
  immediately.** Previously, the position-tracking timer from the first
  direction remained armed, delaying the tracking of the new direction by
  up to one tick period. The reversal now cancels the stale timeout so the
  new direction starts tracking on the very next tick.
- **Silent end-stop safety net.** Some gateways do not emit `*2*0*` when
  the blind reaches its natural end-of-travel — HomeKit's `PositionState`
  would otherwise stay INCREASING/DECREASING forever. After 3 seconds at
  position 0 or 100 without a gateway STOP, the plugin now forces the
  state back to STOPPED and syncs `TargetPosition` to the current position.

### Fixed (third pass — code review)
- **Monitor keep-alive deadlock fixed.** If the command queue was full when a
  `*#13**15##` probe was sent, `sendCommand` dropped it and never invoked the
  `done` callback, so the `checkInFlight` guard stayed stuck `true` and every
  future probe was skipped — the reconnect watchdog silently stopped forever.
  `checkInFlight` is now reset when the probe is not queued.
- **TCP half-close (FIN) now actually reconnects.** The `end` handler routed
  through `destroyConn()`, which removed the socket's `close` listener before
  `destroy()` fired — so `OwnConnection` never emitted `close` and `OwnMonitor`
  was never notified. The FIN handler now emits `close` after teardown.
- **No more spurious reconnects on a slow gateway.** A keep-alive tick skipped
  because the previous probe is still in flight no longer counts toward the
  3-strike dead-connection threshold.
- **Blind: status-query responses no longer clobber the HomeKit target.** The
  manual-movement `TargetPosition` sync now honours `!inStatusQuery` (matching
  the STOPPED branch) and is throttled to 10% boundaries to avoid flooding HAP.
- **Blind: physical STOP during an in-flight HomeKit STOP disambiguated.** The
  F454 grace window is now gated on a dedicated `homeKitStopPending` flag rather
  than `commandSent && expectedState`, so a wall-switch STOP that coincides with
  a HomeKit STOP still arms the grace window and filters the spurious packet.
- **Blind: end-stop safety timeout derived from travel time** (bounded 1.5–5 s)
  instead of a fixed 3 s, and it now also pushes `CurrentPosition` when it fires.
- **Thermostat: DIM 14 mode byte no longer overrides an explicit choice.** A
  passive setpoint broadcast in Heat/Cool mode is only adopted when HomeKit has
  no explicit HEAT/COOL selection (OFF/AUTO); authoritative mode changes still
  arrive via DIM 19 and the central-unit operation-mode packets.
- **`scan.ts --max-addr` validates the range.** Out-of-range values (0 or > 999)
  now warn and fall back to the default, not only non-numeric input.
- **Accessory default name preserves an explicit empty string** (`== null`
  check instead of a falsy one).

## [0.4.4] — Unreleased

### Fixed
- **Blind direction mapping restored to the 0.1.7 convention** (verified on
  Legrand / BTicino installations: `*2*1*` = UP/opening, `*2*2*` = DOWN/closing,
  `*2*0*` = STOP). An attempt during 0.4.x to invert the mapping based on a
  misinterpretation broke calibration (it OPENED every blind on Homebridge
  startup instead of closing them). The mapping now matches 0.1.7 exactly:
    - `onData` direction `'1'` → `INCREASING`, direction `'2'` → `DECREASING`
    - `moveUp()` sends `*2*1*<id>##`
    - `moveDown()` sends `*2*2*<id>##`
    - Calibration init sends `*2*2*<id>##` (closes the blind to establish
      position 0)
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
