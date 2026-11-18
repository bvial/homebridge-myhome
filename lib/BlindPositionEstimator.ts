export type BlindDirection = 'opening' | 'closing' | 'stopped';

export interface BlindTiming {
    timeUp: number;
    timeDown: number;
    timeSlat: number;
    slatPercent: number;
}

const clamp = (position: number) => Math.max(0, Math.min(100, position));

/** Continuous, piecewise travel-time estimate; independent of timer frequency. */
export class BlindPositionEstimator {
    direction: BlindDirection = 'stopped';
    private anchorTime = 0;
    private anchorPosition: number;

    constructor(private readonly timing: BlindTiming, position: number) {
        this.anchorPosition = clamp(position);
    }

    fullTravel(direction: Exclude<BlindDirection, 'stopped'>): number {
        return (this.linearTime(direction) + this.timing.timeSlat) * 1000;
    }

    private linearTime(direction: BlindDirection): number {
        return direction === 'closing' ? this.timing.timeDown : this.timing.timeUp;
    }

    private coordinate(position: number, direction: BlindDirection): number {
        const { slatPercent, timeSlat } = this.timing;
        if (slatPercent > 0 && position < slatPercent) return position / slatPercent * timeSlat * 1000;
        return (timeSlat + (position - slatPercent) / (100 - slatPercent) * this.linearTime(direction)) * 1000;
    }

    private fromCoordinate(value: number, direction: BlindDirection): number {
        const { slatPercent, timeSlat } = this.timing;
        if (slatPercent > 0 && value < timeSlat * 1000) return clamp(value / (timeSlat * 1000) * slatPercent);
        return clamp(slatPercent + (value / 1000 - timeSlat) / this.linearTime(direction) * (100 - slatPercent));
    }

    position(now: number): number {
        if (this.direction === 'stopped') return this.anchorPosition;
        const elapsed = Math.max(0, now - this.anchorTime);
        return this.fromCoordinate(this.coordinate(this.anchorPosition, this.direction)
            + (this.direction === 'opening' ? elapsed : -elapsed), this.direction);
    }

    start(direction: Exclude<BlindDirection, 'stopped'>, now: number): void {
        if (this.direction === direction) return;
        this.anchorPosition = this.position(now);
        this.anchorTime = now;
        this.direction = direction;
    }

    stop(now: number): void {
        this.anchorPosition = this.position(now);
        this.direction = 'stopped';
    }

    reference(position: number, now: number): void {
        this.stop(now);
        this.anchorPosition = clamp(position);
    }

    remaining(target: number, now: number): number {
        if (this.direction === 'stopped') return Infinity;
        const difference = this.coordinate(target, this.direction) - this.coordinate(this.position(now), this.direction);
        return Math.max(0, difference * (this.direction === 'opening' ? 1 : -1));
    }
}
