import { h, BASE, feat } from '/assets/app.js';

// Fertige Dashboards fuer die Abteilungen – oben in jedem Dashboard zum schnellen Wechseln
export const DEPTS = [
  { id: 'ton', label: '🎚 Ton', path: '/ton', roles: ['admin', 'tech', 'orga', 'display'], f: 'viewTon' },
  { id: 'licht', label: '💡 Licht', path: '/light', roles: ['admin', 'tech', 'orga', 'display', 'light'], f: 'viewLight' },
  { id: 'buehne', label: '🎤 Bühne', path: '/stage', roles: ['admin', 'tech', 'mod', 'dj', 'orga', 'display'], f: 'viewStage' },
  { id: 'orga', label: '📋 Orga', path: '/orga', roles: ['admin', 'tech', 'mod', 'dj', 'orga', 'display'], f: 'viewOrga' },
];

export function deptBar(current, role) {
  const list = DEPTS.filter((d) => d.roles.includes(role) && feat(d.f));
  if (list.length < 2) return h('span');
  return h('nav', { class: 'dept-bar', 'aria-label': 'Dashboards' }, ...list.map((d) => h('a', { class: `dept ${d.id === current ? 'on' : ''}`, href: BASE + d.path, 'aria-current': d.id === current ? 'page' : null }, d.label)));
}
