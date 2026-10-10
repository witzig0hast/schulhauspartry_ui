import { h, api, BASE, topbar, safe, brandLogo, $, passkeysSupported, passkeyLogin } from '/assets/app.js';

const app = $('#app');
const input = h('input', { type: 'password', placeholder: 'Code oder Passwort', autocomplete: 'current-password', autofocus: true, style: 'height:52px;font-size:1rem;text-align:center;letter-spacing:.08em' });
const err = h('div', { class: 'small', style: 'color:var(--bad);min-height:1.2em;text-align:center' });
const go = (out) => {
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && next.startsWith(BASE + '/') && !next.startsWith('//') ? next : null;
  location.href = safeNext || BASE + out.home;
};
const submit = safe(async () => {
  err.textContent = '';
  try { go(await api('/login', { method: 'POST', body: { secret: input.value } })); } catch (e) { err.textContent = e.message; input.select(); }
});
const pk = passkeysSupported() ? h('button', { type: 'button', class: 'passkey-btn', onclick: async () => {
  err.textContent = '';
  try { go(await passkeyLogin()); } catch (e) { err.textContent = e.name === 'NotAllowedError' ? 'Abgebrochen.' : e.message; }
} }, h('span', { 'aria-hidden': 'true' }, '🔑'), ' Mit Passkey anmelden') : null;
// Single Sign-On (nur wenn der Admin es eingerichtet hat)
const SSO_ERR = { denied: 'Die Anmeldung wurde abgebrochen.', failed: 'Die SSO-Anmeldung ist fehlgeschlagen. Bitte noch einmal versuchen.', expired: 'Die Anmeldung ist abgelaufen. Bitte noch einmal starten.', norole: 'Dein Konto hat hier keinen Zugang (keine passende Gruppe). Wende dich an den Admin.', locked: 'Dieses Konto wurde gesperrt.', nolink: 'Zu diesem SSO-Konto gibt es keinen verbundenen Zugang. Melde dich einmal mit deinem Code an und verbinde ihn über das 🔑-Symbol mit SSO.', passkeyonly: 'Der Admin-Login ist nur mit Passkey erlaubt.', taken: 'Dieses SSO-Konto ist schon mit einem anderen Zugang verbunden.', adminip: 'Admin-Anmeldung ist von dieser Adresse aus nicht erlaubt.', config: 'SSO ist nicht richtig eingerichtet.' };
const urlErr = new URLSearchParams(location.search).get('error');
if (urlErr && SSO_ERR[urlErr]) err.textContent = SSO_ERR[urlErr];
const ssoBox = h('div', { class: 'stack hidden', style: 'gap:18px' });
api('/sso/config').then((c) => {
  if (!c.enabled) return;
  const next = new URLSearchParams(location.search).get('next');
  const q = next && next.startsWith(BASE + '/') && !next.startsWith('//') ? `?next=${encodeURIComponent(next.slice(BASE.length))}` : '';
  ssoBox.classList.remove('hidden');
  ssoBox.append(h('a', { class: 'btn passkey-btn', href: `${BASE}/api/sso/login${q}`, style: 'display:flex;align-items:center;justify-content:center;text-decoration:none' }, '🔐 ', c.label || 'Mit SSO anmelden'), h('div', { class: 'or' }, 'oder mit Code'));
}).catch(() => {});

app.append(
  topbar('Anmeldung', { live: false }),
  h('div', { class: 'wrap narrow', style: 'padding-top:12vh' },
    h('form', { class: 'card stack rise', style: 'padding:30px;gap:18px', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('div', { class: 'stack', style: 'gap:6px;text-align:center;justify-items:center' },
        h('div', { class: 'brand' }, brandLogo('width:46px;height:46px;border-radius:14px')),
        h('h2', { style: 'font-size:1.4rem' }, 'Willkommen zurück'),
        h('p', { class: 'muted small' }, 'Gib deinen persönlichen Code oder das Admin-Passwort ein' + (pk ? ' – oder melde dich mit Passkey an.' : '.'))),
      ssoBox, pk, pk ? h('div', { class: 'or' }, 'oder') : null,
      input, err, h('button', { class: 'primary', type: 'submit', style: 'height:50px;font-size:1rem' }, 'Anmelden'))),
);
