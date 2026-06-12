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

export const OWN_DIMMER_MIN = 2;
export const OWN_DIMMER_MAX = 10;
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
/** Scenario auto-reset window (Switch fallback) */
export const SCENARIO_RESET_MS = 500;
/** Blind move() retry interval when a command is still pending */
export const BLIND_MOVE_RETRY_INTERVAL_MS = 500;
/** Max move() retries before giving up */
export const BLIND_MAX_MOVE_RETRIES = 30;
/** Confirmation timer after a blind command is dispatched */
export const BLIND_COMMAND_ECHO_TIMEOUT_MS = 1000;
/** Grace window after command confirmation (absorbs old-format gateway STOP echoes) */
export const BLIND_ECHO_GRACE_WINDOW_MS = 300;
/** Margin added to (time + timeSlat) for the init calibration timer */
export const BLIND_INIT_CALIBRATION_MARGIN_MS = 1000;
/** TargetPosition queue-full guard threshold */
export const BLIND_QUEUE_BUSY_THRESHOLD = 50;
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
