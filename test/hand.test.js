import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { ampToFader } from '../src/adapters/x32.js';
import { settings, applyPatch } from '../src/settings.js';
import * as rq from '../src/requests.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Pult ist die Wahrheit: von Hand verstellte Fader werden Grundpegel, nichts zieht zurueck', async () => {
  const ctx = await startTestApp();
  try {
    const e = ctx.engines.live; e.start();
    const t = (await e.spotify.search('uptown', 1))[0];
    rq.addAuto('live', t, null);
    await e.play(1); await sleep(300);
    const sent = []; const orig = e.x32.setPlayerLevel.bind(e.x32);
    e.x32.setPlayerLevel = (p, a, o) => { sent.push([p, a]); return orig(p, a, o); };

    // Hand schiebt Player 1 auf -6 dB (noch festgehalten: nichts uebernehmen)
    e.adoptHand([{ ch: 1, v: ampToFader(0.5), ageMs: 200, seq: 1 }]);
    assert.equal(settings().levels.playerDb[1], 0, 'erst übernehmen, wenn losgelassen');
    e.adoptHand([{ ch: 1, v: ampToFader(0.5), ageMs: 900, seq: 1 }]);
    assert.equal(settings().levels.playerDb[1], -6, 'neuer Grundpegel');
    await sleep(300);
    assert.equal(sent.filter(([p]) => p === 1).length, 0, 'nichts zurückgezogen');
    e.adoptHand([{ ch: 1, v: ampToFader(0.25), ageMs: 900, seq: 1 }]);
    assert.equal(settings().levels.playerDb[1], -6, 'dieselbe Bewegung nur einmal');

    // Fade-out startet bei der Hand-Stellung (nicht wieder oben)
    e.fadeOut(1, 0.6); await sleep(250);
    const firstFade = sent.find(([p]) => p === 1);
    assert.ok(firstFade && firstFade[1] <= 0.5 + 1e-6, `Fade beginnt bei der Hand-Stellung (${firstFade?.[1]})`);
    await sleep(800);

    // Stummer Player (nach dem Fade-out): Handbewegung wird nicht verrechnet
    assert.equal(e.muted[1], true);
    e.adoptHand([{ ch: 1, v: ampToFader(1), ageMs: 900, seq: 2 }]);
    assert.equal(settings().levels.playerDb[1], -6);

    // Soundcheck: waehrenddessen nichts, beim Einschalten wird uebernommen statt zurueckgezogen
    e.x32.hand = [{ ch: 3, v: ampToFader(Math.pow(10, -3 / 20)), ageMs: 5000, seq: 3 }];
    e.startHold({ by: 'T' });
    e.adoptHand(e.x32.hand);
    assert.equal(settings().levels.playerDb[2], 0, 'im Soundcheck keine Übernahme');
    sent.length = 0;
    e.endHold({ by: 'Admin' });
    assert.equal(settings().levels.playerDb[2], -3, 'beim Einschalten übernommen');
    await sleep(300);
    assert.equal(sent.filter(([p]) => p === 2).length, 0, 'Player 2 wird nicht zurückgezogen');

    // Mic-Fader nur, wenn die App sie setzt
    e.adoptHand([{ ch: 5, v: ampToFader(Math.pow(10, -10 / 20)), ageMs: 900, seq: 4 }]);
    assert.equal(settings().levels.micDb[0], 0);
    applyPatch({ levels: { micControl: true } }, { allow: ['levels'] });
    e.adoptHand([{ ch: 5, v: ampToFader(Math.pow(10, -10 / 20)), ageMs: 900, seq: 5 }]);
    assert.equal(settings().levels.micDb[0], -10);

    // abschaltbar
    applyPatch({ x32: { adoptHand: false } }, { allow: ['x32'] });
    e.adoptHand([{ ch: 3, v: ampToFader(0.1), ageMs: 900, seq: 6 }]);
    assert.equal(settings().levels.playerDb[2], -3);
    const ql = (await import('../src/log.js')).queryLogs({ cats: ['pult'] }); const logs = Array.isArray(ql) ? ql : (ql.logs || []);
    assert.ok(logs.some((x) => x.event === 'fader.adopted'));
  } finally { await ctx.close(); }
});
