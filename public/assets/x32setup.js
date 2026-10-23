import { h, api, clear, modal, toast, safe } from '/assets/app.js';

// X32 einrichten: Adresse des Pults, Kanaele per Pegel erkennen, Fader-Tempo und sanfter Fader-Test.
// Alles laeuft ueber die Umgebung mit den echten Verbindungen; im simulierten Modus mit erfundenen Pegeln.

const pad = (n) => String(n).padStart(2, '0');
const chLabel = (c) => `Ch ${pad(c.channel)}${c.name ? ` · ${c.name}` : ''}`;
const field = (label, input) => h('label', { class: 'field' }, label, input);

// Adresse des X32: Eingabe, Speichern, Suche im Netz des Pi, Verbindung pruefen (auch in der Karte "X32 / Pi 5")
export function x32AddressBox(s, save) {
  const host = h('input', { value: s.x32.host || '', placeholder: 'leer = Adresse aus der .env des Pi', inputmode: 'decimal', maxlength: 15, 'aria-label': 'IP-Adresse des X32' });
  const port = h('input', { type: 'number', value: s.x32.port || 10023, min: 1, max: 65535, style: 'width:100px', 'aria-label': 'OSC-Port des X32' });
  const info = h('div', { class: 'stack', style: 'gap:6px' });
  const want = () => ({ host: host.value.trim(), port: Number(port.value) || 10023 });
  const dirty = () => want().host !== (s.x32.host || '') || want().port !== (s.x32.port || 10023);
  const store = async () => { await api('/admin/settings', { method: 'POST', body: { x32: want() } }); Object.assign(s.x32, want()); };
  const check = safe(async () => {
    if (dirty()) { await store(); toast('X32-Adresse gespeichert'); }
    clear(info).append(h('div', { class: 'small muted' }, 'Frage den Pi …'));
    const st = await api('/admin/x32/status');
    clear(info).append(h('div', { class: 'row small' },
      h('span', { class: st.deskOk ? 'badge ok' : 'badge warn' }, st.deskOk ? 'Pult antwortet' : 'Pult antwortet nicht'),
      h('span', {}, st.host ? `Pi spricht mit ${st.host}:${st.port} (${st.source === 'admin' ? 'hier eingestellt' : 'aus der .env des Pi'})` : 'Das Relay auf dem Pi ist zu alt und meldet keine Adresse – auf dem Pi aktualisieren.')));
    return st;
  });
  const search = safe(async () => {
    clear(info).append(h('div', { class: 'small muted' }, 'Suche im Netz des Pi (ca. 2 s) …'));
    const { found } = await api('/admin/x32/discover', { method: 'POST', body: {} });
    clear(info).append(found.length
      ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small muted' }, `${found.length} Pult${found.length > 1 ? 'e' : ''} gefunden:`),
        ...found.map((f) => h('div', { class: 'row between' }, h('span', {}, h('strong', {}, f.name || 'X32'), ` ${f.model || ''} · ${f.host}${f.version ? ` · Firmware ${f.version}` : ''}`),
          h('button', { class: 'small primary', onclick: async () => { host.value = f.host; port.value = 10023; await check(); } }, 'Übernehmen'))))
      : h('div', { class: 'small' }, 'Kein Pult gefunden. Ist das X32 eingeschaltet und per Netzwerkkabel im selben Netz wie der Pi? Dann die Adresse am Pult nachsehen (Setup → Network) und hier eintragen.'));
  });
  const el = h('div', { class: 'stack', style: 'gap:8px' },
    h('div', { class: 'row' }, field('IP-Adresse', host), field('Port', port),
      h('button', { class: 'small primary', onclick: () => save({ x32: want() }, want().host ? `X32-Adresse ${want().host} gespeichert – der Pi nutzt sie sofort` : 'X32-Adresse zurückgesetzt (gilt wieder die vom Pi)') }, 'Adresse speichern'),
      h('button', { class: 'small', onclick: search }, 'Im Netz suchen'), h('button', { class: 'small', onclick: check }, 'Verbindung prüfen')),
    info);
  return { el, want, check };
}

export function openX32Setup({ settings: s, save }) {
  const x = s.x32;
  const pick = { p1: [...x.channels.p1], p2: [...x.channels.p2], mics: [...x.channels.mics] };
  let speed = x.faderSpeed || 'normal';
  let chans = [], simulated = false, step = 0, alive = true;
  const names = () => Object.fromEntries(chans.map((c) => [c.channel, c.name]));

  // Kanal-Auswahl (mit Namen vom Pult)
  const chSelect = (val, onChange) => {
    const sel = h('select', { onchange: () => onChange(sel.value ? Number(sel.value) : null) },
      h('option', { value: '' }, '–'), ...Array.from({ length: 32 }, (_, i) => h('option', { value: i + 1, selected: val === i + 1 }, chLabel({ channel: i + 1, name: names()[i + 1] }))));
    return sel;
  };
  // Pegel messen: ca. 3 s lang Durchschnitt pro Kanal
  const measure = async (ms = 3000) => {
    const sum = new Array(33).fill(0); let n = 0;
    for (const end = Date.now() + ms; Date.now() < end;) {
      const r = await api('/admin/x32/channels');
      for (const c of r.channels) sum[c.channel] += c.level || 0;
      n++; await new Promise((res) => setTimeout(res, 450));
    }
    return sum.map((v, ch) => ({ ch, v: n ? v / n : 0 })).slice(1).sort((a, b) => b.v - a.v);
  };
  const others = (key, idx) => Object.entries(pick).flatMap(([k, list]) => list.filter((c, i) => c && !(k === key && (idx == null || i === idx))));

  // Live-Uebersicht der 32 Kanaele
  const grid = h('div', { class: 'x32-grid' });
  const drawGrid = () => {
    const tag = (ch) => (pick.p1.includes(ch) ? 'P1' : pick.p2.includes(ch) ? 'P2' : pick.mics.includes(ch) ? `Mic ${pick.mics.indexOf(ch) + 1}` : '');
    clear(grid).append(...chans.map((c) => h('button', { class: `x32-ch${tag(c.channel) ? ' on' : ''}${c.on === false ? ' muted' : ''}`, title: `${chLabel(c)} – am Pult anwählen`, onclick: () => api('/admin/x32/select', { method: 'POST', body: { channel: c.channel } }).catch((e) => toast(e.message, true)) },
      h('span', { class: 'x32-n' }, pad(c.channel)), h('span', { class: 'x32-name' }, c.name || ' '),
      h('span', { class: 'x32-meter' }, h('i', { style: `height:${Math.round(Math.min(1, c.level * 1.6) * 100)}%` })),
      h('span', { class: 'x32-tag' }, tag(c.channel) || ' '))));
  };
  const poll = async () => {
    while (alive) {
      try {
        const r = await api('/admin/x32/channels');
        const first = !chans.length;
        chans = r.channels; simulated = !!r.simulated;
        if (first && step !== 0) render(); else drawGrid();   // Kanalnamen in die Auswahllisten uebernehmen
      } catch { /* naechster Versuch */ }
      await new Promise((res) => setTimeout(res, 700));
    }
  };

  const body = h('div', { class: 'stack' });
  const stepper = h('div', { class: 'stepper' });
  const nav = h('div', { class: 'row between' });
  const STEPS = ['Verbindung', 'Player', 'Mikrofone', 'Fader', 'Fertig'];
  const testMusic = (n) => h('button', { class: 'small', onclick: safe(async () => { const t = await api('/admin/x32/test-music', { method: 'POST', body: { player: n } }); toast(`Player ${n} spielt: ${t.title} – ${t.artist}`); }) }, `Testmusik Player ${n}`);
  const stopMusic = () => h('button', { class: 'small', onclick: safe(async () => { await api('/admin/x32/test-music', { method: 'POST', body: { stop: true } }); }) }, 'Testmusik stoppen');

  const views = [
    () => {
      const addr = x32AddressBox(s, save);
      if (x.adapter === 'http') setTimeout(() => addr.check(), 0);
      return [h('p', { class: 'small muted' }, 'Zuerst muss der Pi das Pult erreichen. Das X32 hängt per Netzwerkkabel im selben Netz wie der Pi; seine Adresse steht am Pult unter Setup → Network. „Im Netz suchen“ findet es meist von selbst.'),
        x.adapter === 'http' ? addr.el : h('div', { class: 'small' }, h('span', { class: 'badge warn' }, 'Simuliert'), ' Unter „Anbindung“ ist noch „Simuliert“ gewählt. Du kannst den Assistenten trotzdem durchspielen; für das echte Pult zuerst „Pi 5 / X32 über HTTP-Relay“ mit Pi-URL und Token speichern.')];
    },
    () => {
      const row = (n) => {
        const key = `p${n}`, info = h('span', { class: 'small muted' }, '');
        const sels = [0, 1].map((i) => chSelect(pick[key][i], (v) => { pick[key][i] = v; pick[key] = pick[key].filter(Boolean); drawGrid(); }));
        const detect = safe(async () => {
          info.textContent = 'Messe 3 s …';
          const top = (await measure()).filter((m) => !others(key).includes(m.ch));
          if (!top.length || top[0].v < 0.01) { info.textContent = 'Kein Signal erkannt. Läuft die Testmusik? Ist der Kanal am Pult offen?'; return; }
          pick[key] = top[1] && top[1].v >= top[0].v * 0.4 ? [top[0].ch, top[1].ch].sort((a, b) => a - b) : [top[0].ch];
          info.textContent = `Erkannt: Kanal ${pick[key].join(' / ')}`;
          render();
        });
        return h('div', { class: 'card stack', style: 'gap:8px' }, h('strong', {}, `Player ${n}`),
          h('div', { class: 'small muted' }, `1. „Testmusik Player ${n}“ drücken (oder auf dem Rechner von Player ${n} etwas abspielen). 2. „Erkennen“ – die App sucht die Kanäle mit Pegel. Stereo = zwei Kanäle (links/rechts).`),
          h('div', { class: 'row' }, testMusic(n), h('button', { class: 'small primary', onclick: detect }, 'Erkennen'), info),
          h('div', { class: 'row' }, field('Kanal links / mono', sels[0]), field('Kanal rechts', sels[1])));
      };
      return [h('p', { class: 'small muted' }, 'Auf welchen Kanalzügen (Ch 01–32) liegen die beiden Player? Welche Buchse auf welchem Kanal landet, legst du am Pult fest (Kanal anwählen → Config → Source: Local, Aux In, Card …). Ein Klick auf einen Kanal unten wählt ihn am Pult an, ohne einen Fader zu bewegen.'),
        row(1), row(2), stopMusic(), grid];
    },
    () => {
      const row = (i) => {
        const info = h('span', { class: 'small muted' }, '');
        const sel = chSelect(pick.mics[i], (v) => { pick.mics[i] = v; drawGrid(); });
        const detect = safe(async () => {
          info.textContent = 'Jetzt ins Mikrofon sprechen … (3 s)';
          const top = (await measure()).filter((m) => !others('mics', i).includes(m.ch));
          if (!top.length || top[0].v < 0.02) { info.textContent = 'Nichts gehört. Ist das Mikro an und der Kanal offen (nicht gemutet)?'; return; }
          pick.mics[i] = top[0].ch; info.textContent = `Erkannt: Kanal ${top[0].ch}${names()[top[0].ch] ? ` (${names()[top[0].ch]})` : ''}`;
          render();
        });
        return h('div', { class: 'row' }, h('strong', { style: 'min-width:70px' }, `Mikro ${i + 1}`), sel, h('button', { class: 'small primary', onclick: detect }, 'Erkennen'), h('button', { class: 'small', onclick: () => { pick.mics[i] = null; render(); } }, 'Nicht benutzt'), info);
      };
      return [h('p', { class: 'small muted' }, 'Für jedes Mikrofon: „Erkennen“ drücken und ein paar Sekunden hineinsprechen. Die App merkt sich den Kanal, um anzuzeigen, wann jemand spricht (und um die Musik dabei abzusenken, falls Ducking an ist). Musik vorher stoppen.'),
        row(0), row(1), row(2), grid];
    },
    () => {
      const sel = h('select', { onchange: () => { speed = sel.value; } },
        ...[['sanft', 'Sanft – schont den Motor am meisten, kurze Blenden etwas träger'], ['normal', 'Normal – empfohlen'], ['schnell', 'Schnell – folgt kurzen Blenden genau']].map(([v, t]) => h('option', { value: v, selected: speed === v }, t)));
      const ft = (n) => h('button', { class: 'small', onclick: safe(async () => { await api('/admin/x32/fader-test', { method: 'POST', body: { player: n } }); toast(`Fader von Player ${n} fahren sanft auf −10 dB und nach 3 s zurück`); }) }, `Fader-Test Player ${n}`);
      return [h('p', { class: 'small muted' }, 'Die Motorfader fahren neue Werte jetzt gleichmäßig an, statt zu springen. Die App schickt höchstens 8 Befehle pro Sekunde und das Relay auf dem Pi fährt dazwischen in kleinen Schritten. Bewegt jemand einen Fader von Hand, hat die Hand 3 s Vorrang; danach fährt der Fader sanft zurück. Dauerhafte Änderungen gehören ins Pegel-Fenster. Beim Not-Aus gehen die Fader sofort auf null.'),
        field('Tempo der Motorfader', sel),
        h('div', { class: 'small muted' }, 'Fader-Test: Der Fader fährt sanft auf −10 dB und zurück. Erst testen, wenn die richtigen Kanäle gespeichert sind (Schritt „Fertig“) – oder jetzt mit der bisherigen Zuordnung.'),
        h('div', { class: 'row' }, ft(1), ft(2))];
    },
    () => {
      const mics = pick.mics.filter(Boolean);
      const takeNames = h('input', { type: 'checkbox', checked: mics.some((c) => names()[c]) });
      const line = (label, list) => h('div', { class: 'row between' }, h('span', {}, label), h('strong', {}, list.length ? list.map((c) => chLabel({ channel: c, name: names()[c] })).join(', ') : 'nicht benutzt'));
      const finish = safe(async () => {
        if (!pick.p1.length || !pick.p2.length) throw new Error('Beide Player brauchen mindestens einen Kanal.');
        const patch = { faderSpeed: speed, channels: { p1: pick.p1, p2: pick.p2, mics: mics.length ? mics : x.channels.mics } };
        if (takeNames.checked) patch.micNames = [0, 1, 2].map((i) => names()[mics[i]] || x.micNames?.[i] || `Mic ${i + 1}`);
        alive = false; close();
        save({ x32: patch }, 'X32 eingerichtet');
      });
      return [line('Player 1', pick.p1.filter(Boolean)), line('Player 2', pick.p2.filter(Boolean)), line('Mikrofone', mics),
        h('div', { class: 'row between' }, h('span', {}, 'Tempo der Motorfader'), h('strong', {}, speed)),
        h('label', { class: 'row small' }, takeNames, 'Namen der Mikrofone vom Pult übernehmen'),
        !mics.length ? h('div', { class: 'small muted' }, 'Keine Mikrofone gewählt – die bisherige Zuordnung bleibt.') : h('span'),
        h('button', { class: 'primary', onclick: finish }, 'Speichern')];
    },
  ];

  const render = () => {
    clear(stepper).append(...STEPS.map((t, i) => h('button', { class: `wz-step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`, onclick: () => { step = i; render(); } }, `${i + 1}. ${t}`)));
    clear(body).append(...views[step]());
    if (simulated) body.prepend(h('div', { class: 'small' }, h('span', { class: 'badge warn' }, 'Simuliert'), ' Pegel und Namen sind erfunden, solange keine echte Pult-Verbindung besteht.'));
    clear(nav).append(step > 0 ? h('button', { onclick: () => { step--; render(); } }, 'Zurück') : h('span'),
      step < STEPS.length - 1 ? h('button', { class: 'primary', onclick: () => { step++; render(); } }, 'Weiter') : h('span'));
    drawGrid();
  };
  const close = modal(h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h2', {}, 'X32 einrichten'), h('button', { class: 'small', onclick: () => { alive = false; close(); } }, 'Schließen')), stepper, body, nav), { wide: true, sticky: true });
  render();
  poll();
}
