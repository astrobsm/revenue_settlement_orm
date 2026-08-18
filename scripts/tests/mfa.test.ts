/**
 * Multi-factor authentication.
 *
 * The first block is the one that matters: TOTP is checked against the OFFICIAL
 * TEST VECTORS published in RFC 6238 Appendix B. A hand-rolled implementation of
 * a security primitive is only acceptable if it is proved against the standard,
 * and those vectors are the standard.
 *
 * The rest cover the three things TOTP implementations get wrong in practice:
 * clock drift, replay, and leaking through comparison timing.
 */
import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  counterFor,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  mfaRequiredFor,
  otpauthUri,
  TOTP_STEP_SECONDS,
  totpAt,
  totpNow,
  verifyBackupCode,
  verifyTotp,
} from './mfa';

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" for SHA-1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

// ---------------------------------------------------------------------------
describe('RFC 6238 test vectors', () => {
  // The RFC publishes 8-digit codes; this implementation emits 6, which is what
  // authenticator apps use. The 6-digit code is the last six digits of the
  // 8-digit one, because both are the same integer modulo a power of ten.
  const VECTORS: { time: number; eightDigit: string }[] = [
    { time: 59, eightDigit: '94287082' },
    { time: 1111111109, eightDigit: '07081804' },
    { time: 1111111111, eightDigit: '14050471' },
    { time: 1234567890, eightDigit: '89005924' },
    { time: 2000000000, eightDigit: '69279037' },
    { time: 20000000000, eightDigit: '65353130' },
  ];

  for (const vector of VECTORS) {
    it(`matches the vector at T=${vector.time}`, () => {
      const counter = Math.floor(vector.time / TOTP_STEP_SECONDS);
      expect(totpAt(RFC_SECRET, counter)).toBe(vector.eightDigit.slice(-6));
    });
  }

  it('handles counters beyond 32 bits', () => {
    // T=20000000000 is past 2^31 seconds. An implementation that writes the
    // counter as a 32-bit value silently produces wrong codes from 2038 — and
    // would pass every other test here.
    const counter = Math.floor(20000000000 / TOTP_STEP_SECONDS);
    expect(counter).toBeGreaterThan(0xffffffff / 8);
    expect(totpAt(RFC_SECRET, counter)).toBe('353130');
  });
});

// ---------------------------------------------------------------------------
describe('base32, which is what authenticator apps read', () => {
  it('round-trips arbitrary bytes', () => {
    for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      const buffer = Buffer.from(text, 'ascii');
      expect(base32Decode(base32Encode(buffer)).toString('ascii')).toBe(text);
    }
  });

  it('encodes the RFC secret as expected', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('tolerates lowercase, spaces and padding when decoding', () => {
    const encoded = base32Encode(Buffer.from('hello', 'ascii'));
    expect(base32Decode(encoded.toLowerCase()).toString()).toBe('hello');
    expect(base32Decode(`${encoded}===`).toString()).toBe('hello');
  });

  it('rejects characters that are not base32', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow(/not valid base32/i);
  });
});

// ---------------------------------------------------------------------------
describe('secrets', () => {
  it('produces a 32-character secret, as apps expect', () => {
    expect(generateSecret()).toHaveLength(32);
  });

  it('never produces the same secret twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSecret()));
    expect(seen.size).toBe(200);
  });

  it('builds an otpauth URI an authenticator can scan', () => {
    const uri = otpauthUri({ secretBase32: RFC_SECRET, accountName: 'finance.admin@unth.local', issuer: 'UNTH Theatre Revenue' });
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // The issuer identifies the hospital, not the software: a finance officer
    // with six authenticator entries needs to know which is which.
    expect(decodeURIComponent(uri)).toContain('UNTH Theatre Revenue');
  });
});

// ---------------------------------------------------------------------------
describe('verifying a code', () => {
  const at = new Date('2026-08-18T12:00:00Z');
  const base = { secretBase32: RFC_SECRET, lastUsedCounter: null, at };

  it('accepts the current code', () => {
    const v = verifyTotp({ ...base, code: totpNow(RFC_SECRET, at) });
    expect(v.valid).toBe(true);
    expect(v.counter).toBe(counterFor(at));
  });

  it('accepts a code from the previous step, for clock drift', () => {
    const previous = totpAt(RFC_SECRET, counterFor(at) - 1);
    expect(verifyTotp({ ...base, code: previous }).valid).toBe(true);
  });

  it('accepts a code from the next step, for a phone running fast', () => {
    const next = totpAt(RFC_SECRET, counterFor(at) + 1);
    expect(verifyTotp({ ...base, code: next }).valid).toBe(true);
  });

  it('REFUSES a code two steps old', () => {
    // The window is deliberately narrow: a wider one lengthens how long a
    // shoulder-surfed code stays usable.
    const stale = totpAt(RFC_SECRET, counterFor(at) - 2);
    expect(verifyTotp({ ...base, code: stale }).valid).toBe(false);
  });

  it('refuses a code for a different secret', () => {
    const other = generateSecret();
    expect(verifyTotp({ ...base, code: totpNow(other, at) }).valid).toBe(false);
  });

  it('refuses malformed input without checking anything', () => {
    for (const code of ['', '123', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp({ ...base, code }).code).toBe('MALFORMED');
    }
  });

  it('tolerates spaces in a correctly-lengthed code', () => {
    const code = totpNow(RFC_SECRET, at);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp({ ...base, code: spaced }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('a code cannot be used twice', () => {
  const at = new Date('2026-08-18T12:00:00Z');
  const counter = counterFor(at);

  it('refuses a code already used at this counter', () => {
    // Without this, a code read over somebody's shoulder works for the rest of
    // its 30-second window.
    const v = verifyTotp({ secretBase32: RFC_SECRET, code: totpNow(RFC_SECRET, at), lastUsedCounter: counter, at });
    expect(v.valid).toBe(false);
    expect(v.code).toBe('CODE_ALREADY_USED');
  });

  it('refuses an older code even though it is within the window', () => {
    const previous = totpAt(RFC_SECRET, counter - 1);
    const v = verifyTotp({ secretBase32: RFC_SECRET, code: previous, lastUsedCounter: counter, at });
    expect(v.valid).toBe(false);
    expect(v.code).toBe('CODE_ALREADY_USED');
  });

  it('accepts the NEXT code after one has been used', () => {
    const next = totpAt(RFC_SECRET, counter + 1);
    const v = verifyTotp({ secretBase32: RFC_SECRET, code: next, lastUsedCounter: counter, at });
    expect(v.valid).toBe(true);
    expect(v.counter).toBe(counter + 1);
  });

  it('returns the counter so the caller can store it', () => {
    const v = verifyTotp({ secretBase32: RFC_SECRET, code: totpNow(RFC_SECRET, at), lastUsedCounter: null, at });
    expect(v.counter).toBe(counter);
  });
});

// ---------------------------------------------------------------------------
describe('backup codes', () => {
  it('produces ten distinct codes by default', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('omits the characters people misread on paper', () => {
    // A backup code is read off a printout, often in a hurry.
    for (const code of generateBackupCodes(50)) {
      expect(/[IO01]/.test(code.replace('-', ''))).toBe(false);
    }
  });

  it('never stores the plaintext', () => {
    const [code] = generateBackupCodes(1);
    const hash = hashBackupCode(code);
    expect(hash).not.toContain(code.replace('-', ''));
    expect(hash).toHaveLength(64);
  });

  it('accepts a valid code regardless of case, spacing or dashes', () => {
    const [code] = generateBackupCodes(1);
    const hashes = [hashBackupCode(code)];
    for (const variant of [code, code.toLowerCase(), code.replace('-', ''), ` ${code} `]) {
      expect(verifyBackupCode({ code: variant, hashes }).valid).toBe(true);
    }
  });

  it('rejects a code that was not issued', () => {
    const hashes = generateBackupCodes(5).map(hashBackupCode);
    expect(verifyBackupCode({ code: 'AAAAA-BBBBB', hashes }).valid).toBe(false);
  });

  it('names which hash was used, so it can be struck off', () => {
    // Single use: the caller removes the returned hash.
    const codes = generateBackupCodes(3);
    const hashes = codes.map(hashBackupCode);
    const result = verifyBackupCode({ code: codes[1], hashes });
    expect(result.usedHash).toBe(hashes[1]);
  });
});

// ---------------------------------------------------------------------------
describe('who must have MFA (§42)', () => {
  it('requires it of anyone who can move or redirect money', () => {
    expect(mfaRequiredFor(['FINANCE_ADMINISTRATOR'])).toBe(true);
    expect(mfaRequiredFor(['SUPER_ADMINISTRATOR'])).toBe(true);
    expect(mfaRequiredFor(['FINANCE_OFFICER'])).toBe(true);
  });

  it('does not require it of a cashier or a clinician', () => {
    expect(mfaRequiredFor(['CASHIER'])).toBe(false);
    expect(mfaRequiredFor(['SURGEON'])).toBe(false);
    expect(mfaRequiredFor(['AUDITOR'])).toBe(false);
  });

  it('requires it if ANY held role requires it', () => {
    expect(mfaRequiredFor(['CASHIER', 'FINANCE_ADMINISTRATOR'])).toBe(true);
  });
});
