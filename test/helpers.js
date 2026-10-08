import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

export async function startTestApp({ dataDir = ':memory:' } = {}) {
  config.adminPassword = 'super-geheimes-passwort-123';
  config.secret = 'test-secret-test-secret-test-secret-1234';
  const ctx = createApp({ dataDir, startEngines: false });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  return { ...ctx, base };
}

// Minimaler Client mit Cookie-Jar
export class Client {
  constructor(base, prefix = '') { this.base = base + prefix; this.cookies = {}; }
  async req(method, path, body) {
    const headers = { Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const val = decodeURIComponent(kv.slice(i + 1));
      if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = encodeURIComponent(val);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
