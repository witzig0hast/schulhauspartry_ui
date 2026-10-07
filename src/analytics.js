import { getDb } from './db.js';
import { familiesOf, decadeOf, UNKNOWN } from './genres.js';

const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
const inc = (map, k, by = 1) => map.set(k, (map.get(k) || 0) + by);
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

// Alle Auswertungen fuer das Analytics-Dashboard. rangeMin = 0 -> gesamter Zeitraum.
export function buildAnalytics(env, rangeMin = 0, now = Date.now()) {
  const db = getDb();
  const since = rangeMin > 0 ? now - rangeMin * 60000 : 0;
  const reqs = db.prepare("SELECT * FROM requests WHERE env = ? AND created_at >= ? AND device_id != 'staff'").all(env, since);
  const playedRows = db.prepare("SELECT * FROM requests WHERE env = ? AND played_at IS NOT NULL AND played_at >= ? AND status IN ('played','playing')").all(env, since);
  const plays = db.prepare('SELECT COUNT(*) c FROM plays WHERE env = ? AND ts >= ?').get(env, since).c;
  const attempts = db.prepare('SELECT kind, COUNT(*) c FROM block_attempts WHERE env = ? AND ts >= ? GROUP BY kind').all(env, since);

  // --- Kennzahlen ---
  const by = { pending: 0, approved: 0, denied: 0 };
  const waits = [];
  let votes = 0, explicit = 0, popSum = 0, popN = 0, durSum = 0;
  for (const r of reqs) {
    if (r.status === 'pending') by.pending++;
    else if (r.status === 'denied') by.denied++;
    else by.approved++; // approved, playing, played, removed
    votes += r.votes; if (r.explicit) explicit++;
    if (r.popularity != null) { popSum += r.popularity; popN++; }
    durSum += r.duration_ms || 0;
    if (r.decided_at) waits.push(Math.max(0, Math.round((r.decided_at - r.created_at) / 1000)));
  }
  const decided = by.approved + by.denied;
  const perDevice = new Map();
  for (const r of reqs) inc(perDevice, r.device_id);

  // --- Genres / Interpreten / Jahrzehnte ---
  const famReq = new Map(), famPlay = new Map(), detail = new Map();
  const famAcc = new Map(); // familie -> {approved, denied}
  const artReq = new Map(), artPlay = new Map(), decades = new Map(), titles = new Map();
  const popHist = [0, 0, 0, 0, 0];
  for (const r of reqs) {
    const genres = parse(r.genres);
    for (const f of familiesOf(genres)) {
      inc(famReq, f, r.votes);
      if (r.status !== 'pending') { const a = famAcc.get(f) || { approved: 0, denied: 0 }; if (r.status === 'denied') a.denied++; else a.approved++; famAcc.set(f, a); }
    }
    for (const g of genres || []) inc(detail, g, r.votes);
    for (const a of String(r.artist).split(', ')) inc(artReq, a, r.votes);
    const dec = decadeOf(r.year); if (dec) inc(decades, dec, r.votes);
    if (r.popularity != null) popHist[Math.min(4, Math.floor(r.popularity / 20))]++;
    if (r.votes > 1) titles.set(`${r.title} – ${r.artist}`, r.votes);
  }
  for (const r of playedRows) {
    for (const f of familiesOf(parse(r.genres))) inc(famPlay, f);
    for (const a of String(r.artist).split(', ')) inc(artPlay, a);
  }

  // --- Zeitreihen ---
  const span = rangeMin > 0 ? rangeMin : Math.max(30, Math.ceil((now - Math.min(now, ...reqs.map((r) => r.created_at))) / 60000));
  const step = span <= 90 ? 5 : span <= 240 ? 10 : 30; // Minuten pro Spalte
  const stepMs = step * 60000;
  const t0 = Math.floor((rangeMin > 0 ? since : Math.min(now, ...reqs.map((r) => r.created_at), now)) / stepMs) * stepMs;
  const buckets = [];
  for (let t = t0; t <= now; t += stepMs) buckets.push({ t, approved: 0, denied: 0, pending: 0, fam: new Map() });
  const bucketOf = (ts) => buckets[Math.min(buckets.length - 1, Math.max(0, Math.floor((ts - t0) / stepMs)))];
  for (const r of reqs) {
    const b = bucketOf(r.created_at);
    if (r.status === 'pending') b.pending++; else if (r.status === 'denied') b.denied++; else b.approved++;
    for (const f of familiesOf(parse(r.genres))) inc(b.fam, f, r.votes);
  }
  const topFam = top(famReq, 5).map(([f]) => f);
  const genreTimeline = {
    families: topFam, step,
    columns: buckets.map((b) => ({ t: b.t, values: topFam.map((f) => b.fam.get(f) || 0) })),
  };

  // --- Entscheidungsgeschwindigkeit ---
  const speedBuckets = [['< 30 s', 30], ['< 1 Min', 60], ['< 2 Min', 120], ['< 5 Min', 300], ['länger', Infinity]].map(([label, max]) => ({ label, max, count: 0 }));
  for (const w of waits) speedBuckets.find((b) => w < b.max).count++;

  const devCounts = [...perDevice.values()];
  return {
    env, rangeMin, now, step,
    kpis: {
      requests: reqs.length, votes, approved: by.approved, denied: by.denied, pending: by.pending,
      approvalRate: decided ? Math.round(100 * by.approved / decided) : null,
      medianDecisionSec: median(waits), avgDecisionSec: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
      plays, playedMinutes: Math.round(playedRows.reduce((a, r) => a + (r.duration_ms || 0), 0) / 60000),
      devices: perDevice.size, perDevice: perDevice.size ? +(reqs.length / perDevice.size).toFixed(1) : null,
      explicitShare: reqs.length ? Math.round(100 * explicit / reqs.length) : null,
      avgPopularity: popN ? Math.round(popSum / popN) : null,
      avgLengthSec: reqs.length ? Math.round(durSum / reqs.length / 1000) : null,
      blocked: attempts.reduce((a, b) => a + b.c, 0),
    },
    genres: { requested: top(famReq, 10), played: top(famPlay, 10), detail: top(detail, 12), acceptance: [...famAcc.entries()].map(([family, a]) => ({ family, ...a, rate: Math.round(100 * a.approved / (a.approved + a.denied)) })).sort((x, y) => (y.approved + y.denied) - (x.approved + x.denied)).slice(0, 8), unknownShare: reqs.length ? Math.round(100 * (famReq.get(UNKNOWN) || 0) / Math.max(1, [...famReq.values()].reduce((a, b) => a + b, 0))) : 0 },
    genreTimeline,
    artists: { requested: top(artReq, 10), played: top(artPlay, 10) },
    decades: [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    popularity: ['0–19', '20–39', '40–59', '60–79', '80–100'].map((label, i) => ({ label, count: popHist[i] })),
    timeline: buckets.map((b) => ({ t: b.t, approved: b.approved, denied: b.denied, pending: b.pending })),
    decisionSpeed: speedBuckets.map(({ label, count }) => ({ label, count })),
    topVoted: top(titles, 8),
    devices: { one: devCounts.filter((c) => c === 1).length, two: devCounts.filter((c) => c === 2).length, more: devCounts.filter((c) => c >= 3).length },
    blocked: Object.fromEntries(attempts.map((a) => [a.kind, a.c])),
  };
}
