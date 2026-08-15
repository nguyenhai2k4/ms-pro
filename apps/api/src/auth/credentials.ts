import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing (FR-AUTH-01) and session tokens (FR-AUTH-03).
 *
 * scrypt from the Node standard library, deliberately: it is memory-hard, it needs no native
 * build step, and P0 should not add a compiled dependency to the container image for this. If a
 * managed auth provider takes over password storage (IMPLEMENTATION-PLAN §3 suggests Auth0/Clerk
 * for MVP), this module is the only thing that gets deleted.
 *
 * Encoded form: `scrypt$N$saltHex$hashHex`. The parameters travel with the hash so they can be
 * raised later without invalidating existing passwords.
 */

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[2] ?? '', 'hex');
  const expected = Buffer.from(parts[3] ?? '', 'hex');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length);
  // Constant-time: a length-varying or short-circuiting comparison leaks the hash a byte at a time.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * FR-AUTH-03: the session row stores only a hash of the token, so a database read does not yield
 * usable credentials. The plaintext exists once, in the response to the client that created it.
 */
export function issueSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  // A single SHA-256 is correct here and not a shortcut: the token is 256 bits of CSPRNG entropy,
  // so there is no low-entropy guess space to search. Password hashing is slow because passwords
  // are guessable; this is not.
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
