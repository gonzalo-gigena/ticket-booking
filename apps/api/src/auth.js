import { argon2, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const kdf = promisify(argon2);
// OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

// PHC string, the same format libargon2 writes, so hashes stay portable.
export async function hashPassword(password) {
  const nonce = randomBytes(16);
  const tag = await kdf('argon2id', { message: password, nonce, ...PARAMS });
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(nonce)}$${b64(tag)}`;
}

export async function verifyPassword(password, phc) {
  const [, alg, , params, salt, hash] = phc.split('$');
  const { m, t, p } = Object.fromEntries(params.split(',').map((kv) => kv.split('=')));
  const expected = Buffer.from(hash, 'base64');
  const tag = await kdf(alg, {
    message: password, nonce: Buffer.from(salt, 'base64'),
    memory: Number(m), passes: Number(t), parallelism: Number(p), tagLength: expected.length,
  });
  return timingSafeEqual(tag, expected);
}

// Verifying against this when the email is unknown keeps login time the same either way.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export const newSessionToken = () => randomBytes(32).toString('base64url');
// Redis stores the token's hash, so a leaked dump can't be replayed as cookies.
export const sessionKey = (token) => `sess:${createHash('sha256').update(token).digest('hex')}`;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    // No URI decoding: our token is base64url, and decoding throws on another app's malformed cookie.
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function validCredentials(body) {
  const { email, password } = body ?? {};
  return typeof email === 'string' && /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email) && email.length <= 254
    && typeof password === 'string' && password.length >= 8 && password.length <= 256;
}
