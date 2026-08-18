-- ============================================================================
-- Append-only guards (§18, §23, §33, §55)
-- ----------------------------------------------------------------------------
-- The application already refuses to update a ledger entry or an audit record.
-- That is not enough. §55 requires database constraints, and for good reason:
-- an application rule is bypassed by psql, by a migration script, by a future
-- route written in a hurry, and by anyone with the connection string.
--
-- These triggers make the guarantee structural. The ledger and the audit trail
-- accept INSERT and nothing else. A correction is a NEW compensating row that
-- references the original (see lib/ledger.ts reverse()), which is the only way
-- to change what the books say.
--
-- DELIBERATELY NOT COVERED: invoices, payments and distributions. Those rows
-- legitimately change status as money moves, and freezing them would break the
-- state machines. Their history is protected differently — by the ledger and
-- audit rows written alongside every change, which these triggers do freeze.
--
-- TO CORRECT A GENUINE MISTAKE in a frozen table, a database administrator must
-- disable the trigger explicitly, in the open, with a recorded reason:
--     ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only;
-- That is the point. It should be an act somebody has to decide to take, not
-- something an ORM can do by accident.
-- ============================================================================

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. Financial history is corrected by inserting a compensating record that references the original, never by changing what was recorded.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- --- The ledger (§18) -------------------------------------------------------
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON "ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --- The audit trail (§33) --------------------------------------------------
-- This one matters twice over: the audit log is not merely a report, it is the
-- INPUT to the separation-of-duties control. A mutable audit trail means a user
-- can erase the prior act that would have barred them from acting again.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --- Provider exchanges (§11, §35) ------------------------------------------
-- What a payment provider actually said, kept whole. A verification record that
-- can be edited proves nothing about the verification.
CREATE TRIGGER payment_transactions_append_only
  BEFORE UPDATE OR DELETE ON "payment_transactions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --- Receipts (§26) ---------------------------------------------------------
-- A reprint must be identical to what the patient was handed. printCount and
-- lastPrintedAt are the only fields that may move, so this trigger allows
-- UPDATE only when nothing else has changed.
CREATE OR REPLACE FUNCTION receipts_reprint_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A receipt cannot be deleted. Cancel it with an adjustment instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW."receiptNumber", NEW."invoiceId", NEW."paymentId", NEW."amountPaid",
      NEW."balanceAfter", NEW."verificationCode", NEW."snapshot", NEW."issuedAt")
     IS DISTINCT FROM
     (OLD."receiptNumber", OLD."invoiceId", OLD."paymentId", OLD."amountPaid",
      OLD."balanceAfter", OLD."verificationCode", OLD."snapshot", OLD."issuedAt")
  THEN
    RAISE EXCEPTION
      'A receipt is frozen once issued: only the reprint count may change. A reprinted receipt must match the one the patient was given.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER receipts_frozen
  BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION receipts_reprint_only();

-- --- Money is never negative where it cannot be ------------------------------
-- Cheap, and catches a whole class of bug before it reaches a bill.
ALTER TABLE "invoices"        ADD CONSTRAINT invoices_amounts_non_negative
  CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "total" >= 0 AND "amountPaid" >= 0);

ALTER TABLE "invoice_lines"   ADD CONSTRAINT invoice_lines_sane
  CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0);

-- The arithmetic of a line, enforced by the database rather than trusted.
ALTER TABLE "invoice_lines"   ADD CONSTRAINT invoice_lines_total_is_product
  CHECK ("lineTotal" = "quantity" * "unitPrice");

ALTER TABLE "payments"        ADD CONSTRAINT payments_amount_positive
  CHECK ("amount" > 0);

ALTER TABLE "ledger_postings" ADD CONSTRAINT ledger_postings_positive
  CHECK ("amount" > 0);

-- Direction is carried by side, never by the sign of an amount.
ALTER TABLE "ledger_postings" ADD CONSTRAINT ledger_postings_side_valid
  CHECK ("side" IN ('DEBIT', 'CREDIT'));

ALTER TABLE "deposits"        ADD CONSTRAINT deposits_drawdown_within_balance
  CHECK ("amountApplied" >= 0 AND "amountRefunded" >= 0
         AND "amountApplied" + "amountRefunded" <= "amount");

ALTER TABLE "settlements"     ADD CONSTRAINT settlements_amount_positive
  CHECK ("amount" > 0);

-- A confirmed settlement without a bank reference is the exact false impression
-- §51 forbids: it looks reconciled and cannot be checked.
ALTER TABLE "settlements"     ADD CONSTRAINT settlements_confirmed_needs_reference
  CHECK ("status" <> 'CONFIRMED' OR ("bankReference" IS NOT NULL AND length(trim("bankReference")) > 0));

-- A successful payment must say how it is known to be real (§2).
ALTER TABLE "payments"        ADD CONSTRAINT payments_successful_needs_trust_basis
  CHECK ("status" <> 'SUCCESSFUL' OR "trustBasis" IS NOT NULL);

-- An attested payment must name the cashier and carry evidence.
ALTER TABLE "payments"        ADD CONSTRAINT payments_attested_needs_attribution
  CHECK ("trustBasis" <> 'ATTESTED'
         OR ("attestedByUserId" IS NOT NULL AND "evidenceRef" IS NOT NULL));

-- A gateway-verified payment must carry the provider transaction id verified.
ALTER TABLE "payments"        ADD CONSTRAINT payments_gateway_needs_provider_ref
  CHECK ("trustBasis" <> 'GATEWAY_VERIFIED' OR "providerTransactionId" IS NOT NULL);

-- One provider transaction confirms at most one payment. This is the database's
-- half of idempotency (§34): even if two webhook deliveries race past the
-- application's key check, only one can win.
CREATE UNIQUE INDEX payments_provider_txn_unique
  ON "payments" ("providerId", "providerTransactionId")
  WHERE "providerTransactionId" IS NOT NULL;
