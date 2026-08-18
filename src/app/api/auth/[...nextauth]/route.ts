// ============================================================
// NextAuth's own endpoints
// ------------------------------------------------------------
// Sign-in, sign-out, session and CSRF. The configuration — including the second
// factor check — lives in lib/auth.ts; this only mounts it.
// ============================================================

import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
