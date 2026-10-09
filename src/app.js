import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { openDb } from './db.js';
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
  charts: { file: 'charts.html', perm: null },
  wall: { file: 'wall.html', perm: null },
  schedule: { file: 'schedule.html', perm: 'viewSchedule' },
  activity: { file: 'activity.html', perm: 'viewActivity' },
  focus: { file: 'focus.html', perm: 'moderate' },
  ticker: { file: 'ticker.html', perm: 'viewTicker' },
  analytics: { file: 'analytics.html', perm: 'viewStats' },
};

// Seite -> Funktionsschalter (ausgeschaltete Ansichten gibt es dann nicht mehr)
const PAGE_FEATURE = { board: 'viewBoard', beamer: 'viewBeamer', focus: 'viewFocus', ticker: 'viewTicker', analytics: 'viewAnalytics', prep: 'viewPrep', foh: 'viewFoh', stage: 'viewStage', light: 'viewLight', charts: 'viewCharts', wall: 'viewWall', schedule: 'viewSchedule', activity: 'viewActivity' };

export function createApp({ dataDir = config.dataDir, startEngines = true } = {}) {
  const problems = validateConfig();
  if (problems.length) throw new Error(problems.join(' '));
  openDb(dataDir);
  loadSettings();
  ensureAdminPassword();

  const engines = {
    live: new Engine('live', { realConnections: settings().test.realEnv === 'live' }),
    test: new Engine('test', { realConnections: settings().test.realEnv === 'test' }),
  };
  const setRealEnv = () => { for (const e of Object.keys(engines)) engines[e].setReal(settings().test.realEnv === e); };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustCloudflare ? true : 'loopback, linklocal, uniquelocal');
  const server = http.createServer(app);

  const allowedOrigin = (origin, req) => {
    try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
  };
  const hub = createHub(server, engines, { testPrefix: () => settings().test.prefix, testEnabled: () => settings().test.enabled, allowedOrigin });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api') || PAGES[req.path.replace(/^\/|\/$/g, '')] !== undefined) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, build: BUILD }));
  // Immer beim Server nachfragen (ETag), auch Cloudflare darf die Dateien nicht festhalten.
  // Zusaetzlich bekommt jede Asset-URL ?v=<Build>, damit alte Kopien (Browser, Proxy, CDN) nie passen.
  const noCache = (res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); res.setHeader('CDN-Cache-Control', 'no-store'); res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store'); };
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
  app.get('/brand.css', (req, res) => { res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate', 'CDN-Cache-Control': 'no-store' }).send(brandCss()); });

  app.use(spotifyCallbackRouter(() => { for (const e of Object.values(engines)) e.setReal(e.realConnections, true); }));

  const pageCache = {};
  const renderPage = (name, base, env) => {
    pageCache[name] ??= versioned(fs.readFileSync(path.join(PUBLIC, name), 'utf8'));
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
    router.use('/api', vpnRouter());
    router.use('/api', staffRouter(env, engines[env], hub));
    router.use('/api', adminRouter(env, engines[env], hub, { engines, setRealEnv }));
    router.use('/api', opsRouter(env, engines[env], hub, { engines }));
    router.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

    router.get('/recap/:token', (req, res) => {
      if (!isOn('viewRecap') || !recapValid(req.params.token)) return res.status(404).type('text').send('Not found');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.type('html').send(renderPage('recap.html', base, env));
    });
    router.get(/^\/(tech|mod|foh|admin|login|board|beamer|focus|ticker|analytics|prep|stage|light|charts|wall|schedule|activity)?\/?$/, (req, res) => {
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

  const timers = [];
  const monitor = createMonitor(engines);
  let stopBackup = () => {};
  if (startEngines) { for (const e of Object.values(engines)) e.start(); monitor.start(); stopBackup = startBackupScheduler(); }
  timers.push(setInterval(sweepSessions, 10 * 60000));
  timers.push(setInterval(() => { for (const l of limiters.values()) l.sweep(); }, 60000));
  timers.forEach((t) => t.unref?.());

  return {
    app, server, engines, hub,
    monitor,
    async close() { timers.forEach(clearInterval); monitor.stop(); stopBackup(); for (const e of Object.values(engines)) e.stop(); hub.close(); await new Promise((r) => server.close(r)); },
  };
}
