import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { openDb } from './db.js';
import { resetLogs } from './log.js';
import { resetCache, coverGet, coverSet, coverFailed, cacheGetStale } from './apicache.js';
import { getDb } from './db.js';
import { loadSettings, settings, onSettingsChange } from './settings.js';
import { ensureAdminPassword, attachSession, originCheck, can, sweepSessions } from './auth.js';
import { Engine } from './engine.js';
import { createHub } from './hub.js';
import { guestRouter, deviceMiddleware } from './routes/guest.js';
import { staffRouter } from './routes/staff.js';
import { adminRouter, spotifyCallbackRouter } from './routes/admin.js';
import { opsRouter } from './routes/ops.js';
import { securityRouter } from './routes/security.js';
import { extrasRouter } from './routes/extras.js';
import { vpnRouter } from './routes/vpn.js';
import { ssoRouter } from './routes/sso.js';
import { djRouter } from './routes/dj.js';
import { shield } from './shield.js';
import { createRehearsal } from './rehearsal.js';
import { rehearsalRouter } from './routes/rehearsal.js';
import { createLiveTest } from './livetest.js';
import { liveTestRouter } from './routes/livetest.js';
import { aiRouter } from './routes/ai.js';
import { logsRouter } from './routes/logs.js';
import { companionRouter } from './routes/companion.js';
import { startLightWorker, startGenreWorker, startMoodWatch, startMixWorker } from './ai.js';
import { sendNotify, holdNotify } from './notify.js';
import { RateLimiter, clientIp } from './security.js';
import { recapValid } from './extras.js';
import { createMonitor } from './monitor.js';
import { startBackupScheduler } from './backup.js';
import { brandInfo, brandCss, getLogo, escapeHtml } from './brand.js';
import { isOn, onList } from './features.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Build-ID = Hash ueber alle Dateien in public/ -> aendert sich bei jedem Update; steckt in jeder Asset-URL
function computeBuildId() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f); else { h.update(e.name); h.update(fs.readFileSync(f)); }
  });
  walk(PUBLIC);
  return h.digest('hex').slice(0, 8);
}
const BUILD = computeBuildId();
const versioned = (text) => text.replace(/(["'])\/assets\/([\w.-]+)\1/g, `$1/assets/$2?v=${BUILD}$1`);

// Seite -> benoetigte Berechtigung (null = oeffentlich)
const PAGES = {
  '': { file: 'guest.html', perm: null },
  login: { file: 'login.html', perm: null },
  tech: { file: 'tech.html', perm: 'viewTech' },
  mod: { file: 'mod.html', perm: 'viewMod' },
  foh: { file: 'foh.html', perm: 'viewFoh' },
  admin: { file: 'admin.html', perm: 'viewAdmin' },
  board: { file: 'board.html', perm: 'viewBoard' },
  beamer: { file: 'beamer.html', perm: null },
  prep: { file: 'prep.html', perm: 'viewPrep' },
  stage: { file: 'stage.html', perm: 'viewStage' },
  light: { file: 'light.html', perm: 'viewLight' },
  logs: { file: 'logs.html', perm: 'viewLogs' },
  ton: { file: 'ton.html', perm: 'viewSound' },
  orga: { file: 'orga.html', perm: 'viewOrga' },
  dj: { file: 'dj.html', perm: 'viewDj' },
  charts: { file: 'charts.html', perm: null },
  wall: { file: 'wall.html', perm: null },
  schedule: { file: 'schedule.html', perm: 'viewSchedule' },
  activity: { file: 'activity.html', perm: 'viewActivity' },
  focus: { file: 'focus.html', perm: 'moderate' },
  ticker: { file: 'ticker.html', perm: 'viewTicker' },
  analytics: { file: 'analytics.html', perm: 'viewStats' },
};

// Seite -> Funktionsschalter (ausgeschaltete Ansichten gibt es dann nicht mehr)
const PAGE_FEATURE = { board: 'viewBoard', beamer: 'viewBeamer', focus: 'viewFocus', ticker: 'viewTicker', analytics: 'viewAnalytics', prep: 'viewPrep', foh: 'viewFoh', stage: 'viewStage', light: 'viewLight', logs: 'viewLogs', ton: 'viewTon', orga: 'viewOrga', dj: 'viewDj', charts: 'viewCharts', wall: 'viewWall', schedule: 'viewSchedule', activity: 'viewActivity' };

export function createApp({ dataDir = config.dataDir, startEngines = true } = {}) {
  const problems = validateConfig();
  if (problems.length) throw new Error(problems.join(' '));
  openDb(dataDir);
  resetCache(); resetLogs();
  loadSettings();
  ensureAdminPassword();

  const engines = {
    live: new Engine('live', { realConnections: settings().test.realEnv === 'live' }),
    test: new Engine('test', { realConnections: settings().test.realEnv === 'test' }),
  };
  // Standard: das System startet deaktiviert (Soundcheck-Modus), bis ein Admin es einschaltet. Einmal eingeschaltet,
  // bleibt es auch nach einem Neustart des Servers an (sonst wuerde ein Update mitten in der Party alles anhalten).
  if (settings().operation.startDisabled !== false && !engines.live.state.activatedAt && !engines.live.state.hold) engines.live.startHold({ by: 'Standard – ein Admin schaltet ein', stopMusic: false, pauseWishes: false, initial: true });
  for (const e of Object.values(engines)) if (e.held) holdNotify(e.env, true);   // Soundcheck-Modus ueberlebt einen Neustart
  const setRealEnv = () => { for (const e of Object.keys(engines)) engines[e].setReal(settings().test.realEnv === e); };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');   // nur private Zwischenstationen (NPM) duerfen Weiterleitungs-Header setzen
  const server = http.createServer(app);
  // Verbindungen nicht ewig offen halten (Slowloris & Co.)
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 60; server.maxConnections = 5000;

  const allowedOrigin = (origin, req) => {
    try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
  };
  let liveTest = null, hub = null;
  const rehearsal = createRehearsal({ server, engines, setRealEnv, pushEnv: (env) => hub?.pushEnv(env, { guests: true }), isBusy: () => (liveTest?.isRunning() ? 'Der Live-Test läuft gerade – erst beenden.' : null) });
  hub = createHub(server, engines, { shield, testPrefix: () => settings().test.prefix, testEnabled: () => settings().test.enabled, allowedOrigin });
  liveTest = createLiveTest({ engines, hub, setRealEnv, isBusy: () => (rehearsal.isRunning() ? 'Die Generalprobe läuft gerade – erst beenden.' : null) });
  liveTest.recover();

  app.use(shield.middleware);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api') || PAGES[req.path.replace(/^\/|\/$/g, '')] !== undefined) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, build: BUILD }));
  // Server-Timing: in den Entwicklertools (Netzwerk → Timing) sieht man, wie lange der Server selbst gebraucht hat
  app.use('/api', (req, res, next) => {
    const t0 = process.hrtime.bigint(), wh = res.writeHead;
    res.writeHead = function (...a) { try { res.setHeader('Server-Timing', `app;dur=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}`); } catch { /* schon gesendet */ } return wh.apply(this, a); };
    next();
  });
  // Jede Asset-URL bekommt ?v=<Build>. Passt die Version zum laufenden Build, darf die Datei fest zwischengespeichert werden
  // (Browser und Cloudflare) – ein neuer Build hat eine neue URL. Ohne oder mit alter Version: immer beim Server nachfragen (ETag).
  // Vorher wurde jede Datei bei jedem Seitenaufruf neu angefragt; ueber Cloudflare kostete das Stufe fuer Stufe spuerbar Zeit.
  const noCache = (res) => {
    if (res.req?.query?.v === BUILD) { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); return; }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate'); res.setHeader('CDN-Cache-Control', 'no-store'); res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  };
  const jsCache = new Map();
  app.get('/assets/:file', (req, res, next) => {
    const f = req.params.file;
    if (!/^[\w.-]+\.js$/.test(f)) return next();
    let body = jsCache.get(f);
    if (body == null) {
      try {
        // QR-Code-Bibliothek (MIT) kommt aus node_modules, alles andere aus public/assets
        const file = f === 'qrcode.js' ? path.join(__dirname, '..', 'node_modules', 'qrcode-generator', 'dist', 'qrcode.mjs') : path.join(PUBLIC, 'assets', f);
        body = versioned(fs.readFileSync(file, 'utf8'));
      } catch { return next(); }
      jsCache.set(f, body);
    }
    noCache(res);
    res.type('text/javascript; charset=utf-8').send(body);
  });
  app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { index: false, etag: true, maxAge: 0, setHeaders: (res) => noCache(res) }));

  // Eigenes Design: Logo und Farben (oeffentlich, damit Gaeste-Seite und Beamer es laden koennen)
  app.get('/brand/logo', (req, res) => {
    const l = getLogo();
    if (!l) return res.status(404).type('text').send('Kein Logo');
    res.set({ 'Content-Type': l.mime, 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(l.data));
  });
  // Album-Cover: einmal von Spotifys Bildserver geholt, dann aus dem Speicher (cache.db). Gaeste-Geraete sprechen nie direkt mit Spotify.
  // Nur fuer Songs, die die App schon kennt (Wunsch, Suche, laufender Song) – fremde IDs loesen keine Abfrage aus.
  const coverInflight = new Map();
  const COVER_URL = /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/;
  const coverUrlOf = (id) => getDb().prepare('SELECT cover FROM requests WHERE track_id = ? AND cover IS NOT NULL ORDER BY id DESC LIMIT 1').get(id)?.cover || cacheGetStale('track', id)?.cover || null;
  async function loadCover(id, url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const mime = String(r.headers.get('content-type') || '').split(';')[0];
      if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error(`Cover ${r.status}`);
      const data = Buffer.from(await r.arrayBuffer());
      if (!data.length || data.length > 800 * 1024) throw new Error('Cover zu groß');
      coverSet(id, mime, data);
      return { mime, data };
    } catch { coverFailed(); return null; }
  }
  app.get('/cover/:id', async (req, res) => {
    const id = req.params.id;
    const miss = (sec) => res.status(404).set('Cache-Control', `public, max-age=${sec}`).end();
    if (!isOn('covers') || !/^[A-Za-z0-9]{22}$/.test(id)) return miss(3600);
    let c = coverGet(id);
    if (!c) {
      const url = coverUrlOf(id);
      if (!url || !COVER_URL.test(url)) return miss(300);
      if (!coverInflight.has(id)) coverInflight.set(id, loadCover(id, url).finally(() => coverInflight.delete(id)));
      c = await coverInflight.get(id);
      if (!c) return miss(60);
    }
    res.set({ 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=604800, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(Buffer.from(c.data));
  });
  app.get('/brand.css', (req, res) => { res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate', 'CDN-Cache-Control': 'no-store' }).send(brandCss()); });

  app.use(spotifyCallbackRouter(() => { for (const e of Object.values(engines)) e.setReal(e.realConnections, true); }));

  // Alle Module einer Seite gleich mit ankuendigen (modulepreload): der Browser laedt sie parallel statt Stufe fuer Stufe
  const depsOf = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    let src = '';
    try { src = fs.readFileSync(path.join(PUBLIC, 'assets', file), 'utf8'); } catch { return seen; }
    for (const m of src.matchAll(/(?:from|import)\s*['"]\/assets\/([\w.-]+\.js)['"]/g)) depsOf(m[1], seen);
    return seen;
  };
  const withPreload = (html) => {
    const main = /<script type="module" src="\/assets\/([\w.-]+\.js)"><\/script>/.exec(html)?.[1];
    if (!main) return html;
    const links = [...depsOf(main)].map((f) => `<link rel="modulepreload" href="/assets/${f}">`).join('\n');
    return html.replace('</head>', `${links}\n</head>`);
  };
  const pageCache = {};
  const renderPage = (name, base, env) => {
    pageCache[name] ??= versioned(withPreload(fs.readFileSync(path.join(PUBLIC, name), 'utf8')));
    const b = brandInfo();
    return pageCache[name].replaceAll('__BASE__', base).replaceAll('__ENV__', env).replaceAll('__BUILD__', BUILD)
      .replaceAll('__BRAND_NAME__', escapeHtml(b.name)).replaceAll('__BRAND_TAG__', escapeHtml(b.tagline)).replaceAll('__BRAND_LOGO__', b.logoVer ? `/brand/logo?v=${b.logoVer}` : '').replaceAll('__BRAND_V__', escapeHtml(b.version)).replaceAll('__FEATURES__', onList().join(','));
  };

  // Allgemeine Bremse pro IP (der Admin stellt sie ein); Gaeste-Routen haben zusaetzlich eigene Limits
  const apiLimiter = { check: (ip) => limiterFor(ip) };
  const limiters = new Map();
  function limiterFor(ip) {
    const max = settings().security.apiPerMin;
    let l = limiters.get(max);
    if (!l) { l = new RateLimiter(max, 60000); limiters.set(max, l); }
    return l.check(ip);
  }

  function mount(env, base) {
    const router = express.Router();
    router.use(attachSession);
    router.use(originCheck);

    router.use('/api', (req, res, next) => { req.env = env; next(); });
    router.use('/api/guest', guestRouter(env, engines[env], hub));
    router.use('/api', (req, res, next) => (req.path.startsWith('/guest') || apiLimiter.check(clientIp(req)).ok ? next() : res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' })));
    router.use('/api', securityRouter(env, engines[env], hub));
    router.use('/api', extrasRouter(env, engines[env], hub));
    router.use('/api', djRouter(env, engines[env], hub));
    router.use('/api', aiRouter(env, engines[env], hub, { engines }));
    router.use('/api', companionRouter(env, engines[env], hub));
    router.use('/api', vpnRouter());
    if (env === 'live') router.use('/api', ssoRouter());
    if (env === 'live') router.use('/api', rehearsalRouter(rehearsal));
    if (env === 'live') router.use('/api', liveTestRouter(liveTest));
    if (env === 'live') router.use('/api', logsRouter());   // Rueckkehr-Adresse beim Anbieter ist fest: PUBLIC_URL/api/sso/callback
    router.use('/api', staffRouter(env, engines[env], hub));
    router.use('/api', adminRouter(env, engines[env], hub, { engines, setRealEnv }));
    router.use('/api', opsRouter(env, engines[env], hub, { engines }));
    router.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

    router.get('/recap/:token', (req, res) => {
      if (!isOn('viewRecap') || !recapValid(req.params.token)) return res.status(404).type('text').send('Not found');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.type('html').send(renderPage('recap.html', base, env));
    });
    router.get(/^\/(tech|mod|foh|admin|login|board|beamer|focus|ticker|analytics|prep|stage|light|logs|ton|orga|dj|charts|wall|schedule|activity)?\/?$/, (req, res) => {
      const name = (req.params[0] || '');
      const page = PAGES[name];
      if (PAGE_FEATURE[name] && !isOn(PAGE_FEATURE[name])) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Ausgeschaltet</title><p style="font:16px system-ui;padding:2rem">Diese Ansicht ist vom Admin ausgeschaltet.</p>');
      if (page.perm && !can(req.session?.role, page.perm)) {
        if (!req.session) return res.redirect(`${base}/login?next=${encodeURIComponent(base + '/' + name)}`);
        return res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Kein Zugriff</title><p style="font:16px system-ui;padding:2rem">Kein Zugriff für diese Rolle. <a href="' + base + '/login">Anderen Code verwenden</a></p>');
      }
      if (name === '' || name === 'beamer' || name === 'charts' || name === 'wall') deviceMiddleware(req, res, () => {});
      res.type('html').send(renderPage(page.file, base, env));
    });
    return router;
  }

  app.use((req, res, next) => {
    const prefix = settings().test.prefix;
    const p = `/${prefix}`;
    if (req.path === p || req.path.startsWith(p + '/')) {
      if (!settings().test.enabled || !isOn('testMode')) return res.status(404).type('text').send('Not found');
      req.url = req.url.slice(p.length) || '/';
      return testRouter(req, res, next);
    }
    next();
  });
  const liveRouter = mount('live', '');
  // Der Test-Router wird bei jeder Praefix-Aenderung neu gebaut (Base-Pfad steckt in den Seiten).
  let testRouter = mount('test', `/${settings().test.prefix}`);
  let currentPrefix = settings().test.prefix;
  onSettingsChange((s) => {
    if (s.test.prefix !== currentPrefix) { currentPrefix = s.test.prefix; for (const k of Object.keys(pageCache)) delete pageCache[k]; testRouter = mount('test', `/${currentPrefix}`); }
  });
  app.use(liveRouter);
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // Fehler (z. B. kaputtes JSON, zu grosse Anfrage) ohne interne Details beantworten
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const code = err.status === 413 || err.type === 'entity.too.large' ? 413 : err.status >= 400 && err.status < 500 ? err.status : 500;
    if (code === 500) console.error('[app]', err.message);
    res.status(code).json({ error: code === 413 ? 'Anfrage zu groß.' : code === 500 ? 'Interner Fehler.' : 'Ungültige Anfrage.' });
  });

  const timers = [];
  const monitor = createMonitor(engines);
  let stopBackup = () => {};
  let stopLight = [];
  if (startEngines) { for (const e of Object.values(engines)) e.start(); monitor.start(); stopBackup = startBackupScheduler(); stopLight = [startLightWorker(engines, (env) => hub.pushEnv(env)), startGenreWorker((env) => hub.pushEnv(env)), startMoodWatch(engines, sendNotify), startMixWorker(engines, (env) => hub.pushEnv(env))]; }
  timers.push(setInterval(sweepSessions, 10 * 60000));
  timers.push(setInterval(() => shield.sweep(), 60000));
  timers.push(setInterval(() => { for (const l of limiters.values()) l.sweep(); }, 60000));
  timers.forEach((t) => t.unref?.());

  return {
    app, server, engines, hub,
    monitor,
    rehearsal, liveTest,
    async close() { if (rehearsal.isRunning()) rehearsal.stop('Server beendet'); if (liveTest.isRunning()) liveTest.stop(); timers.forEach(clearInterval); monitor.stop(); stopBackup(); stopLight.forEach((f) => f()); for (const e of Object.values(engines)) e.stop(); hub.close(); await new Promise((r) => server.close(r)); },
  };
}
