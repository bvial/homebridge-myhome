/**
 * Format an unknown caught value as a string for logging.
 * Safe under TypeScript strict mode where catch variables are `unknown`.
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

// ---------------------------------------------------------------------------
// OWN dimmer level conversion (protocol levels 2..10 ↔ HomeKit brightness 1..100)
// ---------------------------------------------------------------------------

const OWN_DIMMER_MIN = 2;
const OWN_DIMMER_MAX = 10;
const OWN_DIMMER_RANGE = OWN_DIMMER_MAX - OWN_DIMMER_MIN; // 8

/** HomeKit brightness % → OWN dimmer level (clamped to [2, 10]). */
export function brightnessToOwnLevel(percent: number): number {
    return Math.min(OWN_DIMMER_MAX, Math.max(OWN_DIMMER_MIN, Math.round(percent / 100 * OWN_DIMMER_RANGE) + OWN_DIMMER_MIN));
}

/** OWN dimmer level (≥ 2) → HomeKit brightness % (1..100). */
export function ownLevelToBrightness(level: number): number {
    return Math.max(1, Math.round((level - OWN_DIMMER_MIN) / OWN_DIMMER_RANGE * 100));
}

// ---------------------------------------------------------------------------
// Timing constants (centralized to avoid magic numbers in hot paths)
// ---------------------------------------------------------------------------

/** Brightness blink for Light.identify */
export const IDENTIFY_BLINK_MS = 500;
/** Blind jog duration for identify (UP for Nms then STOP) */
export const IDENTIFY_JOG_MS = 1000;
/** Scenario auto-reset window (Switch fallback) */
export const SCENARIO_RESET_MS = 500;
/** Door auto-reset window (LockMechanism — momentary relay) */
export const DOOR_RESET_MS = 3000;
/** Blind move() retry interval when a command is still pending */
export const BLIND_MOVE_RETRY_INTERVAL_MS = 500;
/** Max move() retries before giving up */
export const BLIND_MAX_MOVE_RETRIES = 30;
/** Confirmation timer after a blind command is dispatched */
export const BLIND_COMMAND_ECHO_TIMEOUT_MS = 1000;
/** Margin added to (time + timeSlat) for the init calibration timer */
export const BLIND_INIT_CALIBRATION_MARGIN_MS = 1000;
/** Grace window after a STOP packet during which a spurious direction packet
 *  (some BTicino gateways like F454 emit a stray direction byte immediately after
 *  a wall-switch STOP) is suppressed when it would otherwise be mis-interpreted
 *  as a new movement. */
export const BLIND_POST_STOP_GRACE_MS = 150;
/** Minimum interval between blind position ticks (slat zone floor) */
export const BLIND_MIN_TICK_MS = 50;
/** OwnClient command-queue busy threshold — accessories should throw RESOURCE_BUSY
 *  rather than enqueue new commands when the queue is at or above this depth.
 *  Used by every accessory's `sendOrThrow()`, not just blinds. */
export const COMMAND_QUEUE_BUSY_THRESHOLD = 50;
/** @deprecated Use COMMAND_QUEUE_BUSY_THRESHOLD. Kept for external consumers. */
export const BLIND_QUEUE_BUSY_THRESHOLD = COMMAND_QUEUE_BUSY_THRESHOLD;
/** Hard cap on the OwnClient command queue (sendCommand returns false above this) */
export const COMMAND_QUEUE_CAPACITY = 50;
/** Per-command TCP connection timeout (gateway must ACK within this window) */
export const COMMAND_TIMEOUT_MS = 10_000;
/** Energy meter polling interval */
export const ENERGY_POLL_INTERVAL_MS = 30_000;
/** Energy meter polling skip threshold (queue depth) */
export const ENERGY_POLL_QUEUE_THRESHOLD = 10;
/** Watt threshold above which an energy meter outlet is considered "in use" */
export const ENERGY_OUTLET_IN_USE_THRESHOLD_W = 1;
/** HAP LightSensor minimum lux value (legacy energy lux-hack floor) */
export const ENERGY_MIN_LIGHT_LEVEL = 0.0001;
/** Stagger delay between consecutive accessory status fetches at startup */
export const STATUS_UPDATE_STAGGER_MS = 200;

/**
 * Verify that a value is a valid accessory config object (positive integer id, optional string name).
 * Used to validate accessory.context.device after JSON round-trip.
 */
export function isValidConfig(c: unknown): c is { id: number; name?: string } {
    if (typeof c !== 'object' || c === null) return false;
    const obj = c as Record<string, unknown>;
    if (typeof obj.id !== 'number' || !Number.isInteger(obj.id) || obj.id <= 0) return false;
    if (obj.name !== undefined && typeof obj.name !== 'string') return false;
    return true;
}
