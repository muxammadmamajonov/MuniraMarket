-- One-time ownership adoption for a MuniraMarket database that was migrated before
-- the dedicated `mm_migrator` role existed.
--
-- Run ONLY as the Neon project owner, after 01-roles.sql and before the first
-- migration run as mm_migrator:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -f infra/neon/sql/00-adopt-legacy-public-schema.sql
--
-- This intentionally touches a small, explicit allowlist of objects created by
-- revisions 0001–0004 in the application's `public` schema. It does not alter
-- Neon Auth, the Data API, buckets, other schemas or database ownership; a
-- temporary role membership needed by PostgreSQL's ownership rule is revoked
-- before the transaction commits.
-- It is idempotent: re-running it leaves objects already owned by mm_migrator
-- unchanged. Update this list only alongside a reviewed migration that creates
-- an object before the role model is installed.

\set ON_ERROR_STOP on

DO $$
DECLARE
  table_name text;
  type_name text;
  owner_was_member boolean;
  expected_tables constant text[] := ARRAY[
    'alembic_version',
    'audit_log',
    'cart_items',
    'carts',
    'categories',
    'delivery_slots',
    'delivery_zone_districts',
    'delivery_zones',
    'notification_outbox',
    'order_items',
    'order_status_history',
    'orders',
    'products',
    'users'
  ];
  expected_types constant text[] := ARRAY[
    'language',
    'order_status',
    'payment_method',
    'unit',
    'user_role'
  ];
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mm_migrator') THEN
    RAISE EXCEPTION 'mm_migrator is missing; run 01-roles.sql first';
  END IF;

  -- PostgreSQL allows an object owner to hand ownership to a role only when it
  -- is also a member of that role. The Neon owner created mm_migrator but is
  -- not inherently its member, so add the membership only for this transaction
  -- and remove it before commit. Preserve a pre-existing membership unchanged.
  owner_was_member := pg_has_role(current_user, 'mm_migrator', 'MEMBER');
  IF NOT owner_was_member THEN
    EXECUTE format('GRANT %I TO %I', 'mm_migrator', current_user);
  END IF;

  -- Refuse to make a broad change if this is not exactly the known pre-role
  -- MuniraMarket public schema. This guards against accidentally adopting an
  -- unrelated service table into the application's migration role.
  IF EXISTS (
    SELECT
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> ALL (expected_tables)
  ) THEN
    RAISE EXCEPTION 'unexpected public table exists; inspect it before adopting ownership';
  END IF;

  FOREACH table_name IN ARRAY expected_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'expected legacy table public.% is missing', table_name;
    END IF;
    IF EXISTS (
      SELECT
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = table_name
        AND c.relowner = 'mm_migrator'::regrole
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I OWNER TO mm_migrator', table_name);
  END LOOP;

  FOREACH type_name IN ARRAY expected_types LOOP
    IF NOT EXISTS (
      SELECT
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = type_name AND t.typtype = 'e'
    ) THEN
      RAISE EXCEPTION 'expected legacy enum public.% is missing', type_name;
    END IF;
    IF EXISTS (
      SELECT
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = type_name
        AND t.typtype = 'e'
        AND t.typowner = 'mm_migrator'::regrole
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TYPE public.%I OWNER TO mm_migrator', type_name);
  END LOOP;

  -- UUID primary keys mean revisions 0001–0004 create no application sequences.
  -- Fail closed if that ever changes instead of silently leaving an object owned
  -- by the owner role.
  IF EXISTS (
    SELECT
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  ) THEN
    RAISE EXCEPTION 'public sequences exist; review and adopt them explicitly';
  END IF;

  IF NOT owner_was_member THEN
    EXECUTE format('REVOKE %I FROM %I', 'mm_migrator', current_user);
  END IF;
END
$$;
