// ============================================================
// Document numbering (§7, §26)
// ------------------------------------------------------------
// An invoice, a payment and a receipt each carry a legible, sortable reference
// that a patient can quote over a telephone and a clerk can find.
//
//   Invoice   CTR/INV/2026/000124
//   Payment   CTR/PAY/2026/000124
//   Receipt   CTR/RCT/2026/000124
//
// Sequences come from the DATABASE, inside the same transaction as the record
// they number. Computing "the next number" by counting existing rows is the
// classic way two cashiers at two windows produce two invoices numbered 000124,
// and the unique constraint then fails whichever of them was slower.
// ============================================================

import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const UNIT_PREFIX = 'CTR';

export const Series = {
  INVOICE: 'INV',
  PAYMENT: 'PAY',
  RECEIPT: 'RCT',
  SETTLEMENT: 'SET',
  REFUND: 'RFD',
  DEPOSIT: 'DEP',
  ADJUSTMENT: 'ADJ',
  AGREEMENT: 'AGR',
} as const;

export type SeriesValue = (typeof Series)[keyof typeof Series];

/**
 * The next number in a series, allocated atomically.
 *
 * Uses a Postgres sequence-like upsert with a returning increment, so two
 * concurrent callers cannot receive the same value. `$executeRaw` is used
 * because Prisma has no portable "increment and return" primitive.
 */
export async function nextNumber(db: Db, series: SeriesValue, year = new Date().getFullYear()): Promise<string> {
  const key = `${series}-${year}`;

  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO "document_sequences" ("key", "value")
    VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "document_sequences"."value" + 1
    RETURNING "value"
  `;

  const value = rows[0]?.value ?? 1;
  return format(series, year, value);
}

export function format(series: SeriesValue, year: number, sequence: number, padding = 6): string {
  return `${UNIT_PREFIX}/${series}/${year}/${String(sequence).padStart(padding, '0')}`;
}

/**
 * A receipt verification code (§26).
 *
 * Short enough to read aloud, long enough not to be guessed. Deliberately not
 * sequential: a guessable code would let anyone enumerate other patients'
 * receipts, which is a privacy breach rather than merely untidy.
 *
 * The alphabet omits I, O, 0 and 1 — a verification code is read off paper by a
 * clerk under fluorescent light, and those four are where transcription errors
 * come from.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function verificationCode(randomBytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET[randomBytes[i % randomBytes.length] % CODE_ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}
