import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Director, DirectorConfig } from '../src/director';

const cfg = (o: Partial<DirectorConfig> = {}): DirectorConfig => ({
    members: ['a', 'b', 'c'], rotateMs: 10000, minEventMs: 8000, maxEventMs: 120000, holdMs: 5000, unavailableMs: 60000, rearmMs: 0, ...o,
});

test('rotates through the members in order, wrapping around', () => {
    const d = new Director(cfg());
    assert.equal(d.tick(0).camera, 'a');
    assert.equal(d.tick(9999).camera, 'a');
    assert.equal(d.tick(10000).camera, 'b');
    assert.equal(d.tick(20000).camera, 'c');
    assert.equal(d.tick(30000).camera, 'a');
    assert.equal(d.tick(30000).reason, 'rotation');
});

test('no rotation when the interval is 0', () => {
    const d = new Director(cfg({ rotateMs: 0 }));
    assert.equal(d.tick(0).camera, 'a');
    assert.equal(d.tick(1e6).camera, 'a');
});

test('an event cuts to its camera at once, holds after it ends, then rotation resumes from there', () => {
    const d = new Director(cfg());
    d.tick(0);
    d.setTrigger('c', true, 1000);
    assert.deepEqual(d.tick(1000), { camera: 'c', reason: 'event' });
    assert.deepEqual(d.tick(50000), { camera: 'c', reason: 'event' });
    d.setTrigger('c', false, 50000);
    assert.deepEqual(d.tick(50000), { camera: 'c', reason: 'hold' });
    assert.deepEqual(d.tick(54999), { camera: 'c', reason: 'hold' });
    // hold over: c gets a full rotation slot, then a
    assert.deepEqual(d.tick(55000), { camera: 'c', reason: 'rotation' });
    assert.equal(d.tick(64999).camera, 'c');
    assert.equal(d.tick(65000).camera, 'a');
});

test('a newer event takes over only after the minimum event time', () => {
    const d = new Director(cfg());
    d.setTrigger('a', true, 0);
    assert.equal(d.tick(0).camera, 'a');
    d.setTrigger('b', true, 2000);
    assert.equal(d.tick(2000).camera, 'a');
    assert.equal(d.tick(7999).camera, 'a');
    assert.equal(d.tick(8000).camera, 'b');
    // a, older, does not take it back while b goes on
    assert.equal(d.tick(30000).camera, 'b');
});

test('when the event ends, another live event gets the screen without a hold', () => {
    const d = new Director(cfg());
    d.setTrigger('a', true, 0);
    d.tick(0);
    d.setTrigger('b', true, 1000);
    d.tick(1000);
    d.setTrigger('a', false, 3000);
    assert.deepEqual(d.tick(3000), { camera: 'b', reason: 'event' });
});

test('an event held past the maximum lets go and does not come back until it triggers again', () => {
    const d = new Director(cfg({ maxEventMs: 60000 }));
    d.setTrigger('b', true, 0);
    assert.equal(d.tick(0).reason, 'event');
    assert.equal(d.tick(59999).reason, 'event');
    assert.deepEqual(d.tick(60000), { camera: 'b', reason: 'hold' });
    assert.equal(d.tick(65000).reason, 'rotation');
    assert.equal(d.tick(80000).reason, 'rotation');
    d.setTrigger('b', false, 90000);
    d.setTrigger('b', true, 91000);
    assert.deepEqual(d.tick(91000), { camera: 'b', reason: 'event' });
});

test('an unavailable camera is skipped by rotation and events', () => {
    const d = new Director(cfg());
    assert.equal(d.tick(0).camera, 'a');
    d.setUnavailable('a', 1000);
    assert.equal(d.tick(1000).camera, 'b');
    d.setUnavailable('c', 1000);
    d.setTrigger('c', true, 2000);
    assert.equal(d.tick(2000).camera, 'b');
    // back after unavailableMs, and its event is still on
    assert.deepEqual(d.tick(61000), { camera: 'c', reason: 'event' });
});

test('nothing to show when every member is unavailable or there are none', () => {
    const d = new Director(cfg({ members: ['a'] }));
    d.setUnavailable('a', 0);
    assert.deepEqual(d.tick(0), { camera: undefined, reason: 'idle' });
    assert.deepEqual(new Director(cfg({ members: [] })).tick(0), { camera: undefined, reason: 'idle' });
});

test('a trigger already on when first seen counts as an event', () => {
    const d = new Director(cfg());
    d.setTrigger('b', true, 0);
    assert.deepEqual(d.tick(0), { camera: 'b', reason: 'event' });
});

test('removing the camera on screen moves on', () => {
    const d = new Director(cfg());
    d.setTrigger('b', true, 0);
    d.tick(0);
    d.configure(cfg({ members: ['a', 'c'] }));
    assert.equal(d.tick(1).camera, 'a');
});

test('upcoming: the next camera and the time left, only while rotating', () => {
    const d = new Director(cfg());
    d.tick(0);
    assert.deepEqual(d.upcoming(3000), { camera: 'b', inMs: 7000 });
    d.tick(10000);
    assert.deepEqual(d.upcoming(10000), { camera: 'c', inMs: 10000 });
    d.setUnavailable('c', 10000);
    assert.deepEqual(d.upcoming(12000), { camera: 'a', inMs: 8000 });
    d.setTrigger('a', true, 13000);
    d.tick(13000);
    assert.equal(d.upcoming(13000), undefined, 'event on screen');
    assert.equal(new Director(cfg({ rotateMs: 0 })).upcoming(0), undefined);
    const one = new Director(cfg({ members: ['a'] }));
    one.tick(0);
    assert.equal(one.upcoming(0), undefined);
});

test('a trigger that re-raises within the re-arm time continues its event, and cannot dodge the maximum', () => {
    const d = new Director(cfg({ maxEventMs: 60000, rearmMs: 30000 }));
    d.setTrigger('b', true, 0);
    assert.equal(d.tick(0).reason, 'event');
    // drops for 2 s at 50 s: same event, still capped at 60 s from the start
    d.setTrigger('b', false, 50000);
    d.setTrigger('b', true, 52000);
    assert.equal(d.eventAge('b', 55000), 55000);
    assert.equal(d.tick(59999).reason, 'event');
    assert.equal(d.tick(60000).reason, 'hold');
    assert.equal(d.tick(65000).reason, 'rotation');
    // a quick re-raise of the exhausted event does not get the screen back
    d.setTrigger('b', false, 70000);
    d.setTrigger('b', true, 80000);
    assert.equal(d.tick(80000).reason, 'rotation');
    // quiet for the re-arm time: a new event
    d.setTrigger('b', false, 90000);
    d.setTrigger('b', true, 120000);
    assert.deepEqual(d.tick(120000), { camera: 'b', reason: 'event' });
    assert.equal(d.eventAge('b', 121000), 1000);
});

test('a rotation slot starts when the camera actually appears', () => {
    const d = new Director(cfg());
    d.tick(0);
    assert.equal(d.tick(10000).camera, 'b');
    // b's first frame arrived 3 s after the switch was decided
    d.confirmShown('b', 13000);
    assert.deepEqual(d.upcoming(13000), { camera: 'c', inMs: 10000 });
    assert.equal(d.tick(22999).camera, 'b');
    assert.equal(d.tick(23000).camera, 'c');
    // a confirmation for a camera no longer wanted changes nothing
    d.confirmShown('a', 24000);
    assert.deepEqual(d.upcoming(24000), { camera: 'a', inMs: 9000 });
});
