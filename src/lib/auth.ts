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
