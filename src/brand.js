import { getDb } from './db.js';
import { settings } from './settings.js';

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MIMES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

// Dateityp an den ersten Bytes erkennen (nicht dem Dateinamen/Header vertrauen)
export function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  const head = buf.subarray(0, 400).toString('utf8').toLowerCase();
  if (head.includes('<svg') && !/<script|foreignobject|\bon\w+\s*=|javascript:/i.test(buf.toString('utf8'))) return 'svg';
  return null;
}

export function setLogo(buf) {
  const ext = sniffImage(buf);
  if (!ext) throw new Error('Nur PNG, JPG, WebP oder SVG (ohne Skripte) sind erlaubt.');
  if (buf.length > 1024 * 1024) throw new Error('Das Logo darf höchstens 1 MB groß sein.');
  const ver = Date.now();
  getDb().prepare('INSERT INTO brand_assets(name, mime, data, ver) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET mime=excluded.mime, data=excluded.data, ver=excluded.ver').run('logo', MIMES[ext], buf, ver);
  return { ext, ver };
}
export const clearLogo = () => getDb().prepare("DELETE FROM brand_assets WHERE name = 'logo'").run();
export const getLogo = () => getDb().prepare("SELECT mime, data, ver FROM brand_assets WHERE name = 'logo'").get() || null;

// ---- Farben: Akzent -> Tinte (Buttons, Zaehler, ...) mit passender Textfarbe, im Dunkelmodus aufgehellt ----
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const lum = (hex) => { const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const textOn = (hex) => (lum(hex) > 0.4 ? '#0b0b0c' : '#ffffff');
const mix = (hex, to, t) => toHex(rgb(hex).map((v, i) => v + (to[i] - v) * t));

export function brandInfo() {
  const b = settings().brand;
  const logo = getLogo();
  return { name: b.name, tagline: b.tagline, accent: b.accent, logoVer: logo?.ver ?? null, version: `${logo?.ver ?? 0}-${(b.accent || '').slice(1)}-${b.name.length}${b.tagline.length}` };
}

export function brandCss() {
  const a = settings().brand.accent;
  if (!a) return '/* keine eigene Farbe */\n';
  const dark = mix(a, [255, 255, 255], lum(a) < 0.3 ? 0.45 : 0.1); // im Dunkelmodus heller, damit sie sich vom Hintergrund abhebt
  const vars = (c) => `--ink:${c};--ink-text:${textOn(c)};`;
  return `:root{${vars(a)}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(dark)}}}
:root[data-theme="dark"]{${vars(dark)}}
`;
}
