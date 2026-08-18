-- CreateEnum
CREATE TYPE "RevenueRole" AS ENUM ('REVENUE_OFFICER', 'CASHIER', 'FINANCE_OFFICER', 'FINANCE_ADMINISTRATOR', 'AUDITOR', 'SUPER_ADMINISTRATOR', 'SURGEON', 'ANAESTHETIST', 'PHARMACY', 'STORES', 'LABORATORY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ChargeKind" AS ENUM ('PROFESSIONAL_SURGEON', 'PROFESSIONAL_ANAESTHETIST', 'PROFESSIONAL_OTHER', 'THEATRE', 'ANAESTHESIA_DRUG', 'ANAESTHESIA_CONSUMABLE', 'DRUG', 'IV_FLUID', 'CONSUMABLE', 'IMPLANT', 'CSSD', 'ADMISSION_DEPOSIT', 'BED_CHARGE', 'NURSING', 'INVESTIGATION_LAB', 'INVESTIGATION_IMAGING', 'BLOOD', 'OXYGEN', 'RECOVERY', 'POSTOP_SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'AWAITING_APPROVAL', 'APPROVED', 'BILLED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERPAID', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'PENDING', 'INITIATED', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "TrustBasis" AS ENUM ('GATEWAY_VERIFIED', 'BANK_CONFIRMED', 'ATTESTED');

-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('CARD', 'BANK_TRANSFER', 'USSD', 'POS', 'PAYMENT_LINK', 'CASH', 'CHEQUE', 'NHIS', 'HMO', 'WAIVER');

-- CreateEnum
CREATE TYPE "BeneficiaryType" AS ENUM ('HOSPITAL', 'HOSPITAL_DEVELOPMENT', 'DEPARTMENT', 'THEATRE', 'PHARMACY', 'LABORATORY', 'RADIOLOGY', 'CSSD', 'BLOOD_BANK', 'PROFESSIONAL_POOL', 'CONSUMABLE_PROVIDER', 'EXTERNAL_VENDOR', 'COST_CENTRE');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'AWAITING_SIGNATURES', 'ACTIVE', 'SUSPENDED', 'SUPERSEDED', 'TERMINATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SignatoryParty" AS ENUM ('HOSPITAL', 'VENDOR', 'WITNESS');

-- CreateEnum
CREATE TYPE "AllocationRuleType" AS ENUM ('FIXED', 'TIERED', 'PERCENTAGE', 'RESIDUAL');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'SETTLEMENT_INITIATED', 'SETTLED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'INITIATED', 'PROCESSING', 'CONFIRMED', 'FAILED', 'PARTIALLY_CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'REFUNDED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('CREDIT_NOTE', 'ADDITIONAL_CHARGE', 'WRITE_OFF', 'WAIVER', 'CORRECTION');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ACCOUNTS_RECEIVABLE', 'CASH_AT_BANK', 'PATIENT_DEPOSIT_LIABILITY', 'REVENUE', 'SETTLEMENT_PAYABLE', 'REFUND_PAYABLE', 'TAX_PAYABLE', 'DISCOUNT_GIVEN', 'SUSPENSE');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('INVOICE_ISSUED', 'PAYMENT_RECEIVED', 'DEPOSIT_RECEIVED', 'DEPOSIT_APPLIED', 'REVENUE_ALLOCATED', 'SETTLEMENT_INITIATED', 'SETTLEMENT_CONFIRMED', 'SETTLEMENT_FAILED', 'REFUND_APPROVED', 'REFUND_PAID', 'PAYMENT_REVERSED', 'ADJUSTMENT', 'DISCOUNT_APPLIED', 'RECONCILIATION_DIFFERENCE');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('PAYMENT_WITHOUT_INVOICE', 'INVOICE_PAID_WITHOUT_GATEWAY_RECORD', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DUPLICATE_TRANSACTION', 'SETTLEMENT_AMOUNT_MISMATCH', 'FAILED_SETTLEMENT', 'REVERSED_PAYMENT', 'UNRECONCILED_ATTESTED_PAYMENT', 'ALLOCATION_DOES_NOT_SUM', 'LEDGER_OUT_OF_BALANCE', 'UNMATCHED_BANK_CREDIT');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "ApprovalSubject" AS ENUM ('PRICE_OVERRIDE', 'DISCOUNT', 'WAIVER', 'REFUND', 'ADJUSTMENT', 'ALLOCATION_RULE_CHANGE', 'REVENUE_ACCOUNT_CHANGE', 'INVOICE_CANCELLATION', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('INVOICE_GENERATED', 'PAYMENT_INITIATED', 'PAYMENT_SUCCESSFUL', 'PAYMENT_FAILED', 'PAYMENT_REVERSED', 'PAYMENT_PARTIAL', 'ALLOCATION_COMPLETED', 'SETTLEMENT_INITIATED', 'SETTLEMENT_COMPLETED', 'SETTLEMENT_FAILED', 'REFUND_REQUESTED', 'REFUND_APPROVED', 'RECONCILIATION_DISCREPANCY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "staffNumber" TEXT,
    "designation" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RevenueRole" NOT NULL,
    "grantedById" TEXT,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "categoryId" TEXT,
    "quantityAllowed" BOOLEAN NOT NULL DEFAULT true,
    "discountEligible" BOOLEAN NOT NULL DEFAULT true,
    "taxBasisPoints" INTEGER,
    "requiresProviderRole" "RevenueRole",
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariffs" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "reason" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "ormRef" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "hospitalNumber" TEXT,
    "folderNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounters" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "ormRef" TEXT,
    "ormKind" TEXT,
    "encounterNumber" TEXT NOT NULL,
    "procedure" TEXT,
    "theatre" TEXT,
    "surgeonName" TEXT,
    "anaesthetistName" TEXT,
    "serviceDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "serviceId" TEXT,
    "kind" "ChargeKind" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "tariffId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "overrideAccountId" TEXT,
    "status" "ChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "originalUnitPrice" INTEGER,
    "overrideReason" TEXT,
    "overrideRequestedById" TEXT,
    "overrideApprovedById" TEXT,
    "overrideApprovedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "depositComponent" INTEGER NOT NULL DEFAULT 0,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "discountApprovedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "paymentToken" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "issuedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "chargeId" TEXT,
    "serviceId" TEXT,
    "kind" "ChargeKind" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "tariffId" TEXT,
    "isDeposit" BOOLEAN NOT NULL DEFAULT false,
    "overrideAccountId" TEXT,
    "sourceKind" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supportsNativeSplit" BOOLEAN NOT NULL DEFAULT false,
    "secretEnvKey" TEXT,
    "webhookEnvKey" TEXT,
    "supportedChannels" "PaymentChannel"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "PaymentChannel" NOT NULL,
    "trustBasis" "TrustBasis",
    "providerId" TEXT,
    "providerTransactionId" TEXT,
    "bankReference" TEXT,
    "attestedByUserId" TEXT,
    "attestedByName" TEXT,
    "evidenceRef" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "reversedById" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "providerId" TEXT,
    "operation" TEXT NOT NULL,
    "providerStatus" TEXT,
    "providerReference" TEXT,
    "providerAmount" INTEGER,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "httpStatus" INTEGER,
    "signatureValid" BOOLEAN,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "beneficiaryType" "BeneficiaryType" NOT NULL,
    "departmentName" TEXT,
    "costCentre" TEXT,
    "bankName" TEXT,
    "accountNumberEncrypted" TEXT,
    "accountNumberLast4" TEXT,
    "accountName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "providerSubaccountCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "address" TEXT,
    "rcNumber" TEXT,
    "tinNumber" TEXT,
    "revenueAccountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_agreements" (
    "id" TEXT NOT NULL,
    "agreementNumber" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "levyBasisPoints" INTEGER NOT NULL,
    "levyAccountId" TEXT NOT NULL,
    "coveredKinds" "ChargeKind"[],
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "termsText" TEXT,
    "title" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "supersededById" TEXT,
    "supersedesAgreementId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "activatedById" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "terminatedById" TEXT,
    "terminationReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_signatures" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "party" "SignatoryParty" NOT NULL,
    "signatoryName" TEXT NOT NULL,
    "signatoryDesignation" TEXT,
    "signatoryEmail" TEXT,
    "signedByUserId" TEXT,
    "signatureDataUrl" TEXT,
    "agreedLevyBasisPoints" INTEGER NOT NULL,
    "consentStatement" TEXT,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "agreement_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_rules" (
    "id" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "AllocationRuleType" NOT NULL,
    "amount" INTEGER,
    "shareBasisPoints" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "notes" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributions" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT,
    "invoiceLineId" TEXT,
    "accountId" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "ruleType" "AllocationRuleType" NOT NULL,
    "shareBasisPoints" INTEGER,
    "ruleId" TEXT,
    "status" "DistributionStatus" NOT NULL DEFAULT 'PENDING',
    "settlementItemId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "reversedByDistributionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "settlementNumber" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "method" TEXT NOT NULL DEFAULT 'MANUAL_TRANSFER',
    "initiatedAt" TIMESTAMP(3),
    "initiatedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "bankReference" TEXT,
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_items" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "distributionIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "depositNumber" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountApplied" INTEGER NOT NULL DEFAULT 0,
    "amountRefunded" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "paymentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_applications" (
    "id" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "kind" "ChargeKind",
    "appliedById" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "refundNumber" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "bankReference" TEXT,
    "providerRefundId" TEXT,
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "requiresRecovery" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustments" (
    "id" TEXT NOT NULL,
    "adjustmentNumber" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "AdjustmentKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "eventType" "LedgerEventType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "settlementId" TEXT,
    "refundId" TEXT,
    "depositId" TEXT,
    "reversesEntryId" TEXT,
    "memo" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_postings" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "account" "LedgerAccountType" NOT NULL,
    "side" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "revenueAccountId" TEXT,
    "chargeKind" "ChargeKind",
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
    "totalInvoiced" INTEGER NOT NULL DEFAULT 0,
    "totalCollected" INTEGER NOT NULL DEFAULT 0,
    "totalAllocated" INTEGER NOT NULL DEFAULT 0,
    "totalSettled" INTEGER NOT NULL DEFAULT 0,
    "totalBankCredits" INTEGER,
    "exceptionsFound" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "runById" TEXT,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_exceptions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "expectedAmount" INTEGER,
    "actualAmount" INTEGER,
    "difference" INTEGER,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "settlementId" TEXT,
    "providerReference" TEXT,
    "detail" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountPaid" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "verificationCode" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintedAt" TIMESTAMP(3),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "subject" "ApprovalSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestReason" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "previousAmount" INTEGER,
    "newAmount" INTEGER,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "duty" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "userRole" TEXT,
    "patientId" TEXT,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "previousValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "approvalId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" TEXT,
    "sodOverridden" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" TEXT NOT NULL DEFAULT 'STRING',
    "description" TEXT,
    "sourceReference" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "event" "NotificationEvent" NOT NULL,
    "recipientUserId" TEXT,
    "recipientRole" "RevenueRole",
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "settlementId" TEXT,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sendFailure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "role_assignments_role_isActive_idx" ON "role_assignments"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_userId_role_key" ON "role_assignments"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");

-- CreateIndex
CREATE INDEX "services_kind_isActive_idx" ON "services"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_code_key" ON "service_categories"("code");

-- CreateIndex
CREATE INDEX "tariffs_serviceId_effectiveFrom_idx" ON "tariffs"("serviceId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "patients_ormRef_key" ON "patients"("ormRef");

-- CreateIndex
CREATE INDEX "patients_hospitalNumber_idx" ON "patients"("hospitalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "encounters_encounterNumber_key" ON "encounters"("encounterNumber");

-- CreateIndex
CREATE INDEX "encounters_patientId_idx" ON "encounters"("patientId");

-- CreateIndex
CREATE INDEX "encounters_ormRef_idx" ON "encounters"("ormRef");

-- CreateIndex
CREATE INDEX "charges_encounterId_status_idx" ON "charges"("encounterId", "status");

-- CreateIndex
CREATE INDEX "charges_kind_idx" ON "charges"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_paymentToken_key" ON "invoices"("paymentToken");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoices_patientId_idx" ON "invoices"("patientId");

-- CreateIndex
CREATE INDEX "invoices_issuedAt_idx" ON "invoices"("issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_chargeId_key" ON "invoice_lines"("chargeId");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_lines_kind_idx" ON "invoice_lines"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providers_code_key" ON "payment_providers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentNumber_key" ON "payments"("paymentNumber");

-- CreateIndex
CREATE INDEX "payments_invoiceId_idx" ON "payments"("invoiceId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_providerTransactionId_idx" ON "payments"("providerTransactionId");

-- CreateIndex
CREATE INDEX "payments_confirmedAt_idx" ON "payments"("confirmedAt");

-- CreateIndex
CREATE INDEX "payment_transactions_paymentId_occurredAt_idx" ON "payment_transactions"("paymentId", "occurredAt");

-- CreateIndex
CREATE INDEX "payment_transactions_providerReference_idx" ON "payment_transactions"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_scope_createdAt_idx" ON "idempotency_keys"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_accounts_code_key" ON "revenue_accounts"("code");

-- CreateIndex
CREATE INDEX "revenue_accounts_beneficiaryType_isActive_idx" ON "revenue_accounts"("beneficiaryType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_code_key" ON "vendors"("code");

-- CreateIndex
CREATE INDEX "vendors_isActive_idx" ON "vendors"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_agreements_agreementNumber_key" ON "vendor_agreements"("agreementNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_agreements_supersededById_key" ON "vendor_agreements"("supersededById");

-- CreateIndex
CREATE INDEX "vendor_agreements_vendorId_status_idx" ON "vendor_agreements"("vendorId", "status");

-- CreateIndex
CREATE INDEX "vendor_agreements_status_effectiveFrom_idx" ON "vendor_agreements"("status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "agreement_signatures_agreementId_idx" ON "agreement_signatures"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_signatures_agreementId_party_key" ON "agreement_signatures"("agreementId", "party");

-- CreateIndex
CREATE INDEX "allocation_rules_kind_effectiveFrom_idx" ON "allocation_rules"("kind", "effectiveFrom");

-- CreateIndex
CREATE INDEX "allocation_rules_accountId_idx" ON "allocation_rules"("accountId");

-- CreateIndex
CREATE INDEX "distributions_invoiceId_idx" ON "distributions"("invoiceId");

-- CreateIndex
CREATE INDEX "distributions_accountId_status_idx" ON "distributions"("accountId", "status");

-- CreateIndex
CREATE INDEX "distributions_paymentId_idx" ON "distributions"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_settlementNumber_key" ON "settlements"("settlementNumber");

-- CreateIndex
CREATE INDEX "settlements_accountId_status_idx" ON "settlements"("accountId", "status");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

-- CreateIndex
CREATE INDEX "settlement_items_settlementId_idx" ON "settlement_items"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_depositNumber_key" ON "deposits"("depositNumber");

-- CreateIndex
CREATE INDEX "deposits_patientId_idx" ON "deposits"("patientId");

-- CreateIndex
CREATE INDEX "deposits_encounterId_idx" ON "deposits"("encounterId");

-- CreateIndex
CREATE INDEX "deposit_applications_depositId_idx" ON "deposit_applications"("depositId");

-- CreateIndex
CREATE INDEX "deposit_applications_invoiceId_idx" ON "deposit_applications"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refundNumber_key" ON "refunds"("refundNumber");

-- CreateIndex
CREATE INDEX "refunds_invoiceId_idx" ON "refunds"("invoiceId");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "adjustments_adjustmentNumber_key" ON "adjustments"("adjustmentNumber");

-- CreateIndex
CREATE INDEX "adjustments_invoiceId_idx" ON "adjustments"("invoiceId");

-- CreateIndex
CREATE INDEX "ledger_entries_eventType_occurredAt_idx" ON "ledger_entries"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "ledger_entries_invoiceId_idx" ON "ledger_entries"("invoiceId");

-- CreateIndex
CREATE INDEX "ledger_entries_paymentId_idx" ON "ledger_entries"("paymentId");

-- CreateIndex
CREATE INDEX "ledger_entries_occurredAt_idx" ON "ledger_entries"("occurredAt");

-- CreateIndex
CREATE INDEX "ledger_postings_entryId_idx" ON "ledger_postings"("entryId");

-- CreateIndex
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings"("account");

-- CreateIndex
CREATE INDEX "ledger_postings_revenueAccountId_idx" ON "ledger_postings"("revenueAccountId");

-- CreateIndex
CREATE INDEX "reconciliation_runs_periodStart_idx" ON "reconciliation_runs"("periodStart");

-- CreateIndex
CREATE INDEX "reconciliation_runs_status_idx" ON "reconciliation_runs"("status");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_runId_status_idx" ON "reconciliation_exceptions"("runId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_type_status_idx" ON "reconciliation_exceptions"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_receiptNumber_key" ON "receipts"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_verificationCode_key" ON "receipts"("verificationCode");

-- CreateIndex
CREATE INDEX "receipts_invoiceId_idx" ON "receipts"("invoiceId");

-- CreateIndex
CREATE INDEX "receipts_paymentId_idx" ON "receipts"("paymentId");

-- CreateIndex
CREATE INDEX "approvals_subject_decision_idx" ON "approvals"("subject", "decision");

-- CreateIndex
CREATE INDEX "approvals_subjectId_idx" ON "approvals"("subjectId");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_occurredAt_idx" ON "audit_logs"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_duty_idx" ON "audit_logs"("duty");

-- CreateIndex
CREATE INDEX "audit_logs_invoiceId_idx" ON "audit_logs"("invoiceId");

-- CreateIndex
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_settings_key_key" ON "organisation_settings"("key");

-- CreateIndex
CREATE INDEX "notifications_recipientUserId_readAt_idx" ON "notifications"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_recipientRole_createdAt_idx" ON "notifications"("recipientRole", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_event_idx" ON "notifications"("event");

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "tariffs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_agreements" ADD CONSTRAINT "vendor_agreements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "vendor_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "revenue_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "invoice_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "revenue_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "revenue_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "revenue_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_applications" ADD CONSTRAINT "deposit_applications_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_applications" ADD CONSTRAINT "deposit_applications_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ledger_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

