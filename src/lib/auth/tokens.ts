import crypto from 'node:crypto';

/**
 * Lightweight guest authentication. Joining a session issues an opaque bearer
 * token; only its SHA-256 hash is stored. No accounts or passwords.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Unambiguous alphabet (no 0/O, 1/I/L) for codes read aloud or typed on phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateSessionCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Signed image URLs: <img> tags cannot send an Authorization header, so image
 *  links carry an HMAC that only the server can mint for authorised viewers. */
export function signImage(secret: string, imageId: string): string {
  return crypto.createHmac('sha256', secret).update(`image:${imageId}`).digest('base64url').slice(0, 32);
}

export function verifyImageSignature(secret: string, imageId: string, sig: string | null): boolean {
  if (!sig) return false;
  const expected = Buffer.from(signImage(secret, imageId));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
