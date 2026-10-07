// Simulierter Spotify-Ersatz fuer Entwicklung und Testmodus: eigener Katalog, simulierte Wiedergabe.
const CATALOG = [
  ['Blinding Lights', 'The Weeknd', 200, 0], ['Levitating', 'Dua Lipa', 203, 0], ['Shape of You', 'Ed Sheeran', 233, 0],
  ['Uptown Funk', 'Mark Ronson & Bruno Mars', 270, 0], ['Dance Monkey', 'Tones and I', 210, 0], ['Bad Guy', 'Billie Eilish', 194, 1],
  ['Don\'t Start Now', 'Dua Lipa', 183, 0], ['Watermelon Sugar', 'Harry Styles', 174, 0], ['As It Was', 'Harry Styles', 167, 0],
  ['Flowers', 'Miley Cyrus', 200, 0], ['Anti-Hero', 'Taylor Swift', 200, 0], ['Shake It Off', 'Taylor Swift', 219, 0],
  ['Happier Than Ever', 'Billie Eilish', 298, 1], ['Sunflower', 'Post Malone & Swae Lee', 158, 0], ['Rockstar', 'Post Malone', 218, 1],
  ['Havana', 'Camila Cabello', 217, 0], ['Senorita', 'Shawn Mendes & Camila Cabello', 191, 0], ['Perfect', 'Ed Sheeran', 263, 0],
  ['Cheap Thrills', 'Sia', 211, 0], ['Titanium', 'David Guetta & Sia', 245, 0], ['Wake Me Up', 'Avicii', 247, 0],
  ['Levels', 'Avicii', 202, 0], ['Mr. Brightside', 'The Killers', 222, 0], ['Sweet Caroline', 'Neil Diamond', 201, 0],
  ['Atemlos durch die Nacht', 'Helene Fischer', 218, 0], ['Layla', 'DJ Robin & Schürze', 190, 0], ['Cordula Grün', 'Josh.', 180, 0],
  ['Roller', 'Apache 207', 196, 1], ['Major Tom', 'Peter Schilling', 289, 0], ['99 Luftballons', 'Nena', 230, 0],
  ['Dancing Queen', 'ABBA', 231, 0], ['Mamma Mia', 'ABBA', 212, 0], ['September', 'Earth, Wind & Fire', 215, 0],
  ['Stayin\' Alive', 'Bee Gees', 285, 0], ['Where Is The Love?', 'Black Eyed Peas', 273, 0], ['I Gotta Feeling', 'Black Eyed Peas', 289, 0],
  ['Party Rock Anthem', 'LMFAO', 263, 0], ['Gangnam Style', 'PSY', 219, 0], ['Despacito', 'Luis Fonsi', 229, 0],
  ['Lose Yourself', 'Eminem', 326, 1], ['Mockingbird', 'Eminem', 251, 1], ['Thunder', 'Imagine Dragons', 187, 0],
  ['Believer', 'Imagine Dragons', 204, 0], ['Radioactive', 'Imagine Dragons', 187, 0], ['Counting Stars', 'OneRepublic', 257, 0],
].map(([title, artist, sec, explicit], i) => ({
  id: `mock${String(i + 1).padStart(3, '0')}`,
  uri: `mock:track:${i + 1}`,
  title, artist, album: 'Mock-Album', explicit: !!explicit, durationMs: sec * 1000,
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
