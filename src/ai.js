import { settings, aiToken } from './settings.js';
import { isOn } from './features.js';
import * as rq from './requests.js';
import { familiesOf } from './genres.js';
import { localHHMM, currentPhase } from './autoorder.js';
import { isBlacklisted, playedBlock } from './blocklist.js';
import { cacheGetStale, cacheSet } from './apicache.js';
import { setSetting, getSetting, getDb } from './db.js';
import * as L from './log.js';

// KI-Funktionen ueber einen eigenen Ollama-Server (ein Modell fuer alles).
// Grundsaetze: die KI schlaegt nur vor, ein Mensch entscheidet (Ausnahme: Licht-Vorschlaege und der optionale
// automatische Lueckenfueller). Es gehen nur Songdaten und Technikzustand raus – keine Gaeste-Daten, keine Geheimnisse.
// Antworten kommen als JSON nach festem Schema (Ollama "format") und werden vor der Verwendung geprueft.

export class AiError extends Error { constructor(msg, status = 503) { super(msg); this.status = status; } }

export const aiReady = () => { const a = settings().ai; return !!(a.enabled && a.url && a.model); };
export const aiOn = (feature) => aiReady() && isOn(feature);

// ---------- Ollama ----------
// Ein lokales Modell schafft meist nur eine Anfrage gleichzeitig: alles hintereinander, hoechstens 6 in der Schlange
let chain = Promise.resolve(), waiting = 0;
const stats = { calls: 0, errors: 0, lastMs: null, lastError: null, lastOk: null };

function headers() { const t = aiToken(); return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }; }

async function rawChat({ system, user, schema, temperature, maxTokens }) {
  const a = settings().ai;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${a.url}/api/chat`, {
      method: 'POST', headers: headers(), signal: AbortSignal.timeout(a.timeoutSec * 1000),
      body: JSON.stringify({
        model: a.model, stream: false, keep_alive: '15m',
        messages: [{ role: 'system', content: system }, { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }],
        format: schema || undefined,
        options: { temperature, num_predict: maxTokens },
      }),
    });
  } catch (e) { throw new AiError(e.name === 'TimeoutError' ? `Die KI hat nicht innerhalb von ${a.timeoutSec} s geantwortet.` : `Ollama nicht erreichbar (${e.cause?.code || e.message}).`); }
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 160);
    throw new AiError(res.status === 404 && /model/i.test(txt) ? `Modell „${a.model}“ ist auf dem Ollama-Server nicht installiert.` : `Ollama-Fehler ${res.status}${txt ? `: ${txt}` : ''}`);
  }
  const out = await res.json().catch(() => null);
  stats.lastMs = Date.now() - t0;
  let content = String(out?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!schema) return content;
  try { return JSON.parse(content); } catch { /* manche Modelle umrahmen JSON mit Text */ }
  const m = content.match(/\{[\s\S]*\}/);
  try { if (m) return JSON.parse(m[0]); } catch { /* unten */ }
  throw new AiError('Die KI hat keine verwertbare Antwort geliefert. Ein größeres Modell oder ein neuer Versuch hilft oft.');
}

export function chat(opts) {
  if (!aiReady()) throw new AiError('Die KI ist nicht eingerichtet (Admin → KI).', 409);
  if (waiting >= 6) throw new AiError('Die KI ist gerade ausgelastet – bitte gleich nochmal.', 429);
  waiting++;
  const p = chain.then(() => rawChat({ temperature: 0.3, maxTokens: 900, ...opts }));
  chain = p.catch(() => {}).finally(() => { waiting--; });
  const t0 = Date.now(), task = opts.task || 'chat';
  return p.then((v) => {
    stats.calls++; stats.lastOk = Date.now(); stats.lastError = null;
    L.info('ki', `ai.${task}`, `KI (${TASK_NAMES[task] || task}) hat in ${((Date.now() - t0) / 1000).toFixed(1)} s geantwortet`, { env: 'system', actor: { kind: 'ai', model: settings().ai.model }, data: { task, model: settings().ai.model, ms: Date.now() - t0, answer: v } });
    return v;
  }, (e) => {
    stats.errors++; stats.lastError = e.message;
    L.warn('ki', `ai.${task}.failed`, `KI (${TASK_NAMES[task] || task}) fehlgeschlagen: ${e.message}`, { env: 'system', data: { task, model: settings().ai.model, ms: Date.now() - t0 } });
    throw e;
  });
}

const TASK_NAMES = { energy: 'Energie-Kurve', filler: 'Lückenfüller', light: 'Licht-Vorschlag', help: 'Fehler-Assistent', recap: 'Rückblick', test: 'Verbindungstest', genres: 'Genres', summary: 'Wunsch-Zusammenfassung', mood: 'Stimmungs-Warnung' };

export async function listModels(url = settings().ai.url) {
  if (!url) throw new AiError('Keine Ollama-Adresse eingetragen.', 400);
  let res;
  try { res = await fetch(`${url}/api/tags`, { headers: headers(), signal: AbortSignal.timeout(8000) }); }
  catch (e) { throw new AiError(`Ollama nicht erreichbar (${e.cause?.code || e.message}).`); }
  if (!res.ok) throw new AiError(`Ollama antwortet mit ${res.status}${res.status === 401 || res.status === 403 ? ' – Token prüfen' : ''}.`);
  const j = await res.json().catch(() => ({}));
  return (j.models || []).map((m) => ({ name: m.name, size: m.size || null, params: m.details?.parameter_size || null, family: m.details?.family || null }));
}
export const aiStats = () => ({ ...stats, queue: waiting, ready: aiReady(), model: settings().ai.model });

// ---------- Prompts ----------
// Gemeinsame Grundregeln fuer alle Aufgaben
const BASE = [
  'Du arbeitest im Technik-Team einer Schulparty (Gäste: Schülerinnen und Schüler, etwa 12 bis 19 Jahre, Lehrkräfte als Aufsicht).',
  'Antworte immer auf Deutsch, knapp, konkret und praxisnah – so, dass man es im Stress am Pult sofort versteht.',
  'Nutze ausschließlich die Daten aus der Nachricht. Erfinde keine Zustände, Zahlen, Uhrzeiten oder Namen. Wenn etwas fehlt oder unsicher ist, sag das ehrlich.',
  'Alles muss schultauglich sein: keine anzüglichen, gewaltverherrlichenden oder diskriminierenden Inhalte.',
  'Gib genau das geforderte JSON zurück, ohne weiteren Text.',
].join('\n');

const sys = (...lines) => `${BASE}\n\n${lines.join('\n')}`;
const songOf = (r) => ({ titel: r.title, interpret: r.artist, jahr: r.year || null, genres: (r.genres || []).slice(0, 4), familie: familiesOf(r.genres)[0] || 'Unbekannt' });

// ---------- 3: Energie-Kurve ----------
const ENERGY_SCHEMA = { type: 'object', properties: {
  stimmung: { type: 'string' }, energie_jetzt: { type: 'integer', minimum: 1, maximum: 10 }, empfehlung: { type: 'string' },
  reihenfolge: { type: 'array', items: { type: 'integer' } }, begruendung: { type: 'string' },
}, required: ['stimmung', 'energie_jetzt', 'empfehlung', 'reihenfolge', 'begruendung'] };

const ENERGY_SYS = sys(
  'Rolle: erfahrene:r Party-DJ, der/die eine Warteschlange so ordnet, dass die Stimmung trägt.',
  'Regeln für die Energie-Kurve:',
  '- Ein Abend baut sich auf: Einstieg locker, dann steigern, Höhepunkte in der Hauptzeit, gegen Ende bewusst ausklingen lassen. Orientiere dich an Uhrzeit und Phase.',
  '- Nicht zwei Mal hintereinander denselben Interpreten. Harte Genre-Wechsel vermeiden – oder über einen passenden Übergangssong lösen.',
  '- Nach zwei, drei sehr energiegeladenen Songs darf einer etwas Luft geben; ruhige Songs nicht stapeln.',
  '- Wünsche (quelle "Wunsch") haben Vorrang vor Füllsongs; viele Votes eher früher.',
  '- Einträge mit "fest": true stehen schon vorne und gehören NICHT in deine Reihenfolge.',
  'Ausgabe: "reihenfolge" enthält jede id der nicht festen Einträge genau einmal, in der neuen Reihenfolge.',
  '"stimmung": max. 6 Wörter zur aktuellen Lage. "energie_jetzt": 1 (ruhig) bis 10 (Eskalation). "empfehlung": 1–2 Sätze an die Technik. "begruendung": 1–3 Sätze, warum diese Reihenfolge.',
);

export async function suggestEnergy(engine) {
  const env = engine.env;
  const up = rq.upcoming(env).slice(0, 25);
  if (up.length < 2) throw new AiError('Dafür braucht es mindestens zwei Songs in der Warteschlange.', 400);
  const fixed = up.filter((u, i) => u.prioritizedAt || (i === 0 && engine.crossfade));
  const free = up.filter((u) => !fixed.includes(u));
  const since = Date.now() - 30 * 60000;
  const data = {
    uhrzeit: localHHMM(), phase: currentPhase()?.name || null,
    wuensche_letzte_30_min: rq.pending(env).concat(up).filter((r) => r.createdAt > since && r.deviceId !== 'auto').length,
    zuletzt_gespielt: rq.history(env, 8).map(songOf),
    warteschlange: up.map((u) => ({ id: u.id, ...songOf(u), votes: u.votes, quelle: u.deviceId === 'auto' ? 'Füllsong' : 'Wunsch', fest: fixed.includes(u) })),
  };
  const out = await chat({ task: 'energy', system: ENERGY_SYS, user: data, schema: ENERGY_SCHEMA, temperature: 0.4 });
  // Reihenfolge pruefen: nur bekannte, freie IDs, jede einmal; Fehlende behalten ihre bisherige Reihenfolge am Ende
  const freeIds = free.map((u) => u.id), seen = new Set();
  const order = (Array.isArray(out.reihenfolge) ? out.reihenfolge : []).map(Number).filter((id) => freeIds.includes(id) && !seen.has(id) && seen.add(id));
  for (const id of freeIds) if (!seen.has(id)) order.push(id);
  const ids = [...fixed.map((u) => u.id), ...order];
  const byId = new Map(up.map((u) => [u.id, u]));
  return {
    mood: String(out.stimmung || '').slice(0, 80), energy: Math.max(1, Math.min(10, Number(out.energie_jetzt) || 5)),
    advice: String(out.empfehlung || '').slice(0, 400), why: String(out.begruendung || '').slice(0, 500),
    order: ids, changed: ids.some((id, i) => id !== up[i].id),
    preview: ids.map((id) => { const u = byId.get(id); return { id, title: u.title, artist: u.artist, trackId: u.trackId, fixed: fixed.includes(u), was: up.indexOf(u) }; }),
  };
}
// Vorschlag uebernehmen: nur, wenn die Warteschlange inzwischen noch dieselben Songs enthaelt
export function applyOrder(env, ids) {
  const up = rq.upcoming(env).slice(0, 25);
  const want = (Array.isArray(ids) ? ids : []).map(Number);
  if (want.length !== up.length || !up.every((u) => want.includes(u.id))) throw new AiError('Die Warteschlange hat sich inzwischen geändert – bitte neuen Vorschlag holen.', 409);
  const rest = rq.upcoming(env).slice(25).map((u) => u.id);
  rq.writeOrder(env, [...want, ...rest]);
}

// ---------- 4: Lueckenfueller ----------
const FILLER_SCHEMA = { type: 'object', properties: {
  vorschlaege: { type: 'array', items: { type: 'object', properties: { titel: { type: 'string' }, interpret: { type: 'string' }, grund: { type: 'string' } }, required: ['titel', 'interpret', 'grund'] } },
}, required: ['vorschlaege'] };

const FILLER_SYS = sys(
  'Rolle: Party-DJ, der/die passende Songs nachlegt, wenn die Warteschlange leer wird.',
  '- Schlage nur real existierende, bekannte Songs vor, die es bei Spotify gibt (Originalversion, korrekter Titel und Hauptinterpret – keine Remixe, keine Fantasie-Titel).',
  '- Orientiere dich an den letzten Wünschen und gespielten Songs (Genres, Jahrzehnte, Sprache) und an Uhrzeit/Phase. Mische Bekanntes mit etwas Abwechslung.',
  '- Keine Songs, die in "schon_gespielt_oder_geplant" stehen, und keine Interpreten, die dort gerade mehrfach vorkommen.',
  '- Keine Songs mit explizitem oder für eine Schulparty unpassendem Text.',
  '"grund": max. 10 Wörter, warum der Song jetzt passt.',
);

export async function suggestFiller(engine, n = 6) {
  const env = engine.env;
  const recent = rq.history(env, 12);
  const wishes = rq.pending(env).concat(rq.upcoming(env)).filter((r) => r.deviceId !== 'auto').slice(0, 12);
  const data = {
    uhrzeit: localHHMM(), phase: currentPhase()?.name || null, anzahl: n,
    letzte_wuensche: wishes.map(songOf), zuletzt_gespielt: recent.map(songOf),
    schon_gespielt_oder_geplant: [...recent, ...rq.upcoming(env)].map((r) => `${r.title} – ${r.artist}`).slice(0, 40),
  };
  const out = await chat({ task: 'filler', system: FILLER_SYS, user: data, schema: FILLER_SCHEMA, temperature: 0.6 });
  const known = new Set([...recent, ...rq.upcoming(env), ...rq.pending(env)].map((r) => r.trackId));
  const now = Date.now();
  const result = [];
  for (const s of (out.vorschlaege || []).slice(0, n + 2)) {
    const title = String(s.titel || '').slice(0, 100), artist = String(s.interpret || '').slice(0, 100);
    if (!title) continue;
    // Bei Spotify nachschlagen (gemerkt) – nur was es wirklich gibt, kommt in die Liste
    const hits = await engine.spotify.search(`${title} ${artist}`.trim(), 5).catch(() => []);
    const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N} ]/gu, '');
    const t = hits.find((x) => norm(x.title).includes(norm(title).split(' ')[0]) && (!artist || norm(x.artist).includes(norm(artist).split(' ')[0]))) || null;
    const blocked = t && (known.has(t.id) || isBlacklisted(t.id, t.artist) || playedBlock(env, t.id, now) || (settings().explicitMode === 'block' && t.explicit));
    if (t) known.add(t.id);
    result.push({ title, artist, reason: String(s.grund || '').slice(0, 120), track: t && !blocked ? { id: t.id, title: t.title, artist: t.artist, explicit: t.explicit, durationMs: t.durationMs } : null, note: !t ? 'bei Spotify nicht gefunden' : blocked ? 'schon gespielt/geplant oder gesperrt' : null });
    if (result.filter((r) => r.track).length >= n) break;
  }
  return result;
}
export async function addSuggested(engine, trackId) {
  const t = await engine.spotify.getTrack(String(trackId));
  if (!t) throw new AiError('Song nicht gefunden.', 404);
  if (isBlacklisted(t.id, t.artist) || playedBlock(engine.env, t.id)) throw new AiError('Dieser Song ist gesperrt oder lief gerade erst.', 409);
  const row = rq.addAuto(engine.env, t, engine.current);
  engine.afterQueueChange();
  return row;
}
// Automatisch nachfuellen (Schalter im Admin): nur wenn die normale Fueller-Playlist nichts geliefert hat
export async function autoFill(engine, now = Date.now()) {
  const a = settings().ai;
  if (!aiOn('aiFiller') || !a.autoFiller || engine.wishlist || engine.liveTest) return null;
  if (engine.state.ended || engine.state.panic || engine.state.emergency) return null;
  if (!engine.current || !engine.players[engine.current].status().playing) return null;
  if (rq.upcoming(engine.env).length >= Math.max(1, settings().filler.minQueue)) return null;
  if (now - (engine.lastAiFill || 0) < 120000) return null;
  engine.lastAiFill = now;
  const list = await suggestFiller(engine, 2);
  const pick = list.find((s) => s.track);
  return pick ? addSuggested(engine, pick.track.id) : null;
}

// ---------- 5: Licht-Vorschlaege ----------
const LIGHT_SCHEMA = { type: 'object', properties: {
  farben: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hex: { type: 'string' } }, required: ['name', 'hex'] } },
  tempo: { type: 'string', enum: ['ruhig', 'mittel', 'schnell'] }, bpm_ca: { type: ['integer', 'null'] },
  intensitaet: { type: 'integer', minimum: 1, maximum: 10 }, strobo: { type: 'boolean' },
  effekte: { type: 'array', items: { type: 'string' } }, stimmung: { type: 'string' }, hinweis: { type: 'string' }, song_bekannt: { type: 'boolean' },
}, required: ['farben', 'tempo', 'intensitaet', 'strobo', 'effekte', 'stimmung', 'hinweis', 'song_bekannt'] };

const LIGHT_SYS = sys(
  'Rolle: Lichttechniker:in, der/die für jeden Song eine passende Lichtstimmung vorschlägt (Moving Heads, PARs, Strobo, Nebel).',
  '- "farben": 2 bis 3 Farben, die zur Stimmung des Songs passen, mit gültigem Hex-Code (#RRGGBB).',
  '- "tempo": ruhig/mittel/schnell. "bpm_ca": ungefähre Schläge pro Minute, nur wenn du den Song wirklich kennst, sonst null.',
  '- "intensitaet": 1 (sanft, wenig Bewegung) bis 10 (volle Show). "strobo": nur bei energiegeladenen Songs mit klaren Drops/Refrains – sparsam, Rücksicht auf Fotosensibilität.',
  '- "effekte": höchstens 3 kurze Stichworte (z. B. "Lauflicht auf den Beat", "Blackout vor dem Drop", "Nebel im Refrain").',
  '- "stimmung": höchstens 5 Wörter. "hinweis": ein Satz mit dem wichtigsten Tipp (z. B. ruhiges Intro, später Einsatz). Keine genauen Zeitangaben erfinden.',
  '- "song_bekannt": true nur, wenn du den Song tatsächlich kennst; sonst leite alles vorsichtig aus Genre und Jahr ab.',
);

const lightMem = new Map();
const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanLight(o) {
  if (!o || typeof o !== 'object') return null;
  const colors = (Array.isArray(o.farben) ? o.farben : []).filter((c) => HEX.test(c?.hex || '')).slice(0, 3).map((c) => ({ name: String(c.name || '').slice(0, 20), hex: c.hex.toLowerCase() }));
  return {
    colors, tempo: ['ruhig', 'mittel', 'schnell'].includes(o.tempo) ? o.tempo : 'mittel', bpm: Number.isInteger(o.bpm_ca) && o.bpm_ca > 40 && o.bpm_ca < 220 ? o.bpm_ca : null,
    intensity: Math.max(1, Math.min(10, Number(o.intensitaet) || 5)), strobe: !!o.strobo, effects: (Array.isArray(o.effekte) ? o.effekte : []).slice(0, 3).map((x) => String(x).slice(0, 60)),
    mood: String(o.stimmung || '').slice(0, 60), hint: String(o.hinweis || '').slice(0, 160), known: !!o.song_bekannt,
  };
}
// Vorhandenen Vorschlag lesen (Speicher, dann Datei) – ohne neue Anfrage
export function lightCue(trackId) {
  if (!trackId) return null;
  if (!lightMem.has(trackId)) { lightMem.set(trackId, cacheGetStale('ailight', trackId)); if (lightMem.size > 2000) lightMem.delete(lightMem.keys().next().value); }
  return lightMem.get(trackId) || null;
}
const lightBusy = new Set(), lightFailed = new Map();
export async function makeLightCue(r) {
  const out = cleanLight(await chat({ task: 'light', system: LIGHT_SYS, user: { ...songOf(r), dauer_s: r.durationMs ? Math.round(r.durationMs / 1000) : null, intro_s: r.introMs ? Math.round(r.introMs / 1000) : null }, schema: LIGHT_SCHEMA, temperature: 0.4, maxTokens: 500 }));
  if (!out) throw new AiError('Keine verwertbare Licht-Antwort.');
  cacheSet('ailight', r.trackId, out); lightMem.set(r.trackId, out);
  return out;
}
// Hintergrund: fuer den laufenden und die naechsten Songs Vorschlaege erzeugen (einer nach dem anderen)
export function startLightWorker(engines, onNew) {
  const t = setInterval(async () => {
    if (!aiOn('aiLight') || !settings().ai.autoLight || lightBusy.size) return;
    for (const engine of Object.values(engines)) {
      const rows = [...rq.history(engine.env, 1).filter((r) => r.status === 'playing'), ...rq.upcoming(engine.env).slice(0, 5)];
      const r = rows.find((x) => x.trackId && !lightCue(x.trackId) && Date.now() - (lightFailed.get(x.trackId) || 0) > 10 * 60000);
      if (!r) continue;
      lightBusy.add(r.trackId);
      try { await makeLightCue({ ...r, introMs: null }); onNew?.(engine.env); } catch { lightFailed.set(r.trackId, Date.now()); } finally { lightBusy.delete(r.trackId); }
      return;
    }
  }, 4000);
  t.unref?.();
  return () => clearInterval(t);
}

// ---------- 7: Fehler-Assistent ----------
const HELP_SCHEMA = { type: 'object', properties: {
  zusammenfassung: { type: 'string' }, ampel: { type: 'string', enum: ['ok', 'warn', 'fail'] },
  probleme: { type: 'array', items: { type: 'object', properties: { titel: { type: 'string' }, schwere: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] }, ursache: { type: 'string' }, schritte: { type: 'array', items: { type: 'string' } } }, required: ['titel', 'schwere', 'ursache', 'schritte'] } },
  antwort: { type: 'string' },
}, required: ['zusammenfassung', 'ampel', 'probleme', 'antwort'] };

// Wissen ueber den Aufbau, damit die KI konkrete Schritte nennen kann
const SYSTEM_KNOWLEDGE = [
  'So ist das System aufgebaut:',
  '- Zwei Spotify-Player (Player 1/2) sind Spotify-Connect-Geräte (Rechner/Streamer), deren Ton auf Kanäle am Behringer X32 geht. Gesteuert wird über die Spotify-Web-API; dafür braucht jedes Konto Premium und das Gerät muss online/aktiv sein (Spotify-App offen, Gerät nicht im Ruhezustand). Admin → Verbindungen: Konto verbinden, Gerät wählen.',
  '- Die App spricht mit dem X32 über ein Relay auf einem Raspberry Pi (HTTP mit Token → OSC/UDP Port 10023). Pi-URL(s) und Token stehen in Admin → Verbindungen; ist man nicht im selben Netz, läuft es über WireGuard-VPN. Kanalzuordnung (welche X32-Kanäle Player und Mics sind) ebenfalls dort.',
  '- "Pegel am Pult" kommt aus den X32-Metern. Pegel 0 trotz laufendem Song: falscher Kanal, Gerät stumm, Kabel/USB oder Spotify-Lautstärke 0.',
  '- Mikrofone gelten als offen, wenn der Kanal nicht gemutet ist und Signal anliegt; das steuert das Ducking (Musik leiser).',
  '- Spotify begrenzt Anfragen pro App (429/Limit): dann pausiert die App kurz, Suche antwortet aus dem Speicher. Mehrere Spotify-Apps verteilen die Last.',
  '- Not-Aus stoppt alles; "Not-Aus aufheben" in der Technik. Notfall-Playlist startet eine Ersatz-Playlist. Im Wunschlisten-Modus spielt die App gar nichts (DJ spielt selbst).',
  '- Testmodus: eigene Umgebung; echte Geräte nutzt immer nur eine Umgebung (Admin → Start & Links → "Echte Verbindungen nutzt").',
  '- Vorbereitung (/prep) und Live-Test (Admin → Technik) prüfen alles der Reihe nach.',
].join('\n');
const HELP_SYS = sys(
  'Rolle: erfahrene:r Veranstaltungstechniker:in, der/die das Team bei Problemen mit dieser App unterstützt.',
  SYSTEM_KNOWLEDGE,
  'Vorgehen: Werte Verbindungen, Fehlerliste, Prüfliste und Zustand aus. Nenne die wahrscheinlichste Ursache zuerst.',
  '- "schritte": konkrete Handgriffe vor Ort, in der richtigen Reihenfolge, je höchstens 15 Wörter (wo klicken, was prüfen, was neu starten). Höchstens 5 Schritte pro Problem, höchstens 4 Probleme.',
  '- Wenn alles in Ordnung ist: ampel "ok", leere Problemliste, kurze Bestätigung.',
  '- "antwort": wenn eine Frage gestellt wurde, beantworte sie hier in 1–4 Sätzen; sonst leerer Text.',
  '- Bleib bei den Daten. Was nicht in den Daten steht, darfst du als Möglichkeit nennen, aber nicht als Tatsache.',
);

export async function diagnose(context, question = '') {
  const out = await chat({ task: 'help', system: HELP_SYS, user: { frage: String(question || '').slice(0, 400) || null, ...context }, schema: HELP_SCHEMA, temperature: 0.2, maxTokens: 1200 });
  return {
    summary: String(out.zusammenfassung || '').slice(0, 400), level: ['ok', 'warn', 'fail'].includes(out.ampel) ? out.ampel : 'warn', answer: String(out.antwort || '').slice(0, 800),
    problems: (Array.isArray(out.probleme) ? out.probleme : []).slice(0, 4).map((p) => ({ title: String(p.titel || '').slice(0, 100), severity: ['hoch', 'mittel', 'niedrig'].includes(p.schwere) ? p.schwere : 'mittel', cause: String(p.ursache || '').slice(0, 300), steps: (Array.isArray(p.schritte) ? p.schritte : []).slice(0, 6).map((x) => String(x).slice(0, 160)) })),
  };
}

// ---------- 9: Rueckblick ----------
const RECAP_SCHEMA = { type: 'object', properties: { titel: { type: 'string' }, text_gaeste: { type: 'string' }, text_team: { type: 'string' } }, required: ['titel', 'text_gaeste', 'text_team'] };
const RECAP_SYS = sys(
  'Rolle: schreibt nach der Party zwei kurze Rückblicke.',
  '- "text_gaeste": 120–200 Wörter, locker und positiv, für die Gäste (Schulhomepage, Instagram). Mit den Highlights: meistgewünschte Songs, Spitzenzeit, beliebteste Genres, Zahlen. Keine Namen von Personen außer Interpreten. Keine Emojis-Flut (höchstens 3).',
  '- "text_team": 100–180 Wörter, sachlich, für das Orga- und Technik-Team: was lief gut, was fällt auf (Ablehnungsquote, Fehler, Not-Aus, Spitzenlast), 2–3 konkrete Verbesserungen fürs nächste Mal.',
  '- "titel": kurze Überschrift für den Gäste-Text.',
  '- Alle Zahlen exakt aus den Daten übernehmen, nichts hinzuerfinden. Absätze mit Leerzeile trennen.',
);
export async function writeRecap(env, report, analytics) {
  const data = {
    veranstaltung: settings().brand.name, zahlen: report.totals, gespielt: report.plays.count,
    erste_wiedergabe: report.plays.first ? new Date(report.plays.first).toLocaleString('de-DE', { timeZone: settings().timezone }) : null,
    letzte_wiedergabe: report.plays.last ? new Date(report.plays.last).toLocaleString('de-DE', { timeZone: settings().timezone }) : null,
    top_songs: report.top.slice(0, 8).map((t) => `${t.title} – ${t.artist} (${t.votes} Stimmen)`),
    spitzenzeiten: report.peaks.map((p) => ({ ab: new Date(p.from).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: settings().timezone }), wuensche_in_15_min: p.count })),
    genres: analytics?.genres?.requested?.slice(0, 6) || [], interpreten: analytics?.artists?.requested?.slice(0, 6) || [],
    fehler: report.errors, not_aus: report.panics,
  };
  const out = await chat({ task: 'recap', system: RECAP_SYS, user: data, schema: RECAP_SCHEMA, temperature: 0.7, maxTokens: 1400 });
  const recap = { title: String(out.titel || 'Rückblick').slice(0, 120), guests: String(out.text_gaeste || '').slice(0, 3000), team: String(out.text_team || '').slice(0, 3000), ts: Date.now(), model: settings().ai.model };
  setSetting(`ai:recap:${env}`, recap);
  return recap;
}
export const lastRecap = (env) => getSetting(`ai:recap:${env}`, null);

// ---------- Genres nachtragen ----------
// Neuere Spotify-Apps liefern oft keine Genres. Dann ordnet die KI den Song selbst ein – nur aus einer festen Liste,
// damit Auswertungen, Licht-Dashboard und Auto-Ordnung damit rechnen koennen.
export const GENRE_LIST = ['pop', 'dance pop', 'german pop', 'synthpop', 'k-pop', 'schlager', 'partyschlager', 'neue deutsche welle', 'deutschrock', 'hip hop', 'german hip hop', 'rap', 'trap',
  'r&b', 'soul', 'edm', 'house', 'techno', 'trance', 'eurodance', 'drum and bass', 'disco', 'funk', 'latin pop', 'reggaeton', 'rock', 'pop rock', 'indie rock', 'classic rock', 'hard rock', 'metal', 'punk',
  'reggae', 'dancehall', 'country', 'folk', 'jazz', 'blues', 'classical', 'singer-songwriter'];
const GENRE_SCHEMA = { type: 'object', properties: { genres: { type: 'array', items: { type: 'string', enum: GENRE_LIST } }, sicher: { type: 'boolean' } }, required: ['genres', 'sicher'] };
const GENRE_SYS = sys(
  'Rolle: Musik-Redakteur:in, die Songs Genres zuordnet.',
  '- Wähle 1 bis 3 passende Genres ausschließlich aus der erlaubten Liste (Feld "genres" im Schema), das wichtigste zuerst.',
  '- "sicher": true nur, wenn du den Song oder Interpreten wirklich kennst; sonst leite vorsichtig aus Titel, Interpret, Sprache und Jahr ab und setze false.',
);
const genreMem = new Map();
export function aiGenresOf(trackId) {
  if (!trackId) return null;
  if (!genreMem.has(trackId)) { genreMem.set(trackId, cacheGetStale('aigenre', trackId)); if (genreMem.size > 3000) genreMem.delete(genreMem.keys().next().value); }
  return genreMem.get(trackId) || null;
}
export async function guessGenres(r) {
  const out = await chat({ task: 'genres', system: GENRE_SYS, user: { titel: r.title, interpret: r.artist, jahr: r.year || null }, schema: GENRE_SCHEMA, temperature: 0.1, maxTokens: 120 });
  const genres = [...new Set((Array.isArray(out.genres) ? out.genres : []).filter((g) => GENRE_LIST.includes(g)))].slice(0, 3);
  if (!genres.length) throw new AiError('Keine Genres erkannt.');
  const val = { genres, sure: !!out.sicher };
  cacheSet('aigenre', r.trackId, val); genreMem.set(r.trackId, val);
  // Alle Eintraege dieses Songs ohne Genres ergaenzen (gleicher Song kann mehrfach vorkommen)
  getDb().prepare("UPDATE requests SET genres = ? WHERE track_id = ? AND (genres IS NULL OR genres = '[]')").run(JSON.stringify(genres), r.trackId);
  L.info('ki', 'genres.filled', `Genres ergänzt: ${r.title} – ${r.artist} → ${genres.join(', ')}${val.sure ? '' : ' (geschätzt)'}`, { env: 'system', actor: { kind: 'ai' }, data: { trackId: r.trackId, genres, sure: val.sure } });
  return val;
}
const genreFailed = new Map();
function startGenreWorker(onNew) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy || !aiOn('aiGenres')) return;
    const now = Date.now();
    const rows = getDb().prepare("SELECT env, track_id, title, artist, year FROM requests WHERE ((genres IS NULL AND created_at < ?) OR genres = '[]') AND created_at > ? ORDER BY id DESC LIMIT 30").all(now - 30000, now - 7 * 86400000);
    const r = rows.find((x) => x.track_id && now - (genreFailed.get(x.track_id) || 0) > 30 * 60000);
    if (!r) return;
    busy = true;
    try {
      const known = aiGenresOf(r.track_id);
      if (known) getDb().prepare("UPDATE requests SET genres = ? WHERE track_id = ? AND (genres IS NULL OR genres = '[]')").run(JSON.stringify(known.genres), r.track_id);
      else await guessGenres({ trackId: r.track_id, title: r.title, artist: r.artist, year: r.year });
      onNew?.(r.env);
    } catch { genreFailed.set(r.track_id, now); } finally { busy = false; }
  }, 5000);
  t.unref?.();
  return () => clearInterval(t);
}

// ---------- Wunsch-Zusammenfassung fuer die Moderation ----------
const SUMMARY_SCHEMA = { type: 'object', properties: {
  ueberblick: { type: 'string' },
  gruppen: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, anzahl: { type: 'integer' } }, required: ['name', 'anzahl'] } },
  auffaellig: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, grund: { type: 'string' } }, required: ['id', 'grund'] } },
  empfehlung: { type: 'string' },
}, required: ['ueberblick', 'gruppen', 'auffaellig', 'empfehlung'] };
const SUMMARY_SYS = sys(
  'Rolle: hilft der Moderation, bei vielen offenen Wünschen schnell den Überblick zu behalten.',
  '- "ueberblick": 1–2 Sätze (z. B. "14 offen, vor allem Deutschrap und Schlager; zwei Wünsche warten schon über 10 Minuten").',
  '- "gruppen": die 3–6 größten Gruppen (Genre-Familie, Jahrzehnt oder Interpret – was am meisten hilft) mit Anzahl, größte zuerst.',
  '- "auffaellig": Wünsche, die man prüfen sollte: Titel, die anzüglich, beleidigend oder für eine Schulparty unpassend sein könnten (auch ohne Explicit-Kennzeichen), offensichtliche Troll- oder Spaßwünsche, sehr lange Wartezeit, sehr viele Stimmen. Nur ids aus den Daten, höchstens 6, "grund" höchstens 8 Wörter. Lieber zu wenig als falscher Alarm.',
  '- "empfehlung": ein Satz, womit die Moderation jetzt anfangen sollte.',
  '- Du entscheidest nichts – du gibst nur einen Überblick.',
);
export async function summarizePending(env) {
  const list = rq.pending(env).concat(rq.later(env)).slice(0, 60);
  if (!list.length) return { overview: 'Keine offenen Wünsche.', groups: [], flagged: [], advice: '', count: 0 };
  const now = Date.now();
  const out = await chat({ task: 'summary', system: SUMMARY_SYS, temperature: 0.2, maxTokens: 700, schema: SUMMARY_SCHEMA,
    user: { uhrzeit: localHHMM(), offen: list.map((r) => ({ id: r.id, titel: r.title, interpret: r.artist, explicit: !!r.explicit, stimmen: r.votes, familie: familiesOf(r.genres)[0], jahr: r.year || null, wartet_min: Math.round((now - r.createdAt) / 60000), zurueckgestellt: r.status === 'later' })) } });
  const ids = new Map(list.map((r) => [r.id, r]));
  return {
    count: list.length, overview: String(out.ueberblick || '').slice(0, 300), advice: String(out.empfehlung || '').slice(0, 200),
    groups: (Array.isArray(out.gruppen) ? out.gruppen : []).slice(0, 6).map((g) => ({ name: String(g.name || '').slice(0, 40), count: Math.max(0, Number(g.anzahl) || 0) })),
    flagged: (Array.isArray(out.auffaellig) ? out.auffaellig : []).filter((x) => ids.has(Number(x.id))).slice(0, 6).map((x) => { const r = ids.get(Number(x.id)); return { id: r.id, title: r.title, artist: r.artist, trackId: r.trackId, reason: String(x.grund || '').slice(0, 80) }; }),
  };
}

// ---------- Stimmungs-Warnung (nur per ntfy) ----------
const MOOD_SCHEMA = { type: 'object', properties: { kippt: { type: 'boolean' }, schwere: { type: 'string', enum: ['niedrig', 'mittel', 'hoch'] }, grund: { type: 'string' }, vorschlag: { type: 'string' } }, required: ['kippt', 'schwere', 'grund', 'vorschlag'] };
const MOOD_SYS = sys(
  'Rolle: erfahrene:r Party-DJ, der/die aus den Zahlen erkennt, ob die Stimmung gerade kippt.',
  'Anzeichen: deutlich weniger Wünsche als vorher, viele Ablehnungen, mehrere ruhige oder unbekannte Songs am Stück, häufige Genre-Brüche, leere Warteschlange, lange Pause.',
  'Normal ist: am Anfang wenig los, gegen Ende ruhiger (Ausklang) – das ist kein Kippen.',
  '- "kippt": nur true, wenn mehrere Anzeichen zusammenkommen. Im Zweifel false – Fehlalarme nerven.',
  '- "schwere": niedrig/mittel/hoch. "grund": ein Satz mit den konkreten Zahlen. "vorschlag": ein konkreter Satz, was die Technik jetzt tun kann (z. B. welchen Wunsch aus der Warteschlange vorziehen).',
);
async function checkMood(engine) {
  const env = engine.env, now = Date.now();
  const db = getDb();
  const wishes = (from, to) => db.prepare("SELECT COUNT(*) c FROM requests WHERE env = ? AND device_id NOT IN ('auto','staff') AND created_at >= ? AND created_at < ?").get(env, now - from * 60000, now - to * 60000).c;
  const decided = db.prepare("SELECT status, COUNT(*) c FROM requests WHERE env = ? AND decided_at > ? GROUP BY status").all(env, now - 30 * 60000);
  const played = rq.history(env, 8);
  const data = {
    uhrzeit: localHHMM(), phase: currentPhase()?.name || null,
    wuensche_letzte_15_min: wishes(15, 0), wuensche_15_bis_30_min_davor: wishes(30, 15), wuensche_30_bis_60_min_davor: wishes(60, 30),
    entscheidungen_30_min: Object.fromEntries(decided.map((d) => [d.status, d.c])),
    zuletzt_gespielt: played.map((r) => ({ titel: r.title, interpret: r.artist, familie: familiesOf(r.genres)[0], quelle: r.deviceId === 'auto' ? 'Füllsong' : 'Wunsch', stimmen: r.votes, licht_intensitaet: lightCue(r.trackId)?.intensity ?? null })),
    warteschlange: rq.upcoming(env).slice(0, 6).map((u) => ({ id: u.id, titel: u.title, interpret: u.artist, familie: familiesOf(u.genres)[0], stimmen: u.votes, quelle: u.deviceId === 'auto' ? 'Füllsong' : 'Wunsch' })),
    offene_wuensche: rq.pending(env).length,
  };
  const out = await chat({ task: 'mood', system: MOOD_SYS, user: data, schema: MOOD_SCHEMA, temperature: 0.2, maxTokens: 300 });
  const res = { drop: !!out.kippt, severity: ['niedrig', 'mittel', 'hoch'].includes(out.schwere) ? out.schwere : 'niedrig', reason: String(out.grund || '').slice(0, 300), idea: String(out.vorschlag || '').slice(0, 300) };
  L.log(res.drop ? 'warn' : 'info', 'ki', 'mood.check', res.drop ? `Stimmung kippt (${res.severity}): ${res.reason}` : `Stimmung geprüft: in Ordnung (${res.reason})`, { env, actor: { kind: 'ai' }, data: { ...res, input: data } });
  return res;
}
export function startMoodWatch(engines, notify) {
  const last = {};
  const tick = async () => {
    if (!aiOn('aiMood')) return;
    const n = settings().notify;
    if (!isOn('notify') || !n.enabled || !n.topic || n.events.mood === false) return;   // Warnung geht nur aufs Handy (ntfy)
    for (const engine of Object.values(engines)) {
      const env = engine.env;
      if (engine.wishlist || engine.liveTest || engine.state.ended || engine.state.panic) continue;
      if (env !== 'live' && !engine.realConnections) continue;
      if (![1, 2].some((p) => engine.players[p].status().playing)) continue;
      if (rq.history(env, 4).length < 4) continue;                  // erst wenn der Abend laeuft
      if (Date.now() - (last[env] || 0) < 10 * 60000) continue;    // hoechstens alle 10 Minuten pruefen
      last[env] = Date.now();
      try {
        const r = await checkMood(engine);
        if (r.drop && r.severity !== 'niedrig') await notify({ title: r.severity === 'hoch' ? '📉 Stimmung kippt!' : '📉 Stimmung lässt nach', message: `${r.reason}\n\n💡 ${r.idea}`, priority: r.severity === 'hoch' ? 4 : 3, tags: ['chart_with_downwards_trend'], key: `mood:${env}`, env });
      } catch { /* naechstes Mal */ }
    }
  };
  const t = setInterval(tick, 60000);
  t.unref?.();
  return Object.assign(() => clearInterval(t), { tick });   // tick fuer Tests direkt aufrufbar
}
export { startGenreWorker, checkMood };
