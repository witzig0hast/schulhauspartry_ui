// Gemeinsamer Anfrage-Regler fuer die Spotify-Web-API.
//
// Spotify begrenzt Anfragen pro App in einem gleitenden Zeitfenster (ca. 30 s) und antwortet bei
// Ueberschreitung mit HTTP 429 + Retry-After. Das Limit selbst laesst sich nicht abschalten -- deshalb
// bleiben wir bewusst weit darunter und reagieren sauber, falls es doch einmal greift:
//   * ein Budget fuer alle Anfragen der App (Suche, Player, Steuerbefehle zusammen)
//   * Vorrang: Steuerbefehle (Play/Pause/Queue) > Player-Abfragen > Suche
//   * nach einem 429 ruhen alle unkritischen Anfragen bis Retry-After vorbei ist
export class RateLimitError extends Error {
  constructor(retryAfterMs, why = 'limit') {
    super(`Spotify-Limit (${why}) – bitte ${Math.ceil(retryAfterMs / 1000)} s warten`);
    this.name = 'RateLimitError'; this.status = 429; this.retryAfterMs = retryAfterMs; this.why = why;
  }
}

// Anteil des Budgets, bis zu dem eine Klasse noch Anfragen stellen darf
const SHARE = { critical: 1, poll: 0.8, search: 0.6 };

export class Governor {
  constructor({ windowMs = 30000, budget = 60, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.windowMs = windowMs; this.budget = budget; this.now = now; this.sleep = sleep;
    this.stamps = []; this.pausedUntil = 0;
    this.stats = { total: 0, rejected: 0, rate429: 0, cacheHits: 0, coalesced: 0 };
    this.last429 = 0;
  }
  setBudget(n) { this.budget = Math.max(10, Math.min(500, Number(n) || 60)); }
  _prune() { const cut = this.now() - this.windowMs; while (this.stamps.length && this.stamps[0] <= cut) this.stamps.shift(); }
  used() { this._prune(); return this.stamps.length; }
  pausedMs() { return Math.max(0, this.pausedUntil - this.now()); }

  // Darf jetzt eine Anfrage raus? Unkritische werden abgewiesen (Aufrufer nutzt Cache), kritische warten.
  async acquire(cls = 'search') {
    const limit = Math.floor(this.budget * (SHARE[cls] ?? SHARE.search));
    for (let guard = 0; guard < 8; guard++) {
      const paused = this.pausedMs();
      if (paused > 0) {
        if (cls !== 'critical') { this.stats.rejected++; throw new RateLimitError(paused, 'pause'); }
        await this.sleep(Math.min(paused, 30000)); continue;
      }
      this._prune();
      if (this.stamps.length >= limit) {
        if (cls !== 'critical') { this.stats.rejected++; throw new RateLimitError(Math.max(500, this.stamps[0] + this.windowMs - this.now()), 'budget'); }
        await this.sleep(Math.max(100, Math.min(this.stamps[0] + this.windowMs - this.now() + 50, 5000))); continue;
      }
      this.stamps.push(this.now()); this.stats.total++;
      return;
    }
    throw new RateLimitError(1000, 'budget');
  }

  // Spotify hat 429 gemeldet: alle ruhen bis Retry-After (+ kleiner Puffer)
  onRateLimited(retryAfterSec) {
    const sec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 2;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + sec * 1000 + 250);
    this.stats.rate429++; this.last429 = this.now();
  }

  snapshot() {
    return { used: this.used(), budget: this.budget, windowSec: this.windowMs / 1000, pausedSec: Math.ceil(this.pausedMs() / 1000), ...this.stats, last429: this.last429 || null };
  }
}

// Ein Regler pro Prozess: das Limit gilt pro Spotify-App, nicht pro Umgebung.
export const governor = new Governor();
