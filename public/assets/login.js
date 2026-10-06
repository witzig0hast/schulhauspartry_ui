import { h, api, BASE, topbar, safe, icon, $ } from '/assets/app.js';

const app = $('#app');
const input = h('input', { type: 'password', placeholder: 'Code oder Passwort', autocomplete: 'current-password', autofocus: true, style: 'height:52px;font-size:1rem;text-align:center;letter-spacing:.08em' });
const err = h('div', { class: 'small', style: 'color:var(--bad);min-height:1.2em;text-align:center' });
const submit = safe(async () => {
  err.textContent = '';
  try {
    const out = await api('/login', { method: 'POST', body: { secret: input.value } });
    const next = new URLSearchParams(location.search).get('next');
    const safeNext = next && next.startsWith(BASE + '/') && !next.startsWith('//') ? next : null;
    location.href = safeNext || BASE + out.home;
  } catch (e) { err.textContent = e.message; input.select(); }
});
app.append(
  topbar('Anmeldung', { live: false }),
  h('div', { class: 'wrap narrow', style: 'padding-top:12vh' },
    h('form', { class: 'card stack', style: 'padding:30px;gap:18px', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('div', { class: 'stack', style: 'gap:6px;text-align:center;justify-items:center' },
        h('div', { class: 'brand' }, h('div', { class: 'logo', style: 'width:46px;height:46px;border-radius:14px' }, icon('logo'))),
        h('h2', { style: 'font-size:1.4rem' }, 'Willkommen zurück'),
        h('p', { class: 'muted small' }, 'Gib deinen persönlichen Code oder das Admin-Passwort ein.')),
      input, err, h('button', { class: 'primary', type: 'submit', style: 'height:50px;font-size:1rem' }, 'Anmelden'))),
);
