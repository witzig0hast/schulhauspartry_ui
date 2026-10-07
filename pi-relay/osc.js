// Minimaler OSC-Encoder/-Decoder (nur was der X32 braucht: i, f, s, b)
const pad4 = (n) => (4 - (n % 4)) % 4;
const cstr = (s) => { const b = Buffer.from(s + '\0', 'utf8'); return Buffer.concat([b, Buffer.alloc(pad4(b.length))]); };

export function encode(address, args = []) {
  const parts = [cstr(address), cstr(',' + args.map((a) => a.t).join(''))];
  for (const a of args) {
    if (a.t === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(a.v); parts.push(b); }
    else if (a.t === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(a.v); parts.push(b); }
    else if (a.t === 's') parts.push(cstr(a.v));
    else if (a.t === 'b') { const h = Buffer.alloc(4); h.writeInt32BE(a.v.length); parts.push(h, a.v, Buffer.alloc(pad4(a.v.length))); }
    else throw new Error(`OSC-Typ ${a.t} nicht unterstützt`);
  }
  return Buffer.concat(parts);
}

function readStr(buf, off) {
  const end = buf.indexOf(0, off);
  const s = buf.toString('utf8', off, end);
  return [s, off + Math.ceil((end - off + 1) / 4) * 4];
}

export function decode(buf) {
  let [address, off] = readStr(buf, 0);
  if (off >= buf.length) return { address, args: [] };
  let tags; [tags, off] = readStr(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 's') { let s; [s, off] = readStr(buf, off); args.push(s); }
    else if (t === 'b') { const n = buf.readInt32BE(off); off += 4; args.push(buf.subarray(off, off + n)); off += n + pad4(n); }
    else break;
  }
  return { address, args };
}

// X32-Meter-Blob: int32 (LE) Anzahl + float32 (LE) Werte
export function decodeMeters(blob) {
  const n = blob.readInt32LE(0);
  const out = [];
  for (let i = 0; i < n && 4 + i * 4 + 4 <= blob.length; i++) out.push(blob.readFloatLE(4 + i * 4));
  return out;
}
export function encodeMeters(values) {
  const b = Buffer.alloc(4 + values.length * 4);
  b.writeInt32LE(values.length, 0);
  values.forEach((v, i) => b.writeFloatLE(v, 4 + i * 4));
  return b;
}
