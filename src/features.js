import { settings } from './settings.js';

// Zentrale Funktionsliste: jede Funktion/Ansicht kann vom Admin einzeln ein- und ausgeschaltet werden.
// Ausgeschaltet heisst: serverseitig gesperrt (nicht nur versteckt).
export const GROUPS = {
  views: 'Ansichten',
  guest: 'Gäste',
  team: 'Team & Moderation',
  music: 'Musik & Automatik',
  safety: 'Betrieb & Sicherheit',
  visual: 'Animationen & Effekte',
};

export const FEATURES = [
  // --- Ansichten ---
  { id: 'viewBoard', group: 'views', label: 'Board (eigene Ansicht)', desc: 'Bausteine frei zusammenstellen.', def: true },
  { id: 'viewBeamer', group: 'views', label: 'Beamer-Ansicht', desc: 'Großer Bildschirm für Gäste mit QR-Code.', def: true },
  { id: 'viewFocus', group: 'views', label: 'Fokus-Modus', desc: 'Schwarzer Vollbild-Modus für neue Wünsche.', def: true },
  { id: 'viewTicker', group: 'views', label: 'Live-Wünsche', desc: 'Anzeige neuer Wünsche und Entscheidungen.', def: true },
  { id: 'viewAnalytics', group: 'views', label: 'Analytics', desc: 'Genres, Interpreten, Zeitverlauf …', def: true },
  { id: 'viewPrep', group: 'views', label: 'Vorbereitung', desc: 'Checkliste und Testknöpfe vor der Party.', def: true },
  { id: 'viewFoh', group: 'views', label: 'FOH-Anzeige', desc: 'Statusanzeige zum Ansehen.', def: true },
  { id: 'viewStage', group: 'views', label: 'Bühnen-Ansicht', desc: 'Jetzt läuft, Nächster Song, Uhr, Zeitplan und Mics auf einen Blick.', def: true },
  { id: 'viewCharts', group: 'views', label: 'Wunsch-Charts (öffentlich)', desc: 'Rangliste der meistgewünschten Songs für den Bildschirm.', def: true },
  { id: 'viewWall', group: 'views', label: 'Playlist des Abends (öffentlich)', desc: 'Was bisher gespielt wurde – ohne Vorschau auf das Kommende.', def: true },
  { id: 'viewSchedule', group: 'views', label: 'Zeitplan', desc: 'Programmpunkte mit Countdown.', def: true },
  { id: 'viewActivity', group: 'views', label: 'Aktivitätsverlauf', desc: 'Was ist heute Abend passiert (anonym)?', def: true },
  { id: 'viewRecap', group: 'views', label: 'Party-Rückblick (teilbar)', desc: 'Hübsche Zusammenfassung mit geheimem Link.', def: true },
  // --- Gaeste ---
  { id: 'voting', group: 'guest', label: 'Wunsch-Voting', desc: 'Gäste sehen offene Wünsche und geben ein „+1“.', def: true },
  { id: 'soonNotice', group: 'guest', label: '„Gleich dran“-Hinweis', desc: 'Hinweis auf dem Handy, wenn der eigene Song bald läuft.', def: true },
  { id: 'classTag', group: 'guest', label: 'Klassen-Kürzel beim Wunsch', desc: 'Optionales Feld (z. B. „8b“), das nur die Moderation sieht.', def: true },
  { id: 'polls', group: 'guest', label: 'Live-Umfragen', desc: 'Die Technik startet eine Frage, Gäste stimmen ab, Ergebnis auf dem Beamer.', def: true },
  { id: 'guestNowPlaying', group: 'guest', label: '„Jetzt läuft“ auf der Gäste-Seite', desc: 'Zeigt Gästen den aktuellen Song.', def: true },
  // --- Team ---
  { id: 'chat', group: 'team', label: 'Team-Chat', desc: 'Nachrichten im Team (Name ist Pflicht).', def: true },
  { id: 'later', group: 'team', label: 'Wünsche zurückstellen („Später“)', desc: 'Entscheidung vertagen.', def: true },
  { id: 'claims', group: 'team', label: '„Wer bearbeitet gerade?“ & Online-Anzeige', desc: 'Weiche Sperre und Anzeige der Online-Teammitglieder.', def: true },
  { id: 'blacklist', group: 'team', label: 'Sperrliste (Songs/Interpreten)', desc: 'Songs und Interpreten sperren.', def: true },
  { id: 'deviceBlock', group: 'team', label: 'Gast-Geräte sperren', desc: 'Missbrauch stoppen: einzelne Geräte vom Wünschen ausschließen.', def: true },
  { id: 'handover', group: 'team', label: 'Übergabe-Notiz', desc: 'Eine Notiz für die nächste Schicht, oben sichtbar.', def: true },
  // --- Musik ---
  { id: 'autoOrder', group: 'music', label: 'Auto-Ordnung (Genre-Balance & Stimmung)', desc: 'Sortiert die Warteschlange sanft um.', def: true },
  { id: 'energyKnob', group: 'music', label: 'Stimmungs-Knopf („Ruhiger“ / „Mehr Energie“)', desc: 'Verschiebt die Auto-Ordnung für eine Weile.', def: true },
  { id: 'filler', group: 'music', label: 'Lückenfüller', desc: 'Füllt eine leere Warteschlange automatisch.', def: true },
  { id: 'smartOutro', group: 'music', label: 'Smarter Crossfade (Outro)', desc: 'Übergang beginnt, wenn der Song ausklingt.', def: true },
  { id: 'replayRule', group: 'music', label: 'Regel für schon gespielte Songs', desc: 'Erlauben, pausieren oder sperren.', def: true },
  { id: 'songLimit', group: 'music', label: 'Song-Bremse (maximale Länge)', desc: 'Sehr lange Songs werden nach einer Obergrenze übergeblendet.', def: true },
  { id: 'gainMemory', group: 'music', label: 'Lautstärke-Merker pro Song', desc: 'Merkt sich die Fader-Stellung je Song.', def: true },
  { id: 'faderLimit', group: 'music', label: 'Sicherheits-Fader-Limit', desc: 'Obergrenze für die Player-Lautstärke.', def: true },
  { id: 'pauseMode', group: 'music', label: 'Pausen-Modus', desc: 'Pause mit Hinweis auf Beamer und Gäste-Seite.', def: true },
  // --- Betrieb ---
  { id: 'emergency', group: 'safety', label: 'Notfall-Playlist', desc: 'Ein Knopf startet eine Ersatz-Playlist.', def: true },
  { id: 'notify', group: 'safety', label: 'Alarm aufs Handy (ntfy)', desc: 'Meldungen bei Problemen.', def: true },
  { id: 'backups', group: 'safety', label: 'Automatische Backups', desc: 'Regelmäßige Sicherung der Datenbank.', def: true },
  { id: 'floodAlarm', group: 'safety', label: 'Flut-Alarm', desc: 'Meldet ungewöhnlich viele Wünsche in kurzer Zeit.', def: true },
  { id: 'passkeys', group: 'safety', label: 'Passkeys (Anmeldung per Fingerabdruck/Gesicht/PIN)', desc: 'Geräte können sich ohne Code-Eintippen anmelden. Der Admin verwaltet sie.', def: true },
  { id: 'testMode', group: 'safety', label: 'Testmodus', desc: 'Geheime Test-Umgebung.', def: true },
  // --- Effekte ---
  { id: 'animations', group: 'visual', label: 'Animationen', desc: 'Übergänge, Einblendungen und Bewegung. Aus = alles ruhig.', def: true },
  { id: 'confetti', group: 'visual', label: 'Konfetti', desc: 'Wenn der Wunsch eines Gastes läuft.', def: true },
  { id: 'countUp', group: 'visual', label: 'Zahlen zählen hoch', desc: 'Animierte Kennzahlen.', def: true },
  { id: 'beamerFx', group: 'visual', label: 'Beamer-Effekte', desc: 'Leuchtende Farbverläufe und bewegte Hintergründe.', def: true },
  { id: 'sounds', group: 'visual', label: 'Töne in der Moderation', desc: 'Klingelton bei neuen Wünschen im Fokus-Modus erlauben.', def: true },
];

const BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f]));
export const isFeature = (id) => id in BY_ID;

export function isOn(id) {
  const o = settings().features?.[id];
  return typeof o === 'boolean' ? o : (BY_ID[id]?.def ?? false);
}

export const allFlags = () => Object.fromEntries(FEATURES.map((f) => [f.id, isOn(f.id)]));
export const onList = () => FEATURES.filter((f) => isOn(f.id)).map((f) => f.id);

// Express-Schutz: ausgeschaltete Funktion -> 404 (sie "existiert" dann nicht)
export const requireFeature = (id) => (req, res, next) => (isOn(id) ? next() : res.status(404).json({ error: 'Diese Funktion ist ausgeschaltet.' }));
