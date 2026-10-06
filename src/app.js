import express from 'express';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Seite -> benoetigte Berechtigung (null = oeffentlich)
const PAGES = {
  '': { file: 'guest.html', perm: null },
  login: { file: 'login.html', perm: null },
  tech: { file: 'tech.html', perm: 'viewTech' },
  mod: { file: 'mod.html', perm: 'viewMod' },
  foh: { file: 'foh.html', perm: 'viewFoh' },
  admin: { file: 'admin.html', perm: 'viewAdmin' },
};

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

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '5m', index: false }));

  app.use(spotifyCallbackRouter(() => { for (const e of Object.values(engines)) e.setReal(e.realConnections, true); }));

  const pageCache = {};
  const renderPage = (name, base, env) => {
    pageCache[name] ??= fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    return pageCache[name].replaceAll('__BASE__', base).replaceAll('__ENV__', env);
  };

  function mount(env, base) {
    const router = express.Router();
    router.use(attachSession);
    router.use(originCheck);

    router.use('/api', (req, res, next) => { req.env = env; next(); });
    router.use('/api/guest', guestRouter(env, engines[env], hub));
    router.use('/api', staffRouter(env, engines[env], hub));
    router.use('/api', adminRouter(env, engines[env], hub, { engines, setRealEnv }));
    router.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

    router.get(/^\/(tech|mod|foh|admin|login)?\/?$/, (req, res) => {
      const name = (req.params[0] || '');
      const page = PAGES[name];
      if (page.perm && !can(req.session?.role, page.perm)) {
        if (!req.session) return res.redirect(`${base}/login?next=${encodeURIComponent(base + '/' + name)}`);
        return res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Kein Zugriff</title><p style="font:16px system-ui;padding:2rem">Kein Zugriff für diese Rolle. <a href="' + base + '/login">Anderen Code verwenden</a></p>');
      }
      if (name === '') deviceMiddleware(req, res, () => {});
      res.type('html').send(renderPage(page.file, base, env));
    });
    return router;
  }

  app.use((req, res, next) => {
    const prefix = settings().test.prefix;
    const p = `/${prefix}`;
    if (req.path === p || req.path.startsWith(p + '/')) {
      if (!settings().test.enabled) return res.status(404).type('text').send('Not found');
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
  if (startEngines) for (const e of Object.values(engines)) e.start();
  timers.push(setInterval(sweepSessions, 10 * 60000));
  timers.forEach((t) => t.unref?.());

  return {
    app, server, engines, hub,
    async close() { timers.forEach(clearInterval); for (const e of Object.values(engines)) e.stop(); hub.close(); await new Promise((r) => server.close(r)); },
  };
}
