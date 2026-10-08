import PDFDocument from 'pdfkit';
import { getDb } from './db.js';
import { settings } from './settings.js';
import { getLogo } from './brand.js';

// Standard-PDF-Schriften kennen nur Latin-1: typografische Zeichen vereinfachen, Unbekanntes ersetzen
const latin = (s) => String(s ?? '')
  .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[^\u0009\u000a -ÿ]/g, '?');

const fmtTime = (ts, tz) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
const fmtDate = (ts, tz) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'full' }).format(ts);

// Setlist als formatiertes A4-PDF (stream in `out`)
export function setlistPdf(env, out) {
  const db = getDb(), tz = settings().timezone, brand = settings().brand;
  const rows = db.prepare(`SELECT p.ts, p.player, p.title, p.artist, p.request_id, r.device_id, r.votes, r.prioritized_at
    FROM plays p LEFT JOIN requests r ON r.id = p.request_id WHERE p.env = ? ORDER BY p.ts ASC`).all(env);
  const counts = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='denied' THEN 1 ELSE 0 END) denied FROM requests WHERE env = ? AND device_id NOT IN ('staff','auto')").get(env);

  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 52, right: 52 }, info: { Title: `Setlist ${brand.name}`, Author: brand.name } });
  doc.pipe(out);
  const W = doc.page.width - 104;
  const logo = getLogo();
  if (logo && (logo.mime === 'image/png' || logo.mime === 'image/jpeg')) { try { doc.image(logo.data, 52, 48, { fit: [64, 64] }); } catch { /* Logo unlesbar: weglassen */ } }
  const x0 = logo && (logo.mime === 'image/png' || logo.mime === 'image/jpeg') ? 128 : 52;
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#0b0b0c').text(latin(brand.name), x0, 52);
  doc.font('Helvetica').fontSize(11).fillColor('#55555a').text(`Setlist${env === 'test' ? ' (Testmodus)' : ''} - ${latin(fmtDate(rows[0]?.ts ?? Date.now(), tz))}`, x0, doc.y + 2);
  if (brand.tagline) doc.fontSize(10).text(latin(brand.tagline), x0, doc.y + 2);
  const wished = rows.filter((r) => r.request_id && r.device_id !== 'auto').length;
  doc.moveDown(2.2);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b0b0c').text(`${rows.length} Songs gespielt  |  ${wished} davon gewünscht  |  ${counts.total ?? 0} Wünsche, ${counts.denied ?? 0} abgelehnt`.replace('ü', 'ü'), 52);
  doc.moveDown(0.8);

  const header = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#76767b');
    doc.text('NR', 52, y, { width: 28 }); doc.text('UHR', 82, y, { width: 40 }); doc.text('TITEL / INTERPRET', 126, y, { width: W - 150 }); doc.text('PLAYER', 52 + W - 44, y, { width: 44, align: 'right' });
    doc.moveTo(52, y + 14).lineTo(52 + W, y + 14).lineWidth(0.6).strokeColor('#cfcfd3').stroke();
    doc.y = y + 20;
  };
  header();
  rows.forEach((r, i) => {
    if (doc.y > doc.page.height - 90) { doc.addPage(); header(); }
    const y = doc.y;
    const tag = r.device_id === 'auto' ? '  [Auto]' : r.prioritized_at ? '  [Prio]' : r.request_id ? '' : '  [extern]';
    doc.font('Helvetica').fontSize(9).fillColor('#76767b').text(String(i + 1), 52, y + 1, { width: 28 });
    doc.fillColor('#3d3d40').text(fmtTime(r.ts, tz), 82, y + 1, { width: 40 });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0b0b0c').text(latin(r.title), 126, y, { width: W - 150, continued: tag ? true : false });
    if (tag) doc.font('Helvetica').fontSize(8).fillColor('#76767b').text(tag);
    doc.font('Helvetica').fontSize(9).fillColor('#55555a').text(latin(r.artist), 126, doc.y, { width: W - 150 });
    doc.font('Helvetica').fontSize(9).fillColor('#76767b').text(`P${r.player}`, 52 + W - 44, y + 1, { width: 44, align: 'right' });
    doc.y += 7;
  });
  if (!rows.length) doc.font('Helvetica').fontSize(11).fillColor('#76767b').text('Noch keine Songs gespielt.', 52);
  doc.end();
}
