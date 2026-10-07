// Spotify-Genres sind sehr fein ("german hip hop", "dance pop"). Fuer Auswertungen fassen wir sie zu Familien zusammen.
const RULES = [
  ['Schlager & Deutsch', /schlager|volksmusik|partyschlager|austropop|neue deutsche welle|deutschrock|german pop|deutschpop|apres-ski|ballermann/],
  ['Hip-Hop & Rap', /hip hop|hip-hop|rap|trap|drill|grime/],
  ['R&B & Soul', /r&b|rhythm and blues|soul|motown|neo soul/],
  ['Electronic & Dance', /edm|house|techno|trance|electro|dubstep|drum and bass|dance|eurodance|synthwave|big room|future bass|disco/],
  ['Latin', /latin|reggaeton|salsa|bachata|cumbia|urbano/],
  ['Rock & Metal', /rock|metal|punk|grunge|emo|hard|alternative|indie/],
  ['Pop', /pop|europop|synthpop|k-pop|j-pop|boy band|girl group/],
  ['Funk & Disco', /funk|disco/],
  ['Reggae & Dancehall', /reggae|dancehall|ska/],
  ['Country & Folk', /country|folk|bluegrass|americana/],
  ['Jazz & Klassik', /jazz|swing|blues|classical|orchestra|opera|baroque/],
];

export const UNKNOWN = 'Unbekannt';

// Eine Familie pro Genre-String; Reihenfolge der Regeln entscheidet bei Mehrdeutigkeit.
export function genreFamily(genre) {
  const g = String(genre || '').toLowerCase();
  for (const [name, re] of RULES) if (re.test(g)) return name;
  return 'Sonstige';
}

// Alle Familien eines Tracks (jede nur einmal); ohne Genres -> Unbekannt
export function familiesOf(genres) {
  if (!genres?.length) return [UNKNOWN];
  return [...new Set(genres.map(genreFamily))];
}

export const decadeOf = (year) => (year ? `${Math.floor(year / 10) * 10}er` : null);
