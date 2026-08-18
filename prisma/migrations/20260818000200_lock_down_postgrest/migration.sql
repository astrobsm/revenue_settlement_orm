-- ============================================================================
-- Closing the PostgREST door (§27, §42, §55)
-- ----------------------------------------------------------------------------
-- THIS MIGRATION EXISTS BECAUSE OF ONE PROPERTY OF SUPABASE.
--
-- Supabase runs PostgREST over the `public` schema and publishes EVERY table in
-- it as a REST endpoint. Those endpoints are reachable with the `anon` key —
-- which is not a secret. It is designed to be embedded in browser JavaScript and
-- is printed in the project dashboard for exactly that purpose.
--
-- The protection Supabase relies on is ROW LEVEL SECURITY. A table without RLS
-- is readable by anyone holding the anon key, which is to say: by anyone. On a
-- blog that is a design choice. On this database it would publish every
-- patient's name, diagnosis-bearing charge description, invoice total and
-- payment record to the open internet, and let them be written to as well.
--
-- Prisma does not create tables with RLS enabled, and nothing in the schema
-- turns it on. So without this migration, moving to Supabase would silently
-- expose the entire revenue and patient dataset the moment the project is
-- created.
--
-- WHAT THIS DOES, AND WHY IT IS THE RIGHT SHAPE
--
-- This application does NOT use Supabase's client-side SDK, its Auth, or its
-- auto-generated API. It reaches the database only through Prisma, over a
-- server-side connection, as a role that owns the schema. Every access decision
-- is made in lib/apiGuard.ts — permissions, MFA and separation of duties — and
-- none of it can be expressed in an RLS policy, because "may this person confirm
-- this payment given what they did to the invoice earlier" is not a row
-- predicate.
--
-- Therefore the correct posture is NOT to write permissive RLS policies. It is
-- to enable RLS with NO POLICIES AT ALL and revoke the API roles' privileges
-- outright. RLS with no policy denies everything to every role that is not the
-- owner and is not BYPASSRLS. The application's own connection is unaffected;
-- PostgREST is shut out completely.
--
-- Belt and braces, deliberately: the GRANT revocations alone would suffice, and
-- so would RLS alone. Both are applied because this is the difference between a
-- private financial database and a public one, and a single missed step in
-- either mechanism is not an acceptable failure mode.
--
-- RUNS ANYWHERE. The anon/authenticated/service_role roles exist only on
-- Supabase, so every reference to them is guarded. On a plain Postgres this
-- migration enables RLS and does nothing else.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on every table in the public schema, with no policies.
-- ---------------------------------------------------------------------------
-- Applied by loop rather than by listing tables, so a table added in a later
-- migration is covered the moment this is re-run — and a forgotten table is the
-- whole risk being defended against here.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '\_prisma%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    -- FORCE applies RLS to the table owner as well. Deliberately NOT used: the
    -- application connects as the owner and must continue to work. The owner is
    -- a server-side role holding a secret; the API roles are the exposure.
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Revoke everything from the PostgREST roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN

      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);

      -- Without this, the role can still see that the tables exist and what
      -- their columns are called. A schema is a map of what is worth attacking.
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', api_role);

      -- The one that is missed most often: default privileges apply to tables
      -- created in FUTURE migrations. Revoking only what exists today leaves
      -- tomorrow's tables exposed.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);

      RAISE NOTICE 'PostgREST role % has been revoked all access to the public schema.', api_role;
    END IF;
  END LOOP;

  -- service_role is left alone. It BYPASSES RLS by design and its key is a
  -- server-side secret, never shipped to a browser. Revoking it would break
  -- Supabase's own dashboard and backup tooling. It must be treated with the
  -- same care as the database password — see the note in .env.example.
END $$;

-- ---------------------------------------------------------------------------
-- 3. Prove it: refuse to complete if any table is left unprotected.
-- ---------------------------------------------------------------------------
-- A migration that silently half-applies a security control is worse than one
-- that fails, because it leaves everyone believing the control is in place.
DO $$
DECLARE
  unprotected TEXT[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE '\_prisma%'
    AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL AND array_length(unprotected, 1) > 0 THEN
    RAISE EXCEPTION
      'Row level security is not enabled on: %. On Supabase these tables would be readable and writable by anyone holding the anon key, which is public by design.',
      array_to_string(unprotected, ', ');
  END IF;

  RAISE NOTICE 'Row level security is enabled on every table in the public schema.';
END $$;
