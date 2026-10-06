import crypto from 'node:crypto';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === 'production',
  dataDir: env.DATA_DIR || './data',
  // Initiales Super-Admin-Passwort (wird beim Start gehasht in die DB geschrieben).
  adminPassword: env.ADMIN_PASSWORD || '',
  // Geheimnis fuer Cookie-Signatur und Token-Verschluesselung. In Produktion Pflicht.
  secret: env.APP_SECRET || '',
  // Hinter Cloudflare: echte Client-IP aus CF-Connecting-IP lesen.
  trustCloudflare: env.TRUST_CLOUDFLARE === 'true',
  // Oeffentliche Basis-URL (fuer Spotify-OAuth-Redirect), z. B. https://party.example.de
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  spotifyClientId: env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
};

export function validateConfig() {
  const problems = [];
  if (config.production) {
    if (config.secret.length < 32) problems.push('APP_SECRET muss mindestens 32 Zeichen lang sein.');
    if (config.adminPassword && config.adminPassword.length < 12) problems.push('ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein.');
  }
  if (!config.secret) {
    config.secret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] APP_SECRET fehlt - es wird ein temporaeres Geheimnis genutzt (Sessions gehen beim Neustart verloren).');
  }
  return problems;
}
