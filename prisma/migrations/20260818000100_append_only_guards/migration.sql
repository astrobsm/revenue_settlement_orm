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

-- ============================================================================
-- Supply agreements: consent is a database constraint, not a convention
-- ----------------------------------------------------------------------------
-- The levy is a deduction from a supplier's money. lib/agreements.ts refuses to
-- apply one without two live signatures at the stated percentage — but that is
-- application logic, and this table can be written to by a migration, by psql,
-- or by a future route that forgets. So the rule is asserted here too.
-- ============================================================================

-- A signature is a record of consent at a MOMENT. It is never edited: a change
-- of mind is a revocation (revokedAt), which leaves the original consent visible.
CREATE OR REPLACE FUNCTION agreement_signatures_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A signature cannot be deleted. Revoke it instead, so the record still shows that consent was given and then withdrawn.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything except the revocation fields is frozen once signed. In
  -- particular agreedLevyBasisPoints: rewriting it would make a signature
  -- collected at 15% appear to consent to 20%, which is the precise
  -- misrepresentation this whole mechanism exists to prevent.
  IF OLD."signedAt" IS NOT NULL AND
     (NEW."party", NEW."signatoryName", NEW."agreedLevyBasisPoints",
      NEW."consentStatement", NEW."consentGiven", NEW."signedAt")
     IS DISTINCT FROM
     (OLD."party", OLD."signatoryName", OLD."agreedLevyBasisPoints",
      OLD."consentStatement", OLD."consentGiven", OLD."signedAt")
  THEN
    RAISE EXCEPTION
      'A signature is frozen once given: only its revocation may be recorded. To change the agreed percentage, raise a new agreement version and have both parties sign it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreement_signatures_frozen
  BEFORE UPDATE OR DELETE ON "agreement_signatures"
  FOR EACH ROW EXECUTE FUNCTION agreement_signatures_immutable();

-- An active agreement must carry a live, unrevoked, consenting signature from
-- BOTH parties, each given at the percentage the agreement currently states.
CREATE OR REPLACE FUNCTION agreement_activation_requires_signatures() RETURNS TRIGGER AS $$
DECLARE
  valid_signatures INT;
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(DISTINCT s."party") INTO valid_signatures
  FROM "agreement_signatures" s
  WHERE s."agreementId" = NEW."id"
    AND s."party" IN ('HOSPITAL', 'VENDOR')
    AND s."consentGiven" = TRUE
    AND s."signedAt" IS NOT NULL
    AND s."revokedAt" IS NULL
    AND s."agreedLevyBasisPoints" = NEW."levyBasisPoints";

  IF valid_signatures < 2 THEN
    RAISE EXCEPTION
      'This agreement cannot be made active: it needs a current signature from both the hospital and the vendor, each given at % basis points. No levy may be taken from a supplier who has not agreed to it.',
      NEW."levyBasisPoints"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vendor_agreements_active_needs_signatures
  BEFORE INSERT OR UPDATE ON "vendor_agreements"
  FOR EACH ROW EXECUTE FUNCTION agreement_activation_requires_signatures();

-- A share is a share: between nothing and everything.
ALTER TABLE "vendor_agreements" ADD CONSTRAINT vendor_agreements_levy_is_a_share
  CHECK ("levyBasisPoints" >= 0 AND "levyBasisPoints" <= 10000);

ALTER TABLE "agreement_signatures" ADD CONSTRAINT agreement_signatures_levy_is_a_share
  CHECK ("agreedLevyBasisPoints" >= 0 AND "agreedLevyBasisPoints" <= 10000);
