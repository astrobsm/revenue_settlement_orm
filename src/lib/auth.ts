// ============================================================
// Authentication (§42)
// ------------------------------------------------------------
// Credentials against this application's own user table. Two decisions here are
// security-relevant rather than stylistic:
//
// THE SESSION CARRIES AN ID AND NOTHING ELSE THAT MATTERS. Roles are NOT put in
// the token. A token is a snapshot of who someone was when they signed in, and a
// role revoked at 09:00 would otherwise keep working until the token expired.
// apiGuard re-reads roles and account status from the database on every request.
//
// FAILED SIGN-INS ARE COUNTED AND THE ACCOUNT LOCKS. Without it, a cashier
// account with payment:confirm is open to unlimited password guessing.
// ============================================================

import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import prisma from './prisma';
import { verifyBackupCode, verifyTotp } from './mfa';
import { decryptField } from './crypto';

/** Consecutive failures before an account is locked, and for how long. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    // A revenue desk is a shared physical space. A session left open on a
    // terminal is somebody else's authority to take money.
    maxAge: 8 * 60 * 60,
  },

  pages: { signIn: '/auth/signin' },

  providers: [
    CredentialsProvider({
      name: 'Staff sign-in',
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' },
        /** Six digits from an authenticator, or a backup code. */
        totp: { label: 'Authentication code', type: 'text' },
      },

      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });

        // The same generic failure is returned whether the account exists, the
        // password is wrong, or the account is locked. Distinguishing them tells
        // an attacker which staff emails are real.
        if (!user) {
          // Hash anyway, so a missing account does not return measurably faster
          // than a wrong password and become an account-enumeration oracle.
          await bcrypt.compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
          return null;
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) return null;
        if (user.status !== 'ACTIVE') return null;

        const valid = await bcrypt.compare(password, user.passwordHash);

        if (!valid) {
          const failed = user.failedLogins + 1;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLogins: failed,
              lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
            },
          });
          return null;
        }

        // --- The second factor (§42) -------------------------------------
        //
        // Checked AFTER the password, and only once the password is right, so a
        // wrong password and a wrong code are indistinguishable to anyone
        // guessing. Checked BEFORE any session exists, because a session issued
        // on a password alone is a session that skipped the second factor.
        if (user.mfaEnabled && user.mfaSecret) {
          const submitted = credentials?.totp?.trim() ?? '';
          if (!submitted) return null;

          let accepted = false;
          let usedCounter: number | null = null;
          let usedBackupHash: string | undefined;

          if (/^\d{6}$/.test(submitted.replace(/\s/g, ''))) {
            try {
              const verdict = verifyTotp({
                secretBase32: decryptField(user.mfaSecret),
                code: submitted,
                lastUsedCounter: user.mfaLastCounter,
              });
              accepted = verdict.valid;
              usedCounter = verdict.counter ?? null;
            } catch {
              // An unreadable secret must never fall through to "allowed".
              accepted = false;
            }
          } else {
            const backup = verifyBackupCode({ code: submitted, hashes: user.mfaBackupCodes });
            accepted = backup.valid;
            usedBackupHash = backup.usedHash;
          }

          if (!accepted) {
            // A wrong code counts towards the lockout exactly as a wrong password
            // does. Otherwise the second factor is brute-forceable at thousands
            // of guesses a minute while the first is not — and six digits is only
            // a million possibilities.
            const failedMfa = user.failedLogins + 1;
            await prisma.user.update({
              where: { id: user.id },
              data: {
                failedLogins: failedMfa,
                lockedUntil: failedMfa >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
              },
            });
            return null;
          }

          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLogins: 0,
              lockedUntil: null,
              lastLoginAt: new Date(),
              // Recording the counter is what makes a code single-use.
              ...(usedCounter !== null ? { mfaLastCounter: usedCounter } : {}),
              // A backup code is struck off the moment it is used.
              ...(usedBackupHash
                ? { mfaBackupCodes: user.mfaBackupCodes.filter((h) => h !== usedBackupHash) }
                : {}),
            },
          });

          return { id: user.id, name: user.fullName, email: user.email };
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
        });

        return { id: user.id, name: user.fullName, email: user.email };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      return session;
    },
  },
};
