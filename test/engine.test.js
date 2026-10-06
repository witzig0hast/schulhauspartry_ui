import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import * as rq from '../src/requests.js';
import { applyPatch } from '../src/settings.js';
import { ampToFader } from '../src/adapters/x32.js';

let ctx, engine;
test.before(async () => { ctx = await startTestApp(); engine = ctx.engines.live; });
test.after(async () => { await ctx.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ticks(ms) { const end = Date.now() + ms; while (Date.now() < end) { await engine.tick(); await sleep(20); } }
const wish = async (q, device = 'dev-x') => {
  const [t] = await engine.spotify.search(q);
  const out = rq.submitWish('live', t, device + Math.random());
  rq.decide('live', out.request.id, { action: 'approve' }, engine.current);
  return out.request.id;
};

test('Auto-Zuweisung haelt beide Player ausgeglichen', async () => {
  const ids = [];
  for (const q of ['levitating', 'shape of', 'uptown', 'dance monkey']) ids.push(await wish(q));
  const up = rq.upcoming('live');
  const c = { 1: 0, 2: 0 };
  up.forEach((u) => c[u.player]++);
  assert.equal(c[1], 2); assert.equal(c[2], 2);
  assert.notEqual(up[0].player, up[1].player);
});

test('Priorisieren schiebt einen Song in die naechsten 3', async () => {
  const last = rq.upcoming('live').at(-1);
  const out = rq.prioritize('live', last.id, null, engine.current);
  assert.equal(out.ok, true);
  const up = rq.upcoming('live');
  assert.equal(up.findIndex((u) => u.id === last.id), 2);
  assert.ok(up.find((u) => u.id === last.id).prioritizedAt);
});

test('Start per Fade-In, danach Auto-Crossfade am Songende', async () => {
  await engine.startCrossfade(0.2);
  await ticks(400);
  const first = engine.current;
  assert.ok(first);
  assert.equal(engine.gain[first], 1);
  applyPatch({ auto: { enabled: true, crossfadeSec: 0.5, startBeforeEndSec: { 1: 20, 2: 20 } } }, { allow: ['auto'] });
  const st = engine.players[first].status();
  engine.players[first].seekTo(st.durationMs - 19000);
  await ticks(1200);
  assert.notEqual(engine.current, first, 'Crossfade soll zum anderen Player gewechselt haben');
  assert.equal(engine.players[first].status().playing, false);
  assert.equal(engine.players[engine.current].status().playing, true);
  assert.equal(engine.crossfade, null);
  applyPatch({ auto: { enabled: false } }, { allow: ['auto'] });
});

test('Ducking senkt die Player bei offenem Mic und gibt sie wieder frei', async () => {
  applyPatch({ ducking: { enabled: true, db: -12, attackMs: 100, releaseMs: 100 } }, { allow: ['ducking'] });
  engine.x32.simulateMic(0, true);
  await ticks(800);
  assert.ok(engine.duckMul < 0.3, `duckMul=${engine.duckMul}`);
  engine.x32.simulateMic(0, false);
  await ticks(900);
  assert.ok(engine.duckMul > 0.99);
  applyPatch({ ducking: { enabled: false } }, { allow: ['ducking'] });
});

test('Not-Aus pausiert beide Player; Ende-Modus schliesst Wuensche', async () => {
  const n = engine.panicArm();
  await engine.panicFire(n);
  assert.equal(engine.players[1].status().playing || engine.players[2].status().playing, false);
  await ticks(150);
  assert.equal(engine.lastSent[1], 0);
  engine.panicClear();
  engine.endEvening(1);
  assert.equal(engine.wishMode, 'closed');
  assert.equal(engine.state.ended, true);
  engine.endClear();
});

test('Fader-Mapping entspricht der X32-Kennlinie', () => {
  assert.ok(Math.abs(ampToFader(1) - 0.75) < 0.001);
  assert.equal(ampToFader(0), 0);
  assert.ok(Math.abs(ampToFader(Math.pow(10, -10 / 20)) - 0.5) < 0.001);
});
