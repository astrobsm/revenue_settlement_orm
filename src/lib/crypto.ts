// ============================================================
// Field encryption for bank details (§14, §42)
// ------------------------------------------------------------
// A revenue account number is the destination of real money. Two different
// risks apply to it, and they need different answers:
//
//   READ AT REST   — a database dump, a backup on a laptop, a stolen disk.
//                    Answered by encryption.
//   READ ON SCREEN — a clerk who has no business knowing where the surgical
//                    fees are settled. Answered by masking (§14: "do not expose
//                    complete account numbers to users who do not require them").
//
// AES-256-GCM, which is authenticated: an account number that has been tampered
// with in the database fails to decrypt rather than silently decrypting to a
// DIFFERENT account number. That property is the whole reason for choosing GCM
// over CBC here — silent corruption of a payout destination is the failure that
// actually loses money.
//
// THE KEY LIVES IN THE ENVIRONMENT, never in the database. Storing the key
// beside the ciphertext protects against nothing at all.
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96 bits, the standard nonce size for GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32;  // AES-256

export class EncryptionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

function key(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionError(
      'NO_KEY',
      'FIELD_ENCRYPTION_KEY is not set, so bank details cannot be stored. Generate one with: openssl rand -base64 32'
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new EncryptionError(
      'BAD_KEY',
      `FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${buf.length}. Generate one with: openssl rand -base64 32`
    );
  }
  return buf;
}

/** Is encryption configured? For the settings screen to warn before saving. */
export function encryptionAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a value. Returns `v1:<iv>:<tag>:<ciphertext>`, all base64.
 *
 * The version prefix exists so the key can be rotated later without guessing
 * which scheme an old row used.
 */
export function encryptField(plaintext: string): string {
  if (!plaintext) throw new EncryptionError('EMPTY', 'There is nothing to encrypt.');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a value.
 *
 * Throws rather than returning a partial or empty result. A bank account number
 * that fails to decrypt must stop a settlement, not quietly become blank — a
 * blank destination is how money goes somewhere nobody intended.
 */
export function decryptField(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new EncryptionError('BAD_FORMAT', 'This stored value is not in the expected encrypted format.');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  try {
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // GCM authentication failed: the ciphertext or the key is wrong. Either way
    // the value cannot be trusted.
    throw new EncryptionError(
      'AUTH_FAILED',
      'This bank detail failed its integrity check. It may have been altered in the database, or the encryption key may have changed. It has NOT been returned.'
    );
  }
}

/**
 * What most users should see: the last four digits only (§14).
 *
 * Four is the convention on a Nigerian bank statement and is enough for a
 * finance officer to confirm they are looking at the right account, without
 * handing the whole number to anyone who opens a settlement screen.
 */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\s/g, '');
  if (digits.length <= 4) return '•'.repeat(digits.length);
  return `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export function lastFour(accountNumber: string): string {
  return accountNumber.replace(/\s/g, '').slice(-4);
}

/**
 * A Nigerian NUBAN account number is ten digits.
 *
 * Validated because a mistyped destination is one of the few errors this system
 * cannot detect afterwards: the money leaves, and the reconciliation only shows
 * that it did.
 */
export function isPlausibleNuban(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber.replace(/\s/g, ''));
}

/**
 * Constant-time comparison, for verification codes and webhook signatures.
 *
 * A normal string comparison returns as soon as two characters differ, and the
 * time it takes leaks how much of a guess was correct.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
