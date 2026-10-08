import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getDb } from './db.js';
import { config } from './config.js';
import { isSecure } from './security.js';
import { settings } from './settings.js';

// Passkeys (WebAuthn): Anmeldung per Fingerabdruck/Gesichtserkennung/Geraete-PIN statt Code tippen.
// Phishing-sicher (an die Domain gebunden), nichts Geheimes verlaesst das Geraet.
const challenges = new Map(); // key -> { challenge, exp, kind }
const TTL = 5 * 60 * 1000;

function putChallenge(key, challenge, kind) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  challenges.set(key, { challenge, exp: now + TTL, kind });
}
function takeChallenge(key, kind) {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.kind === kind && c.exp > Date.now() ? c.challenge : null;
}

// Relying Party: Domain und Origin, so wie der Browser sie sieht
export function rpFor(req) {
  if (config.publicUrl) { const u = new URL(config.publicUrl); return { rpID: u.hostname, origin: u.origin }; }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return { rpID: String(host).split(':')[0], origin: `${isSecure(req) ? 'https' : 'http'}://${host}` };
}

const handleFor = (accountId) => new TextEncoder().encode(accountId == null ? 'admin' : `acc:${accountId}`);
const accountFromHandle = (buf) => { const s = Buffer.from(buf, 'base64url').toString(); return s === 'admin' ? { accountId: null } : s.startsWith('acc:') ? { accountId: Number(s.slice(4)) } : null; };

export const listPasskeys = ({ accountId, all = false } = {}) => {
  const rows = all ? getDb().prepare('SELECT * FROM passkeys ORDER BY created_at DESC').all()
    : getDb().prepare('SELECT * FROM passkeys WHERE account_id IS ? ORDER BY created_at DESC').all(accountId ?? null);
  return rows.map((r) => ({ id: r.id, role: r.role, label: r.label, createdAt: r.created_at, lastUsed: r.last_used, backedUp: !!r.backed_up, deviceType: r.device_type, accountId: r.account_id }));
};
export const countAdminPasskeys = () => getDb().prepare("SELECT COUNT(*) c FROM passkeys WHERE role = 'admin'").get().c;

export async function registrationOptions(req, session) {
  const { rpID } = rpFor(req);
  const existing = getDb().prepare('SELECT id FROM passkeys WHERE account_id IS ?').all(session.accountId ?? null);
  const options = await generateRegistrationOptions({
    rpName: settings().brand.name || 'Schulhauspartry', rpID,
    userName: session.label, userDisplayName: session.label, userID: handleFor(session.accountId),
    attestationType: 'none',
    excludeCredentials: existing.map((e) => ({ id: e.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, // "residentKey": Anmeldung ohne Code-Eingabe moeglich
    timeout: 120000,
  });
  putChallenge(`reg:${session.tokenHash}`, options.challenge, 'reg');
  return options;
}

export async function verifyRegistration(req, session, response, label) {
  const expectedChallenge = takeChallenge(`reg:${session.tokenHash}`, 'reg');
  if (!expectedChallenge) throw new Error('Die Anfrage ist abgelaufen – bitte noch einmal versuchen.');
  const { rpID, origin } = rpFor(req);
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) throw new Error('Der Passkey konnte nicht bestätigt werden.');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  getDb().prepare('INSERT INTO passkeys(id, account_id, role, label, public_key, counter, transports, device_type, backed_up, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(credential.id, session.accountId ?? null, session.role, String(label || 'Dieses Gerät').slice(0, 40), Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp ? 1 : 0, Date.now());
  return { id: credential.id };
}

export async function authenticationOptions(req) {
  const { rpID } = rpFor(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', timeout: 120000 }); // ohne allowCredentials: das Geraet bietet seine Passkeys an
  const cid = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
  putChallenge(`auth:${cid}`, options.challenge, 'auth');
  return { options, cid };
}

// Ergebnis: { accountId, role, who } oder wirft einen Fehler
export async function verifyAuthentication(req, cid, response) {
  const expectedChallenge = takeChallenge(`auth:${cid}`, 'auth');
  if (!expectedChallenge) throw new Error('Die Anfrage ist abgelaufen – bitte noch einmal versuchen.');
  const row = getDb().prepare('SELECT * FROM passkeys WHERE id = ?').get(String(response?.id || ''));
  if (!row) throw new Error('Dieser Passkey ist hier nicht registriert.');
  const { rpID, origin } = rpFor(req);
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
    credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports || '[]') },
  });
  if (!v.verified) throw new Error('Passkey nicht bestätigt.');
  getDb().prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, Date.now(), row.id);
  const owner = response.response?.userHandle ? accountFromHandle(response.response.userHandle) : { accountId: row.account_id };
  if ((owner?.accountId ?? null) !== (row.account_id ?? null)) throw new Error('Passkey passt nicht zum Konto.');
  let who = 'Head-Admin';
  if (row.account_id != null) {
    const acc = getDb().prepare('SELECT * FROM accounts WHERE id = ? AND revoked = 0').get(row.account_id);
    if (!acc) throw new Error('Dieses Konto ist gesperrt oder gelöscht.');
    who = acc.label;
    getDb().prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(Date.now(), acc.id);
  }
  return { accountId: row.account_id ?? null, role: row.role, who, passkeyLabel: row.label };
}

export function removePasskey(id, { accountId, isAdmin }) {
  const row = getDb().prepare('SELECT * FROM passkeys WHERE id = ?').get(String(id));
  if (!row) return false;
  if (!isAdmin && (row.account_id ?? null) !== (accountId ?? null)) return false;
  getDb().prepare('DELETE FROM passkeys WHERE id = ?').run(row.id);
  return true;
}
