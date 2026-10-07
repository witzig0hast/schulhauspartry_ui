// Simulierter Spotify-Ersatz fuer Entwicklung und Testmodus: eigener Katalog, simulierte Wiedergabe.
// [Titel, Interpret(en), Sekunden, explicit, Genres, Jahr, Beliebtheit]
const RAW = [
  ['Blinding Lights', 'The Weeknd', 200, 0, ['canadian contemporary r&b', 'pop'], 2019, 92], ['Levitating', 'Dua Lipa', 203, 0, ['dance pop', 'pop'], 2020, 88],
  ['Shape of You', 'Ed Sheeran', 233, 0, ['pop', 'uk pop'], 2017, 90], ['Uptown Funk', 'Mark Ronson, Bruno Mars', 270, 0, ['funk', 'dance pop'], 2014, 85],
  ['Dance Monkey', 'Tones and I', 210, 0, ['pop', 'australian pop'], 2019, 84], ['Bad Guy', 'Billie Eilish', 194, 1, ['electropop', 'pop'], 2019, 87],
  ["Don't Start Now", 'Dua Lipa', 183, 0, ['dance pop', 'pop'], 2019, 86], ['Watermelon Sugar', 'Harry Styles', 174, 0, ['pop'], 2019, 85],
  ['As It Was', 'Harry Styles', 167, 0, ['pop'], 2022, 90], ['Flowers', 'Miley Cyrus', 200, 0, ['pop'], 2023, 89],
  ['Anti-Hero', 'Taylor Swift', 200, 0, ['pop'], 2022, 88], ['Shake It Off', 'Taylor Swift', 219, 0, ['pop'], 2014, 80],
  ['Happier Than Ever', 'Billie Eilish', 298, 1, ['electropop', 'pop'], 2021, 82], ['Sunflower', 'Post Malone, Swae Lee', 158, 0, ['hip hop', 'rap'], 2018, 86],
  ['Rockstar', 'Post Malone', 218, 1, ['hip hop', 'rap'], 2017, 84], ['Havana', 'Camila Cabello', 217, 0, ['pop', 'latin pop'], 2017, 85],
  ['Senorita', 'Shawn Mendes, Camila Cabello', 191, 0, ['pop', 'latin pop'], 2019, 83], ['Perfect', 'Ed Sheeran', 263, 0, ['pop', 'uk pop'], 2017, 86],
  ['Cheap Thrills', 'Sia', 211, 0, ['pop', 'dance pop'], 2016, 78], ['Titanium', 'David Guetta, Sia', 245, 0, ['edm', 'dance pop'], 2011, 82],
  ['Wake Me Up', 'Avicii', 247, 0, ['edm', 'progressive house'], 2013, 85], ['Levels', 'Avicii', 202, 0, ['edm', 'progressive house'], 2011, 80],
  ['Mr. Brightside', 'The Killers', 222, 0, ['indie rock', 'rock'], 2003, 86], ['Sweet Caroline', 'Neil Diamond', 201, 0, ['classic rock', 'soft rock'], 1969, 80],
  ['Atemlos durch die Nacht', 'Helene Fischer', 218, 0, ['schlager', 'german pop'], 2013, 75], ['Layla', 'DJ Robin, Schürze', 190, 0, ['partyschlager', 'schlager'], 2022, 79],
  ['Cordula Grün', 'Josh.', 180, 0, ['austropop', 'german pop'], 2022, 74], ['Roller', 'Apache 207', 196, 1, ['german hip hop', 'rap'], 2019, 76],
  ['Major Tom', 'Peter Schilling', 289, 0, ['neue deutsche welle', 'synthpop'], 1982, 70], ['99 Luftballons', 'Nena', 230, 0, ['neue deutsche welle', 'new wave'], 1983, 72],
  ['Dancing Queen', 'ABBA', 231, 0, ['disco', 'europop'], 1976, 85], ['Mamma Mia', 'ABBA', 212, 0, ['disco', 'europop'], 1975, 80],
  ['September', 'Earth, Wind & Fire', 215, 0, ['disco', 'funk', 'soul'], 1978, 84], ["Stayin' Alive", 'Bee Gees', 285, 0, ['disco'], 1977, 83],
  ['Where Is The Love?', 'Black Eyed Peas', 273, 0, ['hip hop', 'pop rap'], 2003, 78], ['I Gotta Feeling', 'Black Eyed Peas', 289, 0, ['pop rap', 'dance pop'], 2009, 82],
  ['Party Rock Anthem', 'LMFAO', 263, 0, ['electro house', 'dance pop'], 2011, 80], ['Gangnam Style', 'PSY', 219, 0, ['k-pop', 'dance pop'], 2012, 82],
  ['Despacito', 'Luis Fonsi', 229, 0, ['reggaeton', 'latin pop'], 2017, 84], ['Lose Yourself', 'Eminem', 326, 1, ['hip hop', 'rap'], 2002, 86],
  ['Mockingbird', 'Eminem', 251, 1, ['hip hop', 'rap'], 2004, 80], ['Thunder', 'Imagine Dragons', 187, 0, ['pop rock', 'rock'], 2017, 84],
  ['Believer', 'Imagine Dragons', 204, 0, ['pop rock', 'rock'], 2017, 86], ['Radioactive', 'Imagine Dragons', 187, 0, ['pop rock', 'rock'], 2012, 84],
  ['Counting Stars', 'OneRepublic', 257, 0, ['pop rock', 'pop'], 2013, 84],
];
const CATALOG = RAW.map(([title, artist, sec, explicit, genres, year, popularity], i) => ({
  id: `mock${String(i + 1).padStart(3, '0')}`,
  uri: `mock:track:${i + 1}`,
  title, artist, album: 'Mock-Album', explicit: !!explicit, durationMs: sec * 1000,
  artistIds: artist.split(', ').map((a) => `mockartist:${a}`), genres, year, popularity,
}));

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export class MockSpotify {
  constructor() { this.kind = 'mock'; }
  async search(q, limit = 8) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return CATALOG.filter((t) => { const h = norm(`${t.title} ${t.artist}`); return terms.every((w) => h.includes(w)); }).slice(0, limit);
  }
  async getTrack(id) { return CATALOG.find((t) => t.id === id) || null; }
  async getGenres(track) { return track.genres || []; }
  catalog() { return CATALOG; }
  health() { return { ok: true, detail: 'Mock' }; }
}

export class MockPlayer {
  constructor(speedFn = () => 1) {
    this.kind = 'mock';
    this.speedFn = speedFn;
    this.track = null; this.playing = false; this.posMs = 0; this.lastTs = Date.now();
  }
  _advance() {
    const now = Date.now();
    if (this.playing && this.track) this.posMs = Math.min(this.track.durationMs, this.posMs + (now - this.lastTs) * this.speedFn());
    this.lastTs = now;
  }
  async play(track) { this._advance(); this.track = track; this.posMs = 0; this.playing = true; this.lastTs = Date.now(); }
  reset() { this.track = null; this.playing = false; this.posMs = 0; }
  async pause() { this._advance(); this.playing = false; }
  async resume() { this._advance(); if (this.track) this.playing = true; }
  async poll() { this._advance(); }
  seekTo(ms) { this._advance(); this.posMs = ms; }
  status() {
    this._advance();
    const ended = !!this.track && this.posMs >= this.track.durationMs;
    return {
      connected: true,
      playing: this.playing && !ended,
      ended,
      uri: this.track?.uri || null,
      title: this.track?.title || null,
      artist: this.track?.artist || null,
      positionMs: Math.round(this.posMs),
      durationMs: this.track?.durationMs || 0,
    };
  }
}
