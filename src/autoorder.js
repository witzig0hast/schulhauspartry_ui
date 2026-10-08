import { settings } from './settings.js';
import * as rq from './requests.js';
import { familiesOf } from './genres.js';
import { isOn } from './features.js';

// Stimmungs-Knopf: kurzzeitig ruhigere (-1) oder energiereichere (+1) Songs bevorzugen
const energy = {};
export const setEnergy = (env, v) => { energy[env] = v ? { v: Math.sign(v), until: Date.now() + 20 * 60000 } : null; };
export const getEnergy = (env) => (energy[env] && energy[env].until > Date.now() ? energy[env].v : 0);
const CALM = new Set(['Jazz & Klassik', 'R&B & Soul', 'Country & Folk', 'Reggae & Dancehall']);
const HIGH = new Set(['Electronic & Dance', 'Hip-Hop & Rap', 'Rock & Metal', 'Latin', 'Funk & Disco', 'Schlager & Deutsch']);

const other = (p) => (p === 1 ? 2 : 1);

// Aktuelle Uhrzeit "HH:MM" in der eingestellten Zeitzone (der Container laeuft meist in UTC)
export function localHHMM(date = new Date(), tz = settings().timezone) {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'hour').value}:${parts.find((p) => p.type === 'minute').value}`;
}

export function currentPhase(date = new Date()) {
  const cfg = settings().autoOrder;
  if (!cfg.mood) return null;
  const now = localHHMM(date);
  return cfg.phases.find((p) => (p.from <= p.to ? now >= p.from && now < p.to : now >= p.from || now < p.to)) || null;
}

const primary = (r) => familiesOf(r.genres)[0];

// Sortiert die nicht-priorisierten Songs der Warteschlange sanft um:
//  * Genre-Balance: nie mehr als `maxRepeat` Songs derselben Genre-Familie hintereinander (wenn Alternativen da sind)
//  * Stimmungskurve: Songs, die zur aktuellen Phase passen, ruecken vor
// Fairness: pro Platz werden nur die ersten `window` Wuensche (in Eingangsreihenfolge) betrachtet.
// Priorisierte Songs bleiben exakt auf ihrem Platz.
export function applyAutoOrder(env, currentPlayer, date = new Date()) {
  const cfg = settings().autoOrder;
  if (!cfg.enabled || !isOn('autoOrder')) return false;
  const up = rq.upcoming(env);
  if (up.length < 2) return false;
  const phase = currentPhase(date);
  const prefer = new Set(phase?.prefer || []);
  const en = getEnergy(env);
  const free = up.filter((r) => !r.prioritizedAt);
  const hist = rq.history(env, 4).reverse(); // aeltester zuerst
  const seq = hist.map(primary);               // bisherige Reihenfolge (Familien)
  const out = [];
  for (let i = 0; i < up.length; i++) {
    if (up[i].prioritizedAt) { out.push(up[i]); seq.push(primary(up[i])); continue; }
    const cands = free.slice(0, cfg.window);
    let best = null, bestScore = -Infinity;
    cands.forEach((c, idx) => {
      const fam = primary(c);
      let run = 0;
      for (let k = seq.length - 1; k >= 0 && seq[k] === fam && fam !== 'Unbekannt'; k--) run++;
      let score = -idx;
      if (prefer.size && familiesOf(c.genres).some((f) => prefer.has(f))) score += 4;
      if (run >= cfg.maxRepeat) score -= 6;
      if (en && isOn('energyKnob')) { const fs = familiesOf(c.genres); if (fs.some((f) => HIGH.has(f))) score += 3 * en; if (fs.some((f) => CALM.has(f))) score -= 3 * en; }
      if (score > bestScore) { best = c; bestScore = score; }
    });
    out.push(best); seq.push(primary(best)); free.splice(free.indexOf(best), 1);
  }
  if (out.every((r, i) => r.id === up[i].id)) return false;
  // Spieler abwechselnd, beginnend mit dem, der gerade nicht spielt
  let p = other(currentPlayer || 2);
  const players = out.map(() => { const x = p; p = other(p); return x; });
  rq.writeOrder(env, out.map((r) => r.id), players);
  return true;
}
