import WebSocket from 'ws';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { settings } from './settings.js';
import { getDb } from './db.js';
import { newSession } from './auth.js';
import { shield } from './shield.js';
import { isOn } from './features.js';
import { createPoll, closePoll } from './extras.js';
import { sha256, randomToken } from './security.js';
import * as rq from './requests.js';

// Generalprobe: simuliert eine komplette Party gegen den TESTMODUS -- viele Gaeste (Seite laden, suchen, wuenschen, abstimmen,
// Live-Verbindung), eine Moderation, die annimmt/ablehnt, und Wiedergabe mit Crossfades. Alles laeuft ueber die echten
// Schnittstellen (HTTP + WebSocket inkl. Schutzgrenzen). Die Live-Party wird nicht beruehrt.
// Gemessen werden Antwortzeiten, Fehler, Abweisungen durch Grenzen, Live-Verbindungen und die Auslastung des Servers.

const INTENSITY = {          // Aktionen pro Gast und Minute
  ruhig: { search: 0.5, wish: 0.15, vote: 0.3, state: 0.3, poll: 0.5 },
  normal: { search: 1.2, wish: 0.35, vote: 0.8, state: 0.6, poll: 0.8 },
  hoch: { search: 3, wish: 1, vote: 2, state: 1.5, poll: 1 },
  extrem: { search: 10, wish: 3, vote: 6, state: 4, poll: 1 },
};
const CATS = ['Seite', 'Datei', 'Status', 'Suche', 'Wunsch', 'Abstimmung', 'Umfrage', 'Team'];
const ASSETS = ['/assets/style.css', '/assets/theme-init.js', '/assets/app.js', '/assets/guest.js', '/assets/motion.js', '/brand.css'];
const SHIELD_TEXT = /Zu viele Anfragen|vorübergehend gesperrt|Zu viele neue Geräte|sehr viele Wünsche|von diesem Gerät|sehr viel los|sehr viele Wünsche offen/;
const SIM_NET = '198.18.';    // Adressbereich fuer Messungen (RFC 2544), kommt im echten Internet nicht vor
const clampN = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

export function createRehearsal({ server, engines }) {
  let run = null, last = null;

  function options(o = {}) {
    return {
      guests: clampN(o.guests, 5, 1500, 150),
      durationMin: clampN(o.durationMin, 1, 30, 5),
      rampSec: clampN(o.rampSec, 0, 600, 60),
      intensity: INTENSITY[o.intensity] ? o.intensity : 'normal',
      ipMode: o.ipMode === 'one' ? 'one' : 'many',
      pages: o.pages !== false,
      live: o.live !== false,
      approvePct: clampN(o.approvePct, 0, 100, 80),
      modDelaySec: clampN(o.modDelaySec, 1, 120, 6),
      speed: clampN(o.speed, 1, 30, 10),
      poll: o.poll !== false,
      resetBefore: o.resetBefore !== false,
      resetAfter: o.resetAfter !== false,
    };
  }

  function start(raw, who) {
    if (run) throw new Error('Es läuft bereits eine Generalprobe.');
    if (!settings().test.enabled || !isOn('testMode')) throw new Error('Die Generalprobe läuft im Testmodus. Bitte zuerst den Testmodus einschalten (Admin → Start & Links).');
    const eng = engines.test;
    if (eng.realConnections || eng.spotify.kind !== 'mock') throw new Error('Im Testmodus sind gerade echte Verbindungen (Spotify/Pi) aktiv. Für die Generalprobe unter Testmodus-Optionen „Echte Verbindungen nutzt: Live" einstellen.');
    const port = server.address()?.port;
    if (!port) throw new Error('Server-Port unbekannt.');
    const opt = options(raw);
    const prefix = `/${settings().test.prefix}`;
    const base = `http://127.0.0.1:${port}${prefix}`;
    const catalog = (eng.spotify.catalog?.() || []).flatMap((t) => t.title.split(/\s+/)).filter((w) => w.length > 2);

    if (opt.resetBefore) { rq.resetEnv('test'); eng.resetAll(); }
    eng.openWishes();
    const oldSpeed = settings().test.mockSpeed;
    settings().test.mockSpeed = opt.speed;          // nur der Testmodus spielt schneller

    // Moderations-Bot mit eigenem, voruebergehendem Zugang
    const db = getDb();
    const acc = Number(db.prepare('INSERT INTO accounts(role, label, code_hash, created_at) VALUES(?,?,?,?)').run('mod', 'Generalprobe-Bot', `probe:${sha256(randomToken(16))}`, Date.now()).lastInsertRowid);
    const botCookie = `sid=${newSession(acc, 'mod', '127.0.0.1', 'Generalprobe')}`;

    const r = run = {
      opt, startedAt: Date.now(), endsAt: Date.now() + opt.durationMin * 60000, who, base, prefix, acc, oldSpeed, stopping: false,
      guests: [], timers: [], inflight: 0, skipped: 0,
      cats: Object.fromEntries(CATS.map((c) => [c, { n: 0, ok: 0, appLimit: 0, shield: 0, closed: 0, other4xx: 0, err5xx: 0, neterr: 0, lat: [] }])),
      ws: { opened: 0, failed: 0, closed: 0, msgs: 0, open: 0 },
      seconds: [], cur: { t: Math.floor(Date.now() / 1000), req: 0, err: 0, blocked: 0 },
      server: { rss: [], cpu: [], lag: [] }, cpuPrev: process.cpuUsage(), cpuTs: Date.now(),
      loop: monitorEventLoopDelay({ resolution: 10 }),
      shieldStart: shield.status().blocked.total,
      decisions: { approved: 0, denied: 0 }, crossfades: 0, pollId: null,
      sockets: new Set(),
    };
    r.loop.enable();

    const record = (cat, ms, kind) => {
      const c = r.cats[cat]; c.n++; c[kind]++;
      if (c.lat.length < 20000) c.lat.push(ms); else c.lat[Math.floor(Math.random() * 20000)] = ms;
      r.cur.req++; if (kind === 'err5xx' || kind === 'neterr') r.cur.err++; if (kind === 'shield') r.cur.blocked++;
    };

    async function call(g, cat, method, path, body, { root = false } = {}) {
      if (r.inflight >= 400) { r.skipped++; return null; }
      r.inflight++;
      const t0 = performance.now();
      try {
        const headers = { 'X-Forwarded-For': g.ip, 'User-Agent': 'Generalprobe' };
        if (g.cookie) headers.Cookie = g.cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch((root ? `http://127.0.0.1:${port}` : base) + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        for (const sc of res.headers.getSetCookie?.() || []) { const kv = sc.split(';')[0]; if (/^(__Host-)?(dev|sid)=/.test(kv) && !/Max-Age=0/i.test(sc)) g.cookie = kv; }
        const text = await res.text();
        const ms = performance.now() - t0;
        let json = null; try { json = JSON.parse(text); } catch { /* HTML/Datei */ }
        const s = res.status;
        const kind = s < 400 ? 'ok' : s === 423 ? 'closed' : (s === 429 || s === 503) ? (SHIELD_TEXT.test(json?.error || text) ? 'shield' : 'appLimit') : s >= 500 ? 'err5xx' : 'other4xx';
        record(cat, ms, kind);
        return { status: s, json };
      } catch { record(cat, performance.now() - t0, 'neterr'); return null; }
      finally { r.inflight--; }
    }

    function openWs(g, cookie) {
      const url = `ws://127.0.0.1:${port}${prefix}/ws`;
      const ws = new WebSocket(url, { headers: { Cookie: cookie, 'X-Forwarded-For': g.ip } });
      r.sockets.add(ws);
      ws.on('open', () => { r.ws.opened++; r.ws.open++; g.wsOk = true; });
      ws.on('message', (m) => { r.ws.msgs++; if (g.wantState) { try { const d = JSON.parse(m); if (d.type === 'guest') g.state = d.data; } catch { /* egal */ } } });
      ws.on('unexpected-response', () => { r.ws.failed++; ws.terminate(); });
      ws.on('error', () => { if (!g.wsOk) r.ws.failed++; });
      ws.on('close', () => { if (g.wsOk) { r.ws.closed++; r.ws.open--; g.wsOk = false; } r.sockets.delete(ws); });
      return ws;
    }

    const ipFor = (i) => (opt.ipMode === 'one' ? `${SIM_NET}255.254` : `${SIM_NET}${(i >> 8) & 255}.${(i & 255) || 1}`);
    async function join(i) {
      const g = { i, ip: ipFor(i), cookie: null, state: null, results: [], wsOk: false, wantState: false, active: true };
      r.guests.push(g);
      if (opt.pages) {
        await call(g, 'Seite', 'GET', '/');
        await Promise.all(ASSETS.map((a) => call(g, 'Datei', 'GET', a, undefined, { root: true })));
      }
      const st = await call(g, 'Status', 'GET', '/api/guest/state');
      if (st?.json) g.state = st.json;
      if (opt.live && g.cookie) g.ws = openWs(g, g.cookie);
    }

    const rate = INTENSITY[opt.intensity];
    const chance = (perMin, dtMs) => Math.random() < perMin * dtMs / 60000;
    async function act(g, dt) {
      if (chance(rate.search, dt)) {
        const q = catalog[Math.floor(Math.random() * catalog.length)] || 'love';
        const out = await call(g, 'Suche', 'GET', `/api/guest/search?q=${encodeURIComponent(q)}`);
        if (out?.json?.tracks) g.results = out.json.tracks.filter((t) => !t.blocked);
      }
      if (g.results.length && chance(rate.wish, dt)) {
        const t = g.results[Math.floor(Math.random() * g.results.length)];
        const out = await call(g, 'Wunsch', 'POST', '/api/guest/request', { trackId: t.id });
        if (out?.json?.state) g.state = out.json.state;
      }
      const list = g.state?.voting?.list?.filter((v) => !v.mine) || [];
      if (list.length && chance(rate.vote, dt)) {
        const v = list[Math.floor(Math.random() * list.length)];
        const out = await call(g, 'Abstimmung', 'POST', '/api/guest/vote', { id: v.id });
        if (out?.json?.state) g.state = out.json.state;
      }
      const p = g.state?.poll;
      if (p && p.status === 'open' && p.mine == null && chance(rate.poll, dt)) {
        const out = await call(g, 'Umfrage', 'POST', '/api/guest/poll-vote', { idx: Math.floor(Math.random() * p.options.length) });
        if (out?.json?.state) g.state = out.json.state;
      }
      if (chance(rate.state, dt)) { const out = await call(g, 'Status', 'GET', '/api/guest/state'); if (out?.json) g.state = out.json; }
    }

    // ---- Zeitsteuerung ----
    const total = opt.durationMin * 60000;
    let joined = 0;
    r.timers.push(setInterval(() => {               // Gaeste kommen nach und nach
      if (r.stopping) return;
      const el = Date.now() - r.startedAt;
      const target = opt.rampSec ? Math.min(opt.guests, Math.ceil(opt.guests * el / (opt.rampSec * 1000))) : opt.guests;
      while (joined < target) join(joined++).catch(() => {});
    }, 200));
    let lastTick = Date.now();
    r.timers.push(setInterval(() => {               // Gaeste handeln
      if (r.stopping) return;
      const now = Date.now(), dt = now - lastTick; lastTick = now;
      for (const g of r.guests) if (g.active) act(g, dt).catch(() => {});
      if (now >= r.endsAt) stop('fertig');
    }, 250));
    const bot = { ip: '127.0.0.1', cookie: botCookie };
    r.timers.push(setInterval(async () => {          // Moderations-Bot
      if (r.stopping) return;
      const st = await call(bot, 'Team', 'GET', '/api/state');
      const due = (st?.json?.pending || []).filter((p) => Date.now() - p.createdAt >= opt.modDelaySec * 1000).slice(0, 15);
      for (const p of due) {
        const approve = Math.random() * 100 < opt.approvePct;
        const out = await call(bot, 'Team', 'POST', '/api/mod/decide', approve ? { id: p.id, action: 'approve' } : { id: p.id, action: 'deny', reason: settings().rejectReasons[0] });
        if (out?.status === 200) r.decisions[approve ? 'approved' : 'denied']++;
      }
    }, Math.max(1000, opt.modDelaySec * 500)));
    if (opt.live) setTimeout(() => { if (!r.stopping) r.botWs = openWs({ ip: '127.0.0.1' }, botCookie); }, 500);
    r.timers.push(setInterval(() => {                // Technik-Bot: abspielen und ueberblenden
      if (r.stopping) return;
      const p1 = eng.players[1].status(), p2 = eng.players[2].status();
      const playing = p1.playing || p2.playing;
      const up = rq.upcoming('test');
      if (!playing && up.length && !eng.crossfade) eng.fadeIn(1, 2).catch(() => {});
      else if (playing && !eng.crossfade && !settings().auto.enabled && eng.current) {
        const st = eng.players[eng.current].status();
        if (st.durationMs && st.durationMs - st.positionMs < 8000 * opt.speed && up.length) eng.startCrossfade(Math.max(1, 8 / opt.speed)).then(() => { r.crossfades++; }).catch(() => {});
      }
      // Umfrage in der Mitte der Probe
      const el = (Date.now() - r.startedAt) / total;
      if (opt.poll && isOn('polls') && !r.pollId && el > 0.3) { try { r.pollId = createPoll('test', 'Generalprobe: Welcher Stil als Nächstes?', ['Pop', 'Hip-Hop', 'Rock', 'Schlager']); } catch { r.pollId = -1; } }
      if (r.pollId > 0 && el > 0.75) { closePoll('test'); r.pollId = -2; }
    }, 1000));
    r.timers.push(setInterval(() => {                // Messwerte pro Sekunde
      const now = Date.now();
      const cpu = process.cpuUsage(r.cpuPrev); r.cpuPrev = process.cpuUsage();
      const wall = (now - r.cpuTs) * 1000; r.cpuTs = now;
      r.server.cpu.push(Math.round(100 * (cpu.user + cpu.system) / Math.max(1, wall)));
      r.server.rss.push(Math.round(process.memoryUsage().rss / 1048576));
      r.server.lag.push(Math.round(r.loop.max / 1e6)); r.loop.reset();
      r.seconds.push({ ...r.cur }); r.cur = { t: Math.floor(now / 1000), req: 0, err: 0, blocked: 0 };
      for (const k of ['cpu', 'rss', 'lag']) if (r.server[k].length > 1800) r.server[k].shift();
      if (r.seconds.length > 1800) r.seconds.shift();
    }, 1000));
    return status();
  }

  function summarize(r) {
    const cats = Object.fromEntries(Object.entries(r.cats).filter(([, c]) => c.n).map(([k, c]) => [k, { n: c.n, ok: c.ok, appLimit: c.appLimit, shield: c.shield, closed: c.closed, other4xx: c.other4xx, err5xx: c.err5xx, neterr: c.neterr, p50: pct(c.lat, 50), p95: pct(c.lat, 95), p99: pct(c.lat, 99), max: c.lat.length ? Math.max(...c.lat) : null }]));
    const all = Object.values(r.cats).reduce((a, c) => ({ n: a.n + c.n, ok: a.ok + c.ok, shield: a.shield + c.shield, err: a.err + c.err5xx + c.neterr, appLimit: a.appLimit + c.appLimit }), { n: 0, ok: 0, shield: 0, err: 0, appLimit: 0 });
    const secs = Math.max(1, ((r.endedAt || Date.now()) - r.startedAt) / 1000);
    const peakRps = Math.max(0, ...r.seconds.map((s) => s.req));
    const lagMax = Math.max(0, ...r.server.lag), cpuMax = Math.max(0, ...r.server.cpu), rssMax = Math.max(0, ...r.server.rss);
    const counts = rq.counts('test');
    const findings = [];
    const add = (level, text, hint) => findings.push({ level, text, hint });
    if (all.err) add('bad', `${all.err} Anfragen sind mit Serverfehler oder Verbindungsabbruch gescheitert.`, 'Server-Log prüfen (docker compose logs app). Bei Verbindungsabbrüchen: weniger Gäste oder stärkeren Server testen.');
    if (all.shield) add(r.opt.ipMode === 'one' ? 'warn' : 'warn', `${all.shield} Anfragen wurden vom Schutz vor Überlastung abgewiesen.`, r.opt.ipMode === 'one' ? 'Alle Gäste kamen über eine Adresse (wie im Schul-WLAN). Wenn das bei dir so ist: in Admin → Sicherheit die Grenzen „pro Adresse" (Seiten, Dateien, Gäste, Live-Verbindungen, Wünsche, neue Geräte) für deine Gästezahl erhöhen.' : 'Prüfe die Grenzen pro Gerät/Adresse in Admin → Sicherheit, oder die Intensität war unrealistisch hoch.');
    const slow = Object.entries(cats).filter(([k, c]) => ['Status', 'Suche', 'Wunsch', 'Team'].includes(k) && c.p95 != null && c.p95 > 1000);
    if (slow.length) add(slow.some(([, c]) => c.p95 > 3000) ? 'bad' : 'warn', `Langsame Antworten: ${slow.map(([k, c]) => `${k} (95 % unter ${Math.round(c.p95)} ms)`).join(', ')}.`, 'Mehr CPU/RAM für den Server, oder weniger gleichzeitige Gäste. Die Probe läuft im selben Prozess wie die App – echte Werte sind etwas besser.');
    if (lagMax > 300) add(lagMax > 1000 ? 'bad' : 'warn', `Der Server war zeitweise ausgelastet (Verzögerung bis ${lagMax} ms).`, 'Kurze Spitzen sind unkritisch; dauerhaft hohe Werte bedeuten, dass der Server an seine Grenze kommt.');
    if (r.ws.failed) add('warn', `${r.ws.failed} Live-Verbindungen konnten nicht aufgebaut werden.`, 'Grenze „Live-Verbindungen pro Adresse/insgesamt" prüfen.');
    if (r.skipped) add('info', `Der Simulator war zeitweise selbst voll (${r.skipped} Aktionen übersprungen).`, 'Das betrifft die Probe, nicht die App. Für härtere Tests die Intensität senken oder die Gästezahl erhöhen.');
    if (!r.decisions.approved && r.opt.approvePct > 0 && secs > 60) add('warn', 'Die Moderation hat keine Wünsche angenommen.', 'Prüfen, ob Wünsche ankamen (Testmodus offen? Freischaltung?).');
    if (all.appLimit) add('info', `${all.appLimit} Mal griff ein normales Gäste-Limit (z. B. Wünsche pro Gerät, Suchen pro Gerät).`, 'Das ist gewollt und kein Fehler.');
    if (!findings.some((f) => f.level !== 'info')) add('ok', 'Keine Probleme gefunden – das System hat die simulierte Party gut verkraftet.', null);
    const verdict = findings.some((f) => f.level === 'bad') ? 'bad' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
    return {
      opt: r.opt, startedAt: r.startedAt, endsAt: r.endsAt, endedAt: r.endedAt || null, endReason: r.endReason || null, who: r.who,
      guests: { joined: r.guests.length, target: r.opt.guests },
      totals: { ...all, rps: Math.round(all.n / secs * 10) / 10, peakRps },
      cats, ws: { ...r.ws }, decisions: r.decisions, crossfades: r.crossfades,
      server: { cpuMax, rssMax, lagMax, cpu: r.server.cpu.slice(-120), lag: r.server.lag.slice(-120), rss: r.server.rss.at(-1) ?? null },
      timeline: r.seconds.slice(-120),
      app: { pending: counts.pending, queue: counts.approved, played: counts.played, denied: counts.denied, shieldBlocked: shield.status().blocked.total - r.shieldStart },
      findings, verdict,
    };
  }

  function stop(reason = 'abgebrochen') {
    const r = run;
    if (!r || r.stopping) return status();
    r.stopping = true; r.endedAt = Date.now(); r.endReason = reason;
    r.timers.forEach(clearInterval);
    r.loop.disable();
    for (const ws of r.sockets) { try { ws.terminate(); } catch { /* egal */ } }
    last = summarize(r);
    // aufraeumen: Testdaten, Bot-Zugang, Sperren der Messadressen, Tempo
    settings().test.mockSpeed = r.oldSpeed;
    const db = getDb();
    db.prepare('UPDATE requests SET decided_by = NULL WHERE decided_by = ?').run(r.acc);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(r.acc);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(r.acc);
    shield.unbanWhere((ip) => ip.startsWith(SIM_NET) || ip === '127.0.0.1');
    if (r.opt.resetAfter) { rq.resetEnv('test'); engines.test.resetAll(); }
    run = null;
    return status();
  }

  function status() { return { running: !!run, current: run ? summarize(run) : null, last, intensities: Object.keys(INTENSITY) }; }

  return { start, stop, status, isRunning: () => !!run };
}
