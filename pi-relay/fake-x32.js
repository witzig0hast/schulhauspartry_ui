// Ein simuliertes X32 zum Testen OHNE Pult:   node fake-x32.js
// Dann im Relay X32_HOST=127.0.0.1 (und X32_PORT=10023) eintragen.
// Zeigt jeden Fader-Befehl der App an und simuliert Mikrofone: Mic-Kanaele (Standard 5,6,7) sind "offen" und haben Pegel.
//   MIC_OPEN=5,7     welche Kanaele gerade Signal haben (Standard: keiner)
//   PORT=10023       UDP-Port
import dgram from 'node:dgram';
import { encode, decode, encodeMeters } from './osc.js';

const port = Number(process.env.PORT || 10023);
const open = new Set((process.env.MIC_OPEN || '').split(',').map(Number).filter(Boolean));
const fader = {};
const sock = dgram.createSocket('udp4');

sock.on('message', (msg, rinfo) => {
  let m; try { m = decode(msg); } catch { return; }
  const fm = /^\/ch\/(\d\d)\/mix\/fader$/.exec(m.address);
  if (fm && m.args.length) {
    const ch = Number(fm[1]);
    fader[ch] = m.args[0];
    console.log(`Fader Kanal ${String(ch).padStart(2)} -> ${m.args[0].toFixed(3)}  (${Math.round(m.args[0] * 100)} %)`);
    return;
  }
  const on = /^\/ch\/(\d\d)\/mix\/on$/.exec(m.address);
  if (on) { sock.send(encode(m.address, [{ t: 'i', v: 1 }]), rinfo.port, rinfo.address); return; }
  if (m.address === '/meters') {
    const meters = new Array(70).fill(0);
    for (const c of open) meters[c - 1] = 0.3 + Math.random() * 0.3;
    sock.send(encode('/meters/1', [{ t: 'b', v: encodeMeters(meters) }]), rinfo.port, rinfo.address);
  }
});
sock.bind(port, () => console.log(`Fake-X32 laeuft auf UDP ${port}. Mics mit Signal: ${[...open].join(', ') || 'keine'} (MIC_OPEN=5,7 setzen zum Testen)`));
