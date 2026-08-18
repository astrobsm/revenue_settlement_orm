'use client';

import { SessionProvider } from 'next-auth/react';

/**
 * The session context.
 *
 * Deliberately does NOT poll to refresh: at a revenue desk the browser sits open
 * all day, and a background request every minute is noise on a connection that
 * may be shared with theatre systems. The session's own 8-hour expiry is the
 * control, and every API route re-reads roles and account status from the
 * database on each request anyway.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider refetchInterval={0} refetchOnWindowFocus={false}>{children}</SessionProvider>;
}
