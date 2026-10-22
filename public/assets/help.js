import { h } from '/assets/app.js';

// ⓘ-Symbole: kleine Erklaerungen zu Einstellungen. Ein Klick (oder Fokus + Enter) oeffnet die Erklaerung, Esc/Klick daneben schliesst.
let open = null;
const closeOpen = () => { if (open) { open.bubble.remove(); open.btn.setAttribute('aria-expanded', 'false'); open = null; } };
addEventListener('click', (e) => { if (open && !open.bubble.contains(e.target) && e.target !== open.btn) closeOpen(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpen(); });
addEventListener('scroll', closeOpen, true);
let seq = 0;

export function info(text) {
  const id = `help-${++seq}`;
  const btn = h('button', { type: 'button', class: 'info-i', 'aria-label': 'Erklärung anzeigen', 'aria-expanded': 'false', 'aria-describedby': id, title: text }, 'i');
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (open?.btn === btn) return closeOpen();
    closeOpen();
    const bubble = h('div', { class: 'info-bubble', role: 'tooltip', id }, text);
    document.body.append(bubble);
    const r = btn.getBoundingClientRect(), bw = Math.min(340, innerWidth - 24);
    bubble.style.width = `${bw}px`;
    bubble.style.left = `${Math.max(12, Math.min(innerWidth - bw - 12, r.left + r.width / 2 - bw / 2))}px`;
    const below = r.bottom + 8 + bubble.offsetHeight < innerHeight;
    bubble.style.top = `${below ? r.bottom + 8 : r.top - bubble.offsetHeight - 8}px`;
    btn.setAttribute('aria-expanded', 'true');
    open = { btn, bubble };
  });
  return btn;
}

// Erklaerungen automatisch an Felder haengen: Schluessel = Beschriftung des Feldes (Anfang reicht)
export function autoHelp(root, dict) {
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  const apply = (scope) => {
    for (const label of scope.querySelectorAll('label.field, label.check, .card h2, .help-host')) {
      if (label.dataset.help) continue;
      const tn = [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!tn) continue;
      const text = tn.textContent.trim();
      const key = keys.find((k) => text === k || (k.length >= 12 && text.startsWith(k)));   // kurze Schluessel nur exakt
      if (!key) continue;
      label.dataset.help = '1';
      // Beschriftung und ⓘ in einer Zeile halten
      const wrap = h('span', { class: 'help-l' }, tn.textContent.replace(/\s+$/, ''), info(dict[key]));
      tn.replaceWith(wrap);
    }
  };
  apply(root);
  new MutationObserver(() => apply(root)).observe(root, { childList: true, subtree: true });
}
