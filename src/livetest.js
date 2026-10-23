import { settings, applyPatch } from './settings.js';
import { getSetting, setSetting, logEvent } from './db.js';
import * as rq from './requests.js';
import { isOn } from './features.js';
import { sendNotify } from './notify.js';
import { backupNow } from './backup.js';
import { leadFor } from './engine.js';
import { getMeta } from './trackmeta.js';

// Live-Test: jede Funktion einmal mit dem ECHTEN Setup durchspielen (Spotify-Player, Pi/X32, Mikrofone, Handy, Beamer).
// Laeuft im Testmodus: fuer die Dauer des Tests bekommt der Testmodus die echten Verbindungen, die Live-Party bleibt unberuehrt.
// Schritt fuer Schritt: die App loest etwas aus, prueft automatisch (Spotify-Status, Pegel am Pult, Mics ...) und fragt,
// wo nur ein Mensch es beurteilen kann ("Hoerst du Player 1?"). Am Ende gibt es einen Bericht.

export const STEPS = [
  { id: 'levels', group: 'Vorbereitung', title: 'Pegel einstellen', help: 'Fader und Lautstärken im Pegel-Fenster einstellen. Testmusik hilft beim Einpegeln.' },
  { id: 'connections', group: 'Vorbereitung', title: 'Verbindungen', help: 'Spotify-Suche, beide Player mit Wiedergabegerät, Pi und X32.' },
  { id: 'player1', group: 'Wiedergabe', title: 'Player 1', help: 'Spielt einen Testsong auf Player 1 und misst den Pegel am Pult.' },
  { id: 'player2', group: 'Wiedergabe', title: 'Player 2', help: 'Spielt einen Testsong auf Player 2 und misst den Pegel am Pult.' },
  { id: 'fader', group: 'Wiedergabe', title: 'Fader am Pult', help: 'Fährt den Fader von Player 1 herunter und wieder hoch.' },
  { id: 'wish', group: 'Gäste & Team', title: 'Wunsch vom Handy', help: 'Ein Wunsch über die Gäste-Seite des Testmodus (QR-Code scannen).' },
  { id: 'approve', group: 'Gäste & Team', title: 'Annehmen in der Moderation', help: 'Den Wunsch in der Moderations-Ansicht annehmen.' },
  { id: 'beamer', group: 'Gäste & Team', title: 'Beamer', help: 'Beamer-Ansicht öffnen und prüfen, ob Song und QR-Code richtig angezeigt werden.' },
  { id: 'crossfade', group: 'Wiedergabe', title: 'Crossfade zum Wunsch', help: 'Überblendet vom Testsong zum angenommenen Wunsch.' },
  { id: 'autofade', group: 'Wiedergabe', title: 'Automatischer Übergang', help: 'Springt kurz vor Songende und prüft, ob der Auto-Crossfade von selbst startet.' },
  { id: 'mics', group: 'Technik', title: 'Mikrofone & Ducking', help: 'In jedes Mikrofon sprechen; die App muss es erkennen und (falls an) die Musik absenken.' },
  { id: 'panic', group: 'Sicherheit', title: 'Not-Aus', help: 'Löst den Not-Aus aus – die Musik muss sofort aus sein – und hebt ihn wieder auf.' },
  { id: 'emergency', group: 'Sicherheit', title: 'Notfall-Playlist', help: 'Startet die Notfall-Playlist und beendet sie wieder.' },
  { id: 'notify', group: 'Sicherheit', title: 'Alarm aufs Handy', help: 'Schickt eine Testnachricht über ntfy.' },
  { id: 'backup', group: 'Sicherheit', title: 'Backup', help: 'Legt eine Sicherung der Datenbank an.' },
];
const IDS = STEPS.map((s) => s.id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cancelled extends Error {}
class Skipped extends Error {}

export function createLiveTest({ engines, hub, setRealEnv, isBusy = () => null }) {
  let run = null, last = getSetting('livetest:last', null);

  const pub = (r) => r && {
    id: r.id, startedAt: r.startedAt, endedAt: r.endedAt || null, by: r.by, simulated: r.simulated, prefix: r.prefix, current: r.current, verdict: r.verdict || null,
    opt: r.opt, steps: r.steps.map((s) => ({ id: s.id, group: s.group, title: s.title, help: s.help, status: s.status, detail: s.detail, checks: s.checks, question: s.question, waiting: s.waiting, actions: s.actions, links: s.links })),
  };

  // Auf eine Eingabe warten: Antwort/Knopf aus der Oberflaeche, automatische Bedingung (until) oder Zeitablauf
  function waitInput(step, { question = null, waiting = null, actions = [], links, timeoutMs = 0, until = null } = {}) {
    step.question = question; step.waiting = waiting; step.actions = actions; if (links) step.links = links;
    return new Promise((resolve) => {
      let t = null, iv = null;
      const done = (v) => {
        clearTimeout(t); clearInterval(iv);
        if (run?.pending?.done === done) run.pending = null;
        step.question = null; step.waiting = null; step.actions = [];
        resolve(v);
      };
      run.pending = { stepId: step.id, done };
      if (run.cancelled) return done('cancel');
      if (timeoutMs) t = setTimeout(() => done('timeout'), timeoutMs);
      if (until) iv = setInterval(() => { try { if (until()) done('ok'); } catch { /* weiter warten */ } }, 200);
    });
  }
  // 'skip' (Knopf „Schritt überspringen“) beendet den Schritt sofort als uebersprungen
  const guard = (v) => { if (v === 'cancel' || run.cancelled) throw new Cancelled(); if (v === 'skip') throw new Skipped(); return v; };
  const check = (step, label, ok, detail = '') => { step.checks.push({ label, ok, detail }); return ok; };
  // Frage, die nur ein Mensch beantworten kann. Im simulierten Modus gibt es nichts zu hoeren -> automatisch ja.
  async function hear(step, text, { simAnswer = 'yes' } = {}) {
    if (run.simulated) { step.simHeard = true; return simAnswer; }
    return guard(await waitInput(step, { question: { text, yes: 'Ja', no: 'Nein' } }));
  }
  async function until(step, fn, ms, waiting = null) { return guard(await waitInput(step, { until: fn, timeoutMs: ms, waiting })) === 'ok'; }

  const eng = () => engines.test;
  const st = (n) => eng().players[n].status();
  const chText = (n) => { const c = settings().x32.channels[`p${n}`]; return c?.length ? `Kanal ${c.join('/')}` : 'kein Kanal'; };
  const pathOf = (p) => `/${run.prefix}${p}`;

  async function playTest(n, other = null) {
    const e = eng();
    if (!run.testTracks?.length) {   // ein paar verschiedene, laengere Songs (fuer Crossfade und Auto-Uebergang)
      const list = [];
      for (const q of ['party hits', 'dance', 'a']) {
        for (const t of await e.spotify.search(q, 8).catch(() => [])) if (t.durationMs > 90000 && !list.some((x) => x.uri === t.uri)) list.push(t);
        if (list.length >= 3) break;
      }
      run.testTracks = list.length ? list : [await e.pickTestTrack()];
    }
    const t = run.testTracks.find((x) => x.uri !== other) || run.testTracks[0];
    await e.playDirect(n, t, 1);
    return t;
  }

  // ----- die einzelnen Schritte -----
  const STEP_FN = {
    async levels(step) {
      const errs = await eng().applyAllLevels();
      if (errs.length) check(step, 'Gespeicherte Pegel gesetzt', false, errs.join(' · '));
      const v = guard(await waitInput(step, { waiting: 'Öffne das Pegel-Fenster, starte Testmusik und stell Fader und Lautstärken ein. Mit „Übernehmen“ geht es weiter.', actions: [{ id: 'open-levels', label: 'Pegel-Fenster öffnen', client: true }, { id: 'done', label: 'Pegel passen schon' }] }));
      const l = settings().levels;
      return { status: errs.length ? 'warn' : 'ok', detail: `Player 1 ${l.playerDb[1]} dB / Spotify ${l.spotifyVol[1]} % · Player 2 ${l.playerDb[2]} dB / Spotify ${l.spotifyVol[2]} %` };
    },

    async connections(step) {
      const e = eng(), s = settings();
      let bad = 0, soft = 0;
      if (e.spotify.kind === 'real') {
        try { const r = await e.spotify.search('test', 1); check(step, 'Spotify-Suche', true, `${r.length} Treffer`); } catch (err) { bad++; check(step, 'Spotify-Suche', false, err.message); }
      } else { soft++; check(step, 'Spotify-Suche', null, 'simuliert – keine Spotify-App eingerichtet'); }
      for (const n of [1, 2]) {
        const p = e.players[n];
        if (p.kind !== 'real') { soft++; check(step, `Player ${n}`, null, 'simuliert – kein Spotify-Konto verbunden'); continue; }
        try {
          const devs = await p.devices();
          const want = s.spotify.players[n].deviceId;
          const dev = want ? devs.find((d) => d.id === want) : devs.find((d) => d.is_active);
          if (!dev) { bad++; check(step, `Player ${n}`, false, want ? `Gerät „${s.spotify.players[n].deviceName || want}“ ist nicht online – Spotify auf dem Gerät öffnen` : 'Kein aktives Wiedergabegerät – Spotify auf dem Rechner öffnen oder Gerät wählen'); }
          else check(step, `Player ${n}`, true, `${s.spotify.players[n].user || 'verbunden'} · ${dev.name}`);
        } catch (err) { bad++; check(step, `Player ${n}`, false, err.message); }
      }
      if (e.x32.kind === 'http') {
        try {
          await e.x32.readState({ 1: false, 2: false });
          check(step, 'Pi / Relay', true, 'erreichbar');
          if (e.x32.desk) { if (!check(step, 'X32-Pult', !!e.x32.desk.ok, e.x32.desk.ok ? 'antwortet' : 'antwortet nicht – Netzwerk/IP des Pults prüfen')) bad++; }
        } catch (err) { bad++; check(step, 'Pi / Relay', false, err.message); }
      } else { soft++; check(step, 'Pi / X32', null, 'simuliert – kein Pi eingetragen'); }
      return { status: bad ? 'fail' : soft ? 'warn' : 'ok', detail: bad ? `${bad} Verbindung${bad > 1 ? 'en' : ''} fehlerhaft` : soft ? 'teilweise simuliert' : 'alles verbunden' };
    },

    async player(step, n) {
      const e = eng(), o = n === 1 ? 2 : 1;
      if (st(o).playing) await e.players[o].pause().catch(() => {});
      const t = await playTest(n);
      const playing = await until(step, () => st(n).playing && st(n).uri === t.uri, 10000, `Player ${n} startet „${t.title}“ …`);
      check(step, 'Spotify meldet Wiedergabe', playing, playing ? `${t.title} – ${t.artist}` : 'Spotify hat nicht gestartet (Gerät aktiv? Premium?)');
      if (!playing) return { status: 'fail', detail: 'Wiedergabe startet nicht' };
      let meterOk = null;
      if (e.x32.kind === 'http') {
        meterOk = await until(step, () => (e.x32State.meters?.[n] || 0) > 0.02, 8000, `Messe Pegel am Pult (${chText(n)}) …`);
        check(step, `Pegel am Pult (${chText(n)})`, meterOk, meterOk ? 'Signal kommt an' : 'kein Signal – Kanalzuordnung (Admin → Verbindungen) oder Verkabelung prüfen');
      }
      const ans = await hear(step, `Hörst du Player ${n} über die Anlage? (${chText(n)} am X32)`);
      check(step, 'Über die Anlage zu hören', ans === 'yes', ans === 'yes' ? '' : 'nicht zu hören');
      return { status: ans !== 'yes' ? 'fail' : meterOk === false ? 'warn' : 'ok', detail: ans !== 'yes' ? 'Ton kommt nicht an' : 'spielt und ist zu hören' };
    },

    async fader(step) {
      const e = eng();
      if (st(2).playing) await e.players[2].pause().catch(() => {});
      if (!st(1).playing) { await playTest(1); await until(step, () => st(1).playing, 8000); }
      e.fadeOut(1, 3, { pauseAfter: false });
      const down = await until(step, () => e.gain[1] < 0.02, 6000, 'Fader von Player 1 fährt herunter …');
      check(step, 'Fader fährt herunter', down);
      await sleep(800);
      await e.fadeIn(1, 3);
      const up = await until(step, () => e.gain[1] > 0.98, 6000, '… und wieder hoch');
      check(step, 'Fader fährt wieder hoch', up);
      const ans = await hear(step, `Sind die Fader von Player 1 (${chText(1)}) am X32 herunter- und wieder hochgefahren – und war die Musik dabei kurz weg?`);
      check(step, 'Am Pult gesehen und gehört', ans === 'yes');
      return { status: down && up && ans === 'yes' ? 'ok' : 'fail', detail: ans === 'yes' ? 'Pult folgt der App' : 'Pult reagiert nicht wie erwartet (Pi-URL, Token, Kanäle prüfen)' };
    },

    async wish(step) {
      const e = eng();
      e.openWishes();
      const maxId = rq.upcoming('test').concat(rq.pending('test')).reduce((m, r) => Math.max(m, r.id), 0);
      const found = () => rq.pending('test').concat(rq.upcoming('test')).find((r) => r.id > maxId && r.deviceId !== 'auto');
      const v = guard(await waitInput(step, {
        waiting: 'Scanne den QR-Code mit dem Handy (oder öffne den Link) und wünsch dir einen Song.',
        links: [{ label: 'Gäste-Seite (Testmodus)', path: pathOf('/'), qr: true }],
        actions: [{ id: 'auto', label: 'Ohne Handy – automatisch wünschen' }],
        until: () => !!found(), timeoutMs: 15 * 60000,
      }));
      if (v === 'timeout') return { status: 'fail', detail: 'Kein Wunsch angekommen' };
      if (v === 'auto') {
        const t = (run.testTracks || []).find((x) => x.uri !== st(1).uri) || await e.pickTestTrack();
        const out = rq.submitWish('test', t, 'livetest');
        if (out.result !== 'created' && out.result !== 'duplicate') throw new Error('Wunsch konnte nicht angelegt werden');
        e.afterQueueChange(); hub.pushEnv('test', { guests: true });
        run.wishId = out.request.id;
        check(step, 'Wunsch angelegt', true, `${t.title} (automatisch, ohne Handy)`);
        return { status: 'warn', detail: 'automatisch angelegt – das Handy wurde nicht getestet' };
      }
      const r = found();
      run.wishId = r.id;
      check(step, 'Wunsch vom Handy angekommen', true, `${r.title} – ${r.artist}`);
      check(step, 'Gäste-Seite live verbunden', hub.viewCount('test', 'guest') > 0 ? true : null, hub.viewCount('test', 'guest') > 0 ? `${hub.viewCount('test', 'guest')} Gast-Gerät(e)` : 'keine Live-Verbindung gesehen');
      return { status: 'ok', detail: `${r.title} – ${r.artist}` };
    },

    async approve(step) {
      const e = eng();
      if (!run.wishId) return { status: 'skipped', detail: 'kein Wunsch aus dem vorigen Schritt' };
      const isApproved = () => ['approved', 'playing', 'played'].includes(rq.getRequest(run.wishId)?.status);
      const v = guard(await waitInput(step, {
        waiting: 'Öffne die Moderation (am besten auf einem zweiten Gerät) und nimm den Wunsch an.',
        links: [{ label: 'Moderation (Testmodus)', path: pathOf('/mod') }, { label: 'Fokus-Modus', path: pathOf('/focus') }],
        actions: [{ id: 'auto', label: 'Automatisch annehmen' }],
        until: isApproved, timeoutMs: 15 * 60000,
      }));
      if (v === 'timeout') return { status: 'fail', detail: 'Wunsch wurde nicht angenommen' };
      if (v === 'auto' && !isApproved()) {
        const out = rq.decide('test', run.wishId, { action: 'approve', accountId: null }, e.current);
        if (!out.ok) throw new Error(out.error);
        e.afterQueueChange(); hub.pushEnv('test', { guests: true });
      }
      const r = rq.getRequest(run.wishId);
      check(step, 'Angenommen', true, v === 'auto' ? 'automatisch' : 'in der Moderation');
      if (!e.wishlist) check(step, 'In der Warteschlange', rq.upcoming('test').some((u) => u.id === r.id) || r.status !== 'approved', r.player ? `auf Player ${r.player}` : '');
      return { status: v === 'auto' ? 'warn' : 'ok', detail: v === 'auto' ? 'automatisch angenommen – Moderation nicht getestet' : 'in der Moderation angenommen' };
    },

    async beamer(step) {
      if (!isOn('viewBeamer')) return { status: 'skipped', detail: 'Beamer-Ansicht ist ausgeschaltet' };
      const seen = () => hub.viewCount('test', 'beamer') > 0;
      const v = guard(await waitInput(step, {
        waiting: 'Öffne die Beamer-Ansicht auf dem Beamer-Rechner.',
        links: [{ label: 'Beamer (Testmodus)', path: pathOf('/beamer') }],
        actions: [{ id: 'no-beamer', label: 'Kein Beamer heute' }],
        until: seen, timeoutMs: 15 * 60000,
      }));
      if (v === 'no-beamer') return { status: 'skipped', detail: 'kein Beamer' };
      if (v === 'timeout') return { status: 'fail', detail: 'Beamer hat sich nicht verbunden' };
      check(step, 'Beamer verbunden', true);
      const ans = guard(await waitInput(step, { question: { text: 'Zeigt der Beamer den laufenden Song, den QR-Code und die Adresse gut lesbar an?', yes: 'Ja', no: 'Nein' } }));
      check(step, 'Anzeige in Ordnung', ans === 'yes');
      return { status: ans === 'yes' ? 'ok' : 'fail', detail: ans === 'yes' ? 'Anzeige passt' : 'Anzeige prüfen (Design, Auflösung, Vollbild F11)' };
    },

    async crossfade(step) {
      const e = eng();
      if (!rq.upcoming('test').length) return { status: 'skipped', detail: 'nichts in der Warteschlange (Wunsch-Schritte übersprungen?)' };
      // der Wunsch soll als Naechstes laufen
      const up = rq.upcoming('test');
      if (run.wishId && up[0]?.id !== run.wishId && up.some((u) => u.id === run.wishId)) rq.writeOrder('test', [run.wishId, ...up.filter((u) => u.id !== run.wishId).map((u) => u.id)]);
      if (!st(1).playing && !st(2).playing) { await playTest(1); await until(step, () => st(1).playing, 8000); }
      const from = e.current || 1;
      const next = rq.upcoming('test')[0];
      const sec = Math.min(8, settings().auto.crossfadeSec || 6);
      const out = await e.startCrossfade(sec);
      const to = out.player;
      const started = await until(step, () => st(to).playing && st(to).uri === next.uri, 10000, `Überblende zu „${next.title}“ …`);
      check(step, `Player ${to} startet den Wunsch`, started, started ? next.title : 'startet nicht');
      const finished = await until(step, () => !e.crossfade && !e.pendingStart.length && e.current === to, (sec + 8) * 1000, 'Crossfade läuft …');
      check(step, 'Übergang abgeschlossen', finished);
      const stopped = await until(step, () => !st(from).playing || from === to, 6000);
      check(step, `Player ${from} danach gestoppt`, stopped);
      if (!started || !finished) return { status: 'fail', detail: 'Crossfade hat nicht sauber funktioniert' };
      const ans = await hear(step, 'War der Übergang sauber – ohne Loch und ohne Sprung in der Lautstärke?');
      check(step, 'Klingt sauber', ans === 'yes');
      return { status: ans === 'yes' && stopped ? 'ok' : 'warn', detail: ans === 'yes' ? `${sec} s, Player ${from} → ${to}` : 'Übergang klang nicht gut (Crossfade-Dauer/Kurve, Pegel angleichen)' };
    },

    async autofade(step) {
      const e = eng(), cfg = settings();
      if (!cfg.auto.enabled) return { status: 'skipped', detail: 'Auto-Crossfade ist aus (Technik → Automatik)' };
      const cur = e.current;
      if (!cur || !st(cur).playing) return { status: 'skipped', detail: 'es läuft gerade nichts' };
      if (!rq.upcoming('test').length) {   // einen zweiten Song einreihen, damit es ein Ziel gibt
        const t = (run.testTracks || []).find((x) => x.uri !== st(cur).uri) || await e.pickTestTrack();
        rq.addAuto('test', t, cur); e.afterQueueChange();
      }
      const s0 = st(cur);
      const lead = leadFor(cfg, cur, s0.durationMs, getMeta(e.trackIdOf[cur]));
      if (!e.players[cur].seek) return { status: 'skipped', detail: 'Springen wird nicht unterstützt' };
      e.liveTest.noAuto = false;
      try {
        await e.players[cur].seek(Math.max(0, s0.durationMs - lead - 5000));
        const began = await until(step, () => !!e.crossfade || e.current !== cur, 30000, `Kurz vor Songende gesprungen – warte auf den automatischen Übergang (Vorlauf ${Math.round(lead / 1000)} s) …`);
        check(step, 'Auto-Crossfade startet von selbst', began);
        if (!began) return { status: 'fail', detail: 'Der automatische Übergang hat nicht ausgelöst' };
        const done = await until(step, () => !e.crossfade && !e.pendingStart.length && e.current !== cur, (cfg.auto.crossfadeSec + 10) * 1000, 'Übergang läuft …');
        check(step, 'Übergang abgeschlossen', done);
        const ans = await hear(step, 'Kam der automatische Übergang an einer passenden Stelle und klang sauber?');
        check(step, 'Klingt gut', ans === 'yes');
        return { status: done && ans === 'yes' ? 'ok' : 'warn', detail: done ? `Vorlauf ${Math.round(lead / 1000)} s, ${cfg.auto.crossfadeSec} s Überblendung` : 'Übergang hing' };
      } finally { e.liveTest.noAuto = true; }
    },

    async mics(step) {
      const e = eng(), cfg = settings();
      const chans = cfg.x32.channels.mics || [];
      if (!chans.length) return { status: 'skipped', detail: 'keine Mikrofon-Kanäle eingetragen' };
      const names = chans.map((c, i) => cfg.x32.micNames?.[i] || `Mic ${i + 1}`);
      const music = [1, 2].some((n) => st(n).playing);
      let ok = 0, minDuck = 1;
      for (let i = 0; i < chans.length; i++) {
        if (e.x32.kind === 'mock') { e.x32.simulateMic(i, true); setTimeout(() => e.x32.simulateMic(i, false), 1500).unref?.(); }
        const seen = guard(await waitInput(step, {
          waiting: `Sprich jetzt in „${names[i]}“ (Kanal ${chans[i]}) – z. B. „Test, eins, zwei“.`,
          actions: [{ id: 'skip-mic', label: `${names[i]} überspringen` }],
          until: () => { if (e.duckMul < minDuck) minDuck = e.duckMul; return !!e.x32State.mics?.[i]?.open; }, timeoutMs: 45000,
        }));
        const hit = seen === 'ok';
        if (hit) { ok++; const t0 = Date.now(); while (Date.now() - t0 < 1500) { if (e.duckMul < minDuck) minDuck = e.duckMul; await sleep(100); } }   // Ducking mitmessen
        check(step, `${names[i]} (Kanal ${chans[i]})`, seen === 'skip-mic' ? null : hit, hit ? 'erkannt' : seen === 'skip-mic' ? 'übersprungen' : 'nicht erkannt – stumm geschaltet oder falscher Kanal?');
      }
      let duckOk = null;
      if (cfg.ducking.enabled && ok) {
        duckOk = minDuck < 0.9;
        check(step, 'Ducking senkt die Musik ab', duckOk, duckOk ? `bis auf ${Math.round(minDuck * 100)} %` : 'keine Absenkung gemessen');
        if (music && duckOk) {
          const ans = await hear(step, 'Wurde die Musik beim Sprechen leiser und danach wieder lauter?');
          check(step, 'Ducking zu hören', ans === 'yes');
          if (ans !== 'yes') duckOk = false;
        }
      }
      return { status: ok === chans.length && duckOk !== false ? 'ok' : ok ? 'warn' : 'fail', detail: `${ok} von ${chans.length} Mikrofonen erkannt${cfg.ducking.enabled ? '' : ' · Ducking ist aus'}` };
    },

    async panic(step) {
      const e = eng();
      if (![1, 2].some((n) => st(n).playing)) { await playTest(1); await until(step, () => st(1).playing, 8000); }
      const nonce = e.panicArm();
      await e.panicFire(nonce);
      try {
        const silent = await until(step, () => ![1, 2].some((n) => st(n).playing), 5000, 'Not-Aus ausgelöst …');
        check(step, 'Beide Player gestoppt', silent);
        check(step, 'Fader auf null', await until(step, () => e.lastSent[1] === 0 && e.lastSent[2] === 0, 3000));
        const ans = await hear(step, 'War die Musik sofort aus?');
        check(step, 'Sofort still', ans === 'yes');
        return { status: silent && ans === 'yes' ? 'ok' : 'fail', detail: silent ? 'Musik sofort aus' : 'Player laufen weiter!' };
      } finally { e.panicClear(); }
    },

    async emergency(step) {
      const e = eng(), cfg = settings().emergency;
      if (!isOn('emergency')) return { status: 'skipped', detail: 'Notfall-Playlist ist ausgeschaltet' };
      if (!cfg.playlist && e.players[cfg.player].kind === 'real') return { status: 'warn', detail: 'Keine Notfall-Playlist eingetragen (Admin → Automatik)' };
      await e.emergencyStart();
      try {
        const on = await until(step, () => st(cfg.player).playing, 10000, 'Notfall-Playlist startet …');
        check(step, `Player ${cfg.player} spielt die Playlist`, on);
        const ans = on ? await hear(step, 'Hörst du die Notfall-Playlist?') : 'no';
        check(step, 'Zu hören', ans === 'yes');
        return { status: on && ans === 'yes' ? 'ok' : 'fail', detail: on ? 'startet zuverlässig' : 'startet nicht (Playlist öffentlich? Gerät aktiv?)' };
      } finally {
        e.fadeOut(cfg.player, 2);
        await sleep(2500);
        e.emergencyClear();
      }
    },

    async notify(step) {
      const n = settings().notify;
      if (!isOn('notify') || !n.enabled || !n.topic) return { status: 'warn', detail: 'Nicht eingerichtet (Admin → Automatik → Alarm aufs Handy)' };
      const out = await sendNotify({ title: 'Live-Test', message: 'Wenn du das liest, kommen Alarme der Party-App an.', priority: 3, tags: ['bell'], force: true, env: 'test' });
      check(step, 'Nachricht gesendet', !!out.sent, out.sent ? '' : out.reason);
      if (!out.sent) return { status: 'fail', detail: out.reason };
      const ans = guard(await waitInput(step, { question: { text: 'Ist die Testnachricht auf dem Handy angekommen?', yes: 'Ja', no: 'Nein' } }));
      check(step, 'Angekommen', ans === 'yes');
      return { status: ans === 'yes' ? 'ok' : 'fail', detail: ans === 'yes' ? 'Alarme kommen an' : 'ntfy-App/Topic prüfen' };
    },

    async backup(step) {
      if (!isOn('backups')) return { status: 'warn', detail: 'Backups sind ausgeschaltet' };
      try { const b = backupNow('live-test'); check(step, 'Backup gespeichert', true, b.name); return { status: 'ok', detail: b.name }; }
      catch (err) { return { status: 'warn', detail: err.message }; }
    },
  };
  STEP_FN.player1 = (s) => STEP_FN.player(s, 1);
  STEP_FN.player2 = (s) => STEP_FN.player(s, 2);
  const PLAYBACK = new Set(['player1', 'player2', 'fader', 'crossfade', 'autofade', 'panic', 'emergency', 'levels']);

  async function execute(r) {
    const e = eng();
    try {
      for (const step of r.steps) {
        if (r.cancelled) break;
        if (step.status === 'skipped') continue;
        r.current = step.id;
        for (;;) {
          step.status = 'running'; step.checks = []; step.detail = ''; step.simHeard = false; step.startedAt = Date.now();
          let out;
          try { out = await STEP_FN[step.id](step); }
          catch (err) {
            if (err instanceof Cancelled) throw err;
            out = err instanceof Skipped ? { status: 'skipped', detail: 'übersprungen' } : { status: 'fail', detail: err.message };
          }
          if (step.simHeard && out.detail && out.status !== 'skipped') out.detail += ' · simuliert, nicht angehört';
          Object.assign(step, out, { endedAt: Date.now() });
          if (step.status !== 'fail') break;
          // Fehlgeschlagen: nochmal versuchen oder weiter
          const v = await waitInput(step, { waiting: 'Dieser Schritt ist fehlgeschlagen. Problem beheben und nochmal versuchen – oder weiter zum nächsten Schritt.', actions: [{ id: 'retry', label: '↻ Nochmal' }, { id: 'next', label: 'Weiter' }] });
          if (v === 'cancel' || r.cancelled) throw new Cancelled();
          if (v !== 'retry') break;
        }
        hub.pushEnv('test');
      }
    } catch (err) { if (!(err instanceof Cancelled)) r.error = err.message; }
    // Aufraeumen: Musik aus, echte Verbindungen zurueck, auf Wunsch Testdaten loeschen
    r.current = null;
    try {
      for (const n of [1, 2]) if (st(n).playing) e.fadeOut(n, r.cancelled ? 1 : 3);
      await sleep(r.cancelled ? 1200 : 3300);
      for (const n of [1, 2]) await e.players[n].pause().catch(() => {});
    } catch { /* weiter aufraeumen */ }
    e.liveTest = null;
    if (e.state.panic) e.panicClear();
    if (r.opt.resetAfter) { rq.resetEnv('test'); e.resetAll(); }
    restoreReal(r.prevReal);
    for (const s of r.steps) if (s.status === 'pending' || s.status === 'running') s.status = r.cancelled ? 'cancelled' : 'skipped';
    r.endedAt = Date.now();
    const c = (k) => r.steps.filter((s) => s.status === k).length;
    r.counts = { ok: c('ok'), warn: c('warn'), fail: c('fail'), skipped: c('skipped') + c('cancelled') };
    r.verdict = r.cancelled ? 'abgebrochen' : r.error ? 'Fehler' : r.counts.fail ? 'Probleme gefunden' : r.counts.warn ? 'Bereit mit Hinweisen' : 'Alles bereit';
    last = { ...pub(r), counts: r.counts, error: r.error || null };
    setSetting('livetest:last', last);
    logEvent('test', 'livetest', { verdict: r.verdict, ...r.counts });
    run = null;
    hub.pushEnv('test');
  }

  function restoreReal(prev) {
    if (prev && settings().test.realEnv !== prev) { applyPatch({ test: { realEnv: prev } }, { allow: ['test'] }); setRealEnv(); }
    setSetting('livetest:restore', null);
  }

  return {
    status: () => ({ running: !!run, run: pub(run), pending: run?.pending?.stepId || null, last, steps: STEPS }),
    isRunning: () => !!run,
    start(o = {}, who = '') {
      if (run) throw new Error('Der Live-Test läuft bereits.');
      const s = settings();
      if (!s.test.enabled || !isOn('testMode')) throw new Error('Bitte zuerst den Testmodus einschalten (Start & Links → Testmodus).');
      const busy = isBusy();
      if (busy) throw new Error(busy);
      const live = engines.live;
      if (engines.test.held) throw new Error('Der Soundcheck-Modus ist im Testmodus an – erst beenden.');
      if (live.realConnections && [1, 2].some((n) => live.players[n].status().playing)) throw new Error('Auf der Live-Party läuft gerade Musik über die echten Player. Der Live-Test braucht sie für sich – erst stoppen.');
      const skip = new Set((Array.isArray(o.skip) ? o.skip : []).filter((x) => IDS.includes(x)));
      const opt = { resetBefore: o.resetBefore !== false, resetAfter: !!o.resetAfter, skip: [...skip] };
      const prevReal = s.test.realEnv;
      setSetting('livetest:restore', prevReal);   // falls der Server waehrenddessen neu startet
      if (prevReal !== 'test') { applyPatch({ test: { realEnv: 'test' } }, { allow: ['test'] }); setRealEnv(); }
      const e = eng();
      if (opt.resetBefore) { rq.resetEnv('test'); e.resetAll(); }
      e.liveTest = { noAuto: true };   // keine Start-Playlist, kein Lueckenfueller, kein Auto-Crossfade dazwischen
      if (e.state.ended) e.endClear();
      e.openWishes();
      const wl = s.operation.mode === 'wishlist';
      const simulated = e.spotify.kind !== 'real' || [1, 2].some((n) => e.players[n].kind !== 'real') || e.x32.kind !== 'http';
      run = {
        id: Date.now(), startedAt: Date.now(), by: who, opt, prevReal, prefix: s.test.prefix, simulated: wl ? false : simulated, cancelled: false, pending: null,
        steps: STEPS.map((d) => ({ ...d, status: skip.has(d.id) || (wl && PLAYBACK.has(d.id)) ? 'skipped' : 'pending', detail: skip.has(d.id) ? 'abgewählt' : wl && PLAYBACK.has(d.id) ? 'Wunschlisten-Modus: die App spielt keine Musik' : '', checks: [], question: null, waiting: null, actions: [], links: [] })),
      };
      logEvent('test', 'livetest', { start: true, by: who });
      execute(run);
      return this.status();
    },
    answer(stepId, value) {
      if (!run?.pending || run.pending.stepId !== stepId) throw new Error('Dieser Schritt wartet gerade nicht auf eine Antwort.');
      const v = String(value || '');
      if (!/^[a-z-]{2,16}$/.test(v)) throw new Error('Ungültige Antwort');
      run.pending.done(v);
      return this.status();
    },
    stop() {
      if (!run) return this.status();
      run.cancelled = true;
      run.pending?.done('cancel');
      return this.status();
    },
    // Nach einem Neustart mitten im Test: echte Verbindungen wieder dorthin, wo sie vorher waren
    recover() { const prev = getSetting('livetest:restore', null); if (prev) restoreReal(prev); },
  };
}
