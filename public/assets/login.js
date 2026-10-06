import { h, api, BASE, topbar, safe, $ } from '/assets/app.js';

const app = $('#app');
const input = h('input', { type: 'password', placeholder: 'Code oder Passwort', autocomplete: 'current-password', autofocus: true });
const err = h('div', { class: 'small', style: 'color:var(--bad)' });
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
  topbar('Anmelden'),
  h('div', { class: 'wrap narrow' }, h('form', { class: 'card stack', onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('p', { class: 'muted' }, 'Gib deinen Code oder das Admin-Passwort ein.'),
    input, err, h('button', { class: 'primary', type: 'submit' }, 'Anmelden'))),
);
