// Bewegung & Effekte. Alles respektiert die Admin-Schalter (html.no-anim / no-confetti) und "Bewegung reduzieren" des Geraets.
const root = document.documentElement;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const animOn = () => !root.classList.contains('no-anim') && !reduced();
export const confettiOn = () => animOn() && !root.classList.contains('no-confetti');
const countOn = () => animOn() && (root.dataset.features || '').split(',').includes('countUp');

// Zahl zaehlt hoch/runter statt zu springen
export function countTo(el, to, { ms = 700, suffix = '' } = {}) {
  const target = Number(to);
  if (!Number.isFinite(target)) { el.textContent = String(to); return; }
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = String(target);
  if (!countOn() || from === target) { el.textContent = Math.round(target) + suffix; return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - (1 - p) ** 3;
    el.textContent = Math.round(from + (target - from) * e) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Einblenden mit Verzoegerung (Listen "fliessen" herein)
export function stagger(container, step = 40) {
  if (!animOn()) return;
  [...container.children].slice(0, 20).forEach((c, i) => { c.style.animationDelay = `${i * step}ms`; c.classList.add('pop-in'); });
}
export const flash = (el, cls = 'flash') => { if (!animOn() || !el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

// Konfetti auf einer Zeichenflaeche ueber der Seite
export function confetti({ x = 0.5, y = 0.35, count = 90, ms = 2600 } = {}) {
  if (!confettiOn()) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti-cv';
  cv.width = innerWidth; cv.height = innerHeight;
  document.body.append(cv);
  const g = cv.getContext('2d');
  const cols = [getComputedStyle(root).getPropertyValue('--accent').trim() || '#111', '#f5c542', '#ef476f', '#06d6a0', '#118ab2', '#ffffff'];
  const ps = Array.from({ length: count }, () => ({
    x: x * cv.width, y: y * cv.height, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[(Math.random() * cols.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (t) => {
    const k = (t - t0) / ms;
    g.clearRect(0, 0, cv.width, cv.height);
    for (const p of ps) {
      p.vy += 0.38; p.vx *= 0.995; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.globalAlpha = Math.max(0, 1 - k * k); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    if (k < 1) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

// Kurzer Ton (nur wenn der Admin "Töne" erlaubt und der Nutzer es eingeschaltet hat)
let ac;
export const soundsAllowed = () => (root.dataset.features || '').split(',').includes('sounds');
export function chime(kind = 'new') {
  if (!soundsAllowed()) return;
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'new' ? [660, 880] : [440];
    notes.forEach((f, i) => {
      const o = ac.createOscillator(), gn = ac.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(gn); gn.connect(ac.destination);
      const t = ac.currentTime + i * 0.12;
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.18, t + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.start(t); o.stop(t + 0.3);
    });
  } catch { /* egal */ }
}
