// The patrol's brain, with no Scrypted runtime: which member camera is on screen, and why.
// Time is passed in (monotonic ms), so every rule is unit tested without timers.

export interface DirectorConfig {
    /** member camera ids, in rotation order */
    members: string[];
    /** time on each camera while nothing happens; 0 = no rotation (stay on the last camera shown) */
    rotateMs: number;
    /** time an event camera keeps the screen before a newer event elsewhere may take it over */
    minEventMs: number;
    /** longest time one event keeps the screen; after it the camera must go quiet and trigger again */
    maxEventMs: number;
    /** time the screen stays on an event camera after its trigger ends, before rotation resumes */
    holdMs: number;
    /** time a camera whose stream failed is left out of the rotation and of events */
    unavailableMs: number;
    /**
     * A trigger that comes back within this time after going off continues the same event: its start (and so the
     * maximum event time) and an exhausted state carry over. Sensors that drop and re-raise during one activity
     * would otherwise restart the event, and hold the screen past the maximum.
     */
    rearmMs: number;
}

export type Reason = 'rotation' | 'event' | 'hold' | 'idle';

export interface View {
    /** camera to show, undefined when there is none (no members, all unavailable) */
    camera?: string;
    reason: Reason;
}

interface Trigger {
    on: boolean;
    /** when it last went on */
    since: number;
    /** held on for longer than maxEventMs: ignored until it goes off (for rearmMs) and on again */
    exhausted: boolean;
    /** when it last went off, 0 = never */
    offAt: number;
}

export class Director {
    private triggers = new Map<string, Trigger>();
    private unavailableUntil = new Map<string, number>();
    private focus?: string;
    private focusAt = 0;
    /** when the focused camera's trigger went off (hold), 0 while it is on */
    private offAt = 0;
    private shown?: string;
    private shownAt = 0;

    constructor(private cfg: DirectorConfig) { }

    configure(cfg: DirectorConfig) {
        this.cfg = cfg;
        for (const id of [...this.triggers.keys()]) if (!cfg.members.includes(id)) this.triggers.delete(id);
        if (this.focus && !cfg.members.includes(this.focus)) this.focus = undefined;
        if (this.shown && !cfg.members.includes(this.shown)) this.shown = undefined;
    }

    /** the combined trigger of one member (any of its configured sensors) */
    setTrigger(camera: string, on: boolean, now: number) {
        if (!this.cfg.members.includes(camera)) return;
        const t = this.triggers.get(camera);
        if (!t) {
            this.triggers.set(camera, { on, since: now, exhausted: false, offAt: 0 });
            return;
        }
        if (t.on === on) return;
        t.on = on;
        if (!on) t.offAt = now;
        else if (!t.offAt || now - t.offAt >= this.cfg.rearmMs) {
            t.since = now;
            t.exhausted = false;
        }
    }

    /**
     * The camera actually appeared on screen (its first frame): its rotation slot starts now, not when the switch
     * was decided, so a countdown matches the picture.
     */
    confirmShown(camera: string | undefined, now: number) {
        if (camera && camera === this.shown) this.shownAt = now;
    }

    /** how long the camera's current event has been going (re-raises within rearmMs included), 0 when off */
    eventAge(camera: string, now: number) {
        const t = this.triggers.get(camera);
        return t?.on ? now - t.since : 0;
    }

    /** a stream that failed: skipped for unavailableMs */
    setUnavailable(camera: string, now: number) {
        this.unavailableUntil.set(camera, now + this.cfg.unavailableMs);
    }

    isTriggered(camera: string) {
        return !!this.triggers.get(camera)?.on;
    }

    private available(camera: string, now: number) {
        return (this.unavailableUntil.get(camera) ?? 0) <= now;
    }

    /** on, not exhausted, stream not failed */
    private live(camera: string, now: number) {
        const t = this.triggers.get(camera);
        return !!t?.on && !t.exhausted && this.available(camera, now);
    }

    /** the newest live event other than `except`, optionally only one that started after `after` */
    private newestEvent(now: number, except?: string, after = -Infinity) {
        let best: string | undefined;
        let bestAt = -Infinity;
        for (const id of this.cfg.members) {
            if (id === except || !this.live(id, now)) continue;
            const at = this.triggers.get(id)!.since;
            if (at > after && at > bestAt) {
                best = id;
                bestAt = at;
            }
        }
        return best;
    }

    private setFocus(camera: string | undefined, now: number) {
        this.focus = camera;
        this.focusAt = now;
        this.offAt = 0;
    }

    private show(camera: string | undefined, now: number) {
        if (camera !== this.shown) {
            this.shown = camera;
            this.shownAt = now;
        }
    }

    tick(now: number): View {
        // retire an event that has held the screen too long
        if (this.focus) {
            const t = this.triggers.get(this.focus);
            if (t?.on && !t.exhausted && now - t.since >= this.cfg.maxEventMs) t.exhausted = true;
        }

        if (this.focus) {
            if (!this.available(this.focus, now)) {
                this.setFocus(undefined, now);
            }
            else if (this.live(this.focus, now)) {
                this.offAt = 0;
                // a newer event elsewhere takes over once this one had its minimum time
                if (now - this.focusAt >= this.cfg.minEventMs) {
                    const next = this.newestEvent(now, this.focus, this.triggers.get(this.focus)!.since);
                    if (next) this.setFocus(next, now);
                }
            }
            else {
                // the event ended (or was exhausted): hold, unless another event is live
                const next = this.newestEvent(now, this.focus);
                if (next) this.setFocus(next, now);
                else {
                    if (!this.offAt) this.offAt = now;
                    if (now - this.offAt >= this.cfg.holdMs) {
                        this.setFocus(undefined, now);
                        // rotation continues from here, with a full slot for the camera just shown
                        this.shownAt = now;
                    }
                }
            }
        }
        if (!this.focus) {
            const next = this.newestEvent(now);
            if (next) this.setFocus(next, now);
        }

        if (this.focus) {
            this.show(this.focus, now);
            return { camera: this.focus, reason: this.offAt ? 'hold' : 'event' };
        }

        const members = this.cfg.members.filter(id => this.available(id, now));
        if (!members.length) {
            this.show(undefined, now);
            return { camera: undefined, reason: 'idle' };
        }
        if (!this.shown || !members.includes(this.shown)) {
            // the first available member after the one that was shown (or the first)
            const from = this.shown ? this.cfg.members.indexOf(this.shown) : -1;
            this.show(nextAfter(this.cfg.members, members, from), now);
        }
        else if (this.cfg.rotateMs > 0 && members.length > 1 && now - this.shownAt >= this.cfg.rotateMs) {
            this.show(nextAfter(this.cfg.members, members, this.cfg.members.indexOf(this.shown)), now);
        }
        return { camera: this.shown, reason: 'rotation' };
    }

    /**
     * While rotating: the camera the rotation shows next and the time left until then (as of the last tick).
     * Undefined during an event or hold, without rotation, or with fewer than two cameras available.
     */
    upcoming(now: number): Upcoming | undefined {
        if (this.focus || this.cfg.rotateMs <= 0 || !this.shown) return;
        const members = this.cfg.members.filter(id => this.available(id, now));
        if (members.length < 2 || !members.includes(this.shown)) return;
        return {
            camera: nextAfter(this.cfg.members, members, this.cfg.members.indexOf(this.shown)),
            inMs: Math.max(0, this.cfg.rotateMs - (now - this.shownAt)),
        };
    }
}

export interface Upcoming {
    camera: string;
    inMs: number;
}

/** the next id of `available` after position `from` in `order`, wrapping around */
function nextAfter(order: string[], available: string[], from: number) {
    for (let i = 1; i <= order.length; i++) {
        const id = order[(from + i + order.length) % order.length];
        if (available.includes(id)) return id;
    }
    return available[0];
}
