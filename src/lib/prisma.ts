// ============================================================
// The Prisma client
// ------------------------------------------------------------
// One instance per process. In development Next.js reloads modules on every
// edit, and a fresh PrismaClient per reload exhausts Postgres connections within
// a few minutes — hence the global cache, which is the standard remedy.
// ============================================================

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Queries are logged in development only. A query log in production would
    // write patient identifiers and amounts into wherever stdout goes.
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
