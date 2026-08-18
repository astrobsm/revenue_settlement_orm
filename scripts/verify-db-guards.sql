-- ============================================================================
-- Do the database guards actually fire?
-- ----------------------------------------------------------------------------
--     npm run db:verify-guards
--
-- The append-only triggers and CHECK constraints in the migrations are the
-- LAST line of defence: they hold when the application logic is bypassed by
-- psql, by a migration script, or by a route written in a hurry.
--
-- A guard that has never been executed is a guard nobody knows works. This
-- script attempts every forbidden thing in turn and reports whether Postgres
-- refused it. Every line should read "ok".
--
-- It runs inside a transaction that is ROLLED BACK, so it leaves no data behind.
-- ============================================================================

\set ON_ERROR_STOP off
BEGIN;

-- A ledger entry to attack.
INSERT INTO "ledger_entries" ("id", "eventType", "amount", "memo")
VALUES ('guard-test-entry', 'PAYMENT_RECEIVED', 100000, 'guard verification');

INSERT INTO "ledger_postings" ("id", "entryId", "account", "side", "amount")
VALUES ('guard-test-posting', 'guard-test-entry', 'CASH_AT_BANK', 'DEBIT', 100000);

INSERT INTO "audit_logs" ("id", "action", "entity", "duty", "userId")
VALUES ('guard-test-audit', 'test', 'test', 'PAYMENT_CONFIRMED', 'user-1');

-- ---------------------------------------------------------------------------
-- Each test: attempt the forbidden thing, expect an exception.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ok_count INT := 0;
  fail_count INT := 0;

BEGIN
  -- 1. UPDATE a ledger entry
  BEGIN
    UPDATE "ledger_entries" SET "amount" = 1 WHERE "id" = 'guard-test-entry';
    RAISE WARNING 'FAIL  ledger_entries UPDATE was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ledger_entries UPDATE refused';
    ok_count := ok_count + 1;
  END;

  -- 2. DELETE a ledger entry
  BEGIN
    DELETE FROM "ledger_entries" WHERE "id" = 'guard-test-entry';
    RAISE WARNING 'FAIL  ledger_entries DELETE was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ledger_entries DELETE refused';
    ok_count := ok_count + 1;
  END;

  -- 3. UPDATE a posting
  BEGIN
    UPDATE "ledger_postings" SET "amount" = 1 WHERE "id" = 'guard-test-posting';
    RAISE WARNING 'FAIL  ledger_postings UPDATE was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ledger_postings UPDATE refused';
    ok_count := ok_count + 1;
  END;

  -- 4. DELETE an audit row — the one that would erase a separation-of-duties bar
  BEGIN
    DELETE FROM "audit_logs" WHERE "id" = 'guard-test-audit';
    RAISE WARNING 'FAIL  audit_logs DELETE was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    audit_logs DELETE refused';
    ok_count := ok_count + 1;
  END;

  -- 5. UPDATE an audit row
  BEGIN
    UPDATE "audit_logs" SET "userId" = 'somebody-else' WHERE "id" = 'guard-test-audit';
    RAISE WARNING 'FAIL  audit_logs UPDATE was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    audit_logs UPDATE refused';
    ok_count := ok_count + 1;
  END;

  -- 6. A negative ledger posting
  BEGIN
    INSERT INTO "ledger_postings" ("id", "entryId", "account", "side", "amount")
    VALUES ('guard-neg', 'guard-test-entry', 'CASH_AT_BANK', 'DEBIT', -5);
    RAISE WARNING 'FAIL  negative posting was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    negative posting refused';
    ok_count := ok_count + 1;
  END;

  -- 7. A posting with an invented side
  BEGIN
    INSERT INTO "ledger_postings" ("id", "entryId", "account", "side", "amount")
    VALUES ('guard-side', 'guard-test-entry', 'CASH_AT_BANK', 'SIDEWAYS', 5);
    RAISE WARNING 'FAIL  invalid posting side was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    invalid posting side refused';
    ok_count := ok_count + 1;
  END;

  RAISE NOTICE '--- ledger and audit: % passed, % failed ---', ok_count, fail_count;
END $$;

-- ---------------------------------------------------------------------------
-- Invoice and payment constraints
-- ---------------------------------------------------------------------------
INSERT INTO "patients" ("id", "ormRef", "fullName", "updatedAt")
VALUES ('guard-patient', 'orm-guard', 'Guard Test', NOW());

INSERT INTO "encounters" ("id", "patientId", "encounterNumber", "updatedAt")
VALUES ('guard-encounter', 'guard-patient', 'ENC-GUARD', NOW());

INSERT INTO "invoices" ("id", "invoiceNumber", "patientId", "encounterId", "patientName", "total", "updatedAt")
VALUES ('guard-invoice', 'INV-GUARD', 'guard-patient', 'guard-encounter', 'Guard Test', 100000, NOW());

DO $$
DECLARE
  ok_count INT := 0;
  fail_count INT := 0;
BEGIN
  -- 8. An invoice line whose total is not quantity x unit price
  BEGIN
    INSERT INTO "invoice_lines" ("id", "invoiceId", "kind", "description", "quantity", "unitPrice", "lineTotal")
    VALUES ('guard-line', 'guard-invoice', 'THEATRE', 'Bad arithmetic', 2, 5000, 99999);
    RAISE WARNING 'FAIL  invoice line with wrong arithmetic was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    invoice line arithmetic enforced (lineTotal = quantity x unitPrice)';
    ok_count := ok_count + 1;
  END;

  -- 9. A SUCCESSFUL payment with no trust basis — §2, in the database
  BEGIN
    INSERT INTO "payments" ("id", "invoiceId", "paymentNumber", "amount", "status", "channel", "updatedAt")
    VALUES ('guard-pay-1', 'guard-invoice', 'PAY-G1', 50000, 'SUCCESSFUL', 'CASH', NOW());
    RAISE WARNING 'FAIL  SUCCESSFUL payment with no trust basis was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    SUCCESSFUL payment with no trust basis refused';
    ok_count := ok_count + 1;
  END;

  -- 10. An ATTESTED payment naming nobody
  BEGIN
    INSERT INTO "payments" ("id", "invoiceId", "paymentNumber", "amount", "status", "channel", "trustBasis", "updatedAt")
    VALUES ('guard-pay-2', 'guard-invoice', 'PAY-G2', 50000, 'SUCCESSFUL', 'CASH', 'ATTESTED', NOW());
    RAISE WARNING 'FAIL  ATTESTED payment with no cashier or evidence was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ATTESTED payment with no cashier or evidence refused';
    ok_count := ok_count + 1;
  END;

  -- 11. A zero-amount payment
  BEGIN
    INSERT INTO "payments" ("id", "invoiceId", "paymentNumber", "amount", "status", "channel", "updatedAt")
    VALUES ('guard-pay-3', 'guard-invoice', 'PAY-G3', 0, 'PENDING', 'CASH', NOW());
    RAISE WARNING 'FAIL  zero-amount payment was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    zero-amount payment refused';
    ok_count := ok_count + 1;
  END;

  -- 12. A properly evidenced payment SHOULD be allowed
  BEGIN
    INSERT INTO "payments" ("id", "invoiceId", "paymentNumber", "amount", "status", "channel", "trustBasis",
                            "attestedByUserId", "evidenceRef", "updatedAt")
    VALUES ('guard-pay-ok', 'guard-invoice', 'PAY-GOK', 50000, 'SUCCESSFUL', 'CASH', 'ATTESTED',
            'cashier-1', 'teller-slip.jpg', NOW());
    RAISE NOTICE 'ok    properly evidenced ATTESTED payment allowed';
    ok_count := ok_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'FAIL  a valid payment was REFUSED: %', SQLERRM;
    fail_count := fail_count + 1;
  END;

  RAISE NOTICE '--- invoices and payments: % passed, % failed ---', ok_count, fail_count;
END $$;

-- ---------------------------------------------------------------------------
-- Vendor agreements: consent
-- ---------------------------------------------------------------------------
INSERT INTO "vendors" ("id", "code", "name", "updatedAt")
VALUES ('guard-vendor', 'V-GUARD', 'Guard Supplies Ltd', NOW());

DO $$
DECLARE
  ok_count INT := 0;
  fail_count INT := 0;
BEGIN
  -- 13. Creating an agreement ACTIVE with no signatures at all
  BEGIN
    INSERT INTO "vendor_agreements" ("id", "agreementNumber", "vendorId", "levyBasisPoints", "levyAccountId",
                                     "status", "effectiveFrom", "updatedAt")
    VALUES ('guard-agr-1', 'AGR-G1', 'guard-vendor', 1500, 'acct-x', 'ACTIVE', CURRENT_DATE, NOW());
    RAISE WARNING 'FAIL  ACTIVE agreement with NO signatures was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ACTIVE agreement with no signatures refused';
    ok_count := ok_count + 1;
  END;

  -- A draft agreement is fine.
  INSERT INTO "vendor_agreements" ("id", "agreementNumber", "vendorId", "levyBasisPoints", "levyAccountId",
                                   "status", "effectiveFrom", "updatedAt")
  VALUES ('guard-agr-2', 'AGR-G2', 'guard-vendor', 1500, 'acct-x', 'DRAFT', CURRENT_DATE, NOW());

  -- One signature only.
  INSERT INTO "agreement_signatures" ("id", "agreementId", "party", "signatoryName", "agreedLevyBasisPoints",
                                      "consentGiven", "signedAt")
  VALUES ('guard-sig-h', 'guard-agr-2', 'HOSPITAL', 'The Bursar', 1500, TRUE, NOW());

  -- 14. Activating with only ONE signature
  BEGIN
    UPDATE "vendor_agreements" SET "status" = 'ACTIVE' WHERE "id" = 'guard-agr-2';
    RAISE WARNING 'FAIL  ACTIVE agreement with ONE signature was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    ACTIVE agreement with only one signature refused';
    ok_count := ok_count + 1;
  END;

  -- Now the vendor signs too.
  INSERT INTO "agreement_signatures" ("id", "agreementId", "party", "signatoryName", "agreedLevyBasisPoints",
                                      "consentGiven", "signedAt")
  VALUES ('guard-sig-v', 'guard-agr-2', 'VENDOR', 'Guard Supplies Ltd', 1500, TRUE, NOW());

  -- 15. Both signed at 15% — activation SHOULD now be allowed
  BEGIN
    UPDATE "vendor_agreements" SET "status" = 'ACTIVE' WHERE "id" = 'guard-agr-2';
    RAISE NOTICE 'ok    ACTIVE agreement with both signatures allowed';
    ok_count := ok_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'FAIL  a fully signed agreement was REFUSED: %', SQLERRM;
    fail_count := fail_count + 1;
  END;

  -- 16. Moving the percentage out from under the signatures
  BEGIN
    UPDATE "vendor_agreements" SET "levyBasisPoints" = 2000 WHERE "id" = 'guard-agr-2';
    RAISE WARNING 'FAIL  levy changed under existing signatures was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    changing the levy under existing signatures refused';
    ok_count := ok_count + 1;
  END;

  -- 17. Rewriting what a signatory agreed to
  BEGIN
    UPDATE "agreement_signatures" SET "agreedLevyBasisPoints" = 2000 WHERE "id" = 'guard-sig-v';
    RAISE WARNING 'FAIL  rewriting an agreed percentage was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    rewriting what a signatory agreed to refused';
    ok_count := ok_count + 1;
  END;

  -- 18. Deleting a signature instead of revoking it
  BEGIN
    DELETE FROM "agreement_signatures" WHERE "id" = 'guard-sig-v';
    RAISE WARNING 'FAIL  deleting a signature was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    deleting a signature refused (revoke instead)';
    ok_count := ok_count + 1;
  END;

  -- 19. A levy above 100%
  BEGIN
    INSERT INTO "vendor_agreements" ("id", "agreementNumber", "vendorId", "levyBasisPoints", "levyAccountId",
                                     "status", "effectiveFrom", "updatedAt")
    VALUES ('guard-agr-3', 'AGR-G3', 'guard-vendor', 12000, 'acct-x', 'DRAFT', CURRENT_DATE, NOW());
    RAISE WARNING 'FAIL  a levy above 100%% was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    levy above 100%% refused';
    ok_count := ok_count + 1;
  END;

  RAISE NOTICE '--- vendor agreements: % passed, % failed ---', ok_count, fail_count;
END $$;

-- ---------------------------------------------------------------------------
-- Settlements
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ok_count INT := 0;
  fail_count INT := 0;
BEGIN
  -- 20. A CONFIRMED settlement with no bank reference (§51)
  BEGIN
    INSERT INTO "settlements" ("id", "settlementNumber", "accountId", "amount", "status", "updatedAt")
    VALUES ('guard-set-1', 'SET-G1', 'acct-x', 100000, 'CONFIRMED', NOW());
    RAISE WARNING 'FAIL  CONFIRMED settlement with no bank reference was ALLOWED';
    fail_count := fail_count + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    CONFIRMED settlement with no bank reference refused';
    ok_count := ok_count + 1;
  END;

  RAISE NOTICE '--- settlements: % passed, % failed ---', ok_count, fail_count;
END $$;

ROLLBACK;
