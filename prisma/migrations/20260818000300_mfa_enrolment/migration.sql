-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfaBackupCodes" TEXT[],
ADD COLUMN     "mfaEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "mfaLastCounter" INTEGER;

