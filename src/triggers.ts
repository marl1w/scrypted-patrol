// Pure trigger rules (no Scrypted runtime): what makes a member camera "have an event", and how extra sensors
// are named on the patrol.

export interface TriggerConfig {
    /** the camera's own MotionSensor */
    motion: boolean;
    /** the camera's own OccupancySensor */
    occupancy: boolean;
    /** ObjectDetector classes that count (case-insensitive); empty = detections are not used */
    classes: string[];
    /** how long one matching detection keeps the trigger on (detections are events, not a state) */
    detectionHoldMs: number;
}

/** The trigger state of one member camera: any configured input on. */
export class CameraTrigger {
    motion = false;
    occupied = false;
    private detectionUntil = 0;
    /** extra sensors assigned to this camera, by device id */
    readonly sensors = new Map<string, boolean>();

    constructor(private cfg: TriggerConfig) { }

    configure(cfg: TriggerConfig) {
        this.cfg = cfg;
    }

    /** an ObjectDetector event: true when it matched a configured class */
    detection(classNames: string[], now: number) {
        const wanted = this.cfg.classes.map(c => c.toLowerCase());
        if (!wanted.length || !classNames.some(c => wanted.includes(String(c).toLowerCase()))) return false;
        this.detectionUntil = now + this.cfg.detectionHoldMs;
        return true;
    }

    /** when a detection hold ends (0 = none running) */
    detectionEndsAt() {
        return this.detectionUntil;
    }

    on(now: number) {
        return (this.cfg.motion && this.motion)
            || (this.cfg.occupancy && this.occupied)
            || this.detectionUntil > now
            || [...this.sensors.values()].some(v => v);
    }
}

export function parseClasses(s: string | undefined): string[] {
    return [...new Set(String(s ?? '').split(/[,\s]+/).map(c => c.trim()).filter(Boolean))];
}

/**
 * What an extra sensor stands for on the patrol: its name without the camera's name in front
 * ("Garden Vehicle Presence" on camera "Garden" -> "Vehicle Presence"), else its whole name.
 * The patrol publishes one child sensor per such label, named "<patrol> <label>", on while the camera
 * on screen for an event has a sensor with that label on.
 */
export function sensorLabel(cameraName: string, sensorName: string) {
    const c = cameraName.trim(), s = sensorName.trim();
    if (c && s.toLowerCase().startsWith(c.toLowerCase() + ' ') && s.length > c.length + 1) return s.slice(c.length + 1).trim();
    return s;
}

export const labelKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sensor';
