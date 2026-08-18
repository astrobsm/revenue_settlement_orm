// ============================================================
// Multi-factor authentication (§42)
// ------------------------------------------------------------
// §42 requires MFA for financial administrators, and apiGuard already refuses
// them every configuration route until they have it. This is the implementation
// that lets them enrol.
//
// TOTP, per RFC 6238 — the algorithm behind Google Authenticator, Authy, Microsoft
// Authenticator and every other app a hospital finance officer is likely to
// already have on their phone. Implemented directly rather than pulled from a
// package: it is thirty lines of HMAC, it has OFFICIAL TEST VECTORS in the RFC
// (see mfa.test.ts, which checks against all six of them), and a dependency that
// guards the money is a dependency worth not having.
//
// THREE THINGS THAT ARE EASY TO GET WRONG, AND ARE HANDLED HERE
//
// CLOCK DRIFT. A phone whose clock is a minute out would never authenticate.
// A window of one step either side is accepted — 90 seconds in total — which is
// the usual compromise between tolerating drift and limiting how long a stolen
// code stays useful.
//
// REPLAY. A code is valid for 30 seconds, so somebody who shoulder-surfs one has
// half a minute to use it. verifyTotp returns the counter it matched, and the
// caller MUST store it and refuse anything at or below it. Without that, a code
// read over someone's shoulder works for the rest of its window.
//
// TIMING. Codes are compared in constant time. A comparison that returns early
// on the first wrong digit leaks how much of a guess was right.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto';

/** Seconds per code. 30 is the near-universal default and what apps assume. */
export const TOTP_STEP_SECONDS = 30;

/** Digits in a code. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of "now" are accepted.
 *
 * One means a code is usable for at most 90 seconds. Raising this to tolerate
 * worse clocks also lengthens the window in which a stolen code works, so it
 * stays at one.
 */
export const TOTP_WINDOW = 1;

// ---------------------------------------------------------------------------
// Base32, because that is what authenticator apps read
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not valid base32.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

/**
 * A new secret.
 *
 * 20 bytes is the RFC 6238 recommendation for SHA-1 and what authenticator apps
 * expect. It becomes 32 base32 characters, which is what the user sees if they
 * cannot scan the QR code.
 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * The code for a given secret and counter.
 *
 * `counter` is the number of TOTP_STEP_SECONDS periods since the Unix epoch.
 * Exposed separately from the time so this can be tested against the RFC's
 * vectors, which are stated as times.
 */
export function totpAt(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);

  // The counter as an 8-byte big-endian value.
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', key).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function counterFor(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code for right now. Used to show a test code during enrolment. */
export function totpNow(secretBase32: string, at: Date = new Date()): string {
  return totpAt(secretBase32, counterFor(at));
}

export interface TotpVerdict {
  valid: boolean;
  /**
   * The counter this code matched. The caller MUST persist it and reject any
   * later attempt at or below it, or a shoulder-surfed code stays usable for the
   * rest of its window.
   */
  counter?: number;
  code?: string;
  message?: string;
}

/**
 * Is `code` valid for this secret right now?
 *
 * `lastUsedCounter` is the last counter this user successfully authenticated
 * with. Passing it is what makes a code single-use; omitting it leaves replay
 * open, so the parameter is required rather than optional.
 */
export function verifyTotp(params: {
  secretBase32: string;
  code: string;
  lastUsedCounter: number | null;
  at?: Date;
}): TotpVerdict {
  const { secretBase32, code, lastUsedCounter, at = new Date() } = params;

  const cleaned = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) {
    return { valid: false, code: 'MALFORMED', message: 'An authentication code is six digits.' };
  }

  const now = counterFor(at);

  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const counter = now + drift;
    const expected = totpAt(secretBase32, counter);

    // Constant time: a comparison that returns early on the first wrong digit
    // leaks how much of a guess was correct.
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length !== b.length || !timingSafeEqual(a, b)) continue;

    // The code is right — but has it already been used?
    if (lastUsedCounter !== null && counter <= lastUsedCounter) {
      return {
        valid: false,
        code: 'CODE_ALREADY_USED',
        message: 'That code has already been used. Wait for your authenticator to show the next one.',
      };
    }

    return { valid: true, counter };
  }

  return { valid: false, code: 'INVALID_CODE', message: 'That code is not correct, or has expired.' };
}

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * The issuer appears in the app's list, so it must identify the hospital rather
 * than the software — a finance officer with six authenticator entries needs to
 * know which is which.
 */
export function otpauthUri(params: { secretBase32: string; accountName: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------
// A finance administrator who loses their phone must not be locked out of the
// system that pays the hospital's suppliers. Backup codes are the escape hatch,
// and they are single-use and stored HASHED — a backup code is a password.

const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j++) {
      code += BACKUP_ALPHABET[bytes[j] % BACKUP_ALPHABET.length];
      if (j === 4) code += '-';
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Hash a backup code for storage.
 *
 * SHA-256 rather than bcrypt, deliberately: these are 50 bits of true randomness
 * rather than a human-chosen password, so there is nothing to brute-force
 * offline and no need for a slow hash. What matters is that the plaintext is
 * never stored, and it is not.
 */
export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
}

export function verifyBackupCode(params: { code: string; hashes: string[] }): { valid: boolean; usedHash?: string } {
  const candidate = hashBackupCode(params.code);
  for (const stored of params.hashes) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, usedHash: stored };
    }
  }
  return { valid: false };
}

// ---------------------------------------------------------------------------
// Who must have it
// ---------------------------------------------------------------------------

/**
 * Roles for which §42 requires MFA.
 *
 * Kept beside the implementation rather than in rbac so the list and the reason
 * stay together: these are the people who can change where money is sent, and
 * approve money leaving.
 */
export const MFA_REQUIRED_ROLES = ['FINANCE_ADMINISTRATOR', 'SUPER_ADMINISTRATOR', 'FINANCE_OFFICER'];

export function mfaRequiredFor(roles: string[]): boolean {
  return roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
}
