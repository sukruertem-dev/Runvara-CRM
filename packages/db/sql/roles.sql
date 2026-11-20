-- Cluster roles for Runvara (ADR-0003 §2). Executed once per database by a superuser:
--   docker:  infra/postgres/init/01-roles.sh (psql variables)
--   tests:   @runvara/test-utils applyRolesSql() (same file, variables substituted)
-- Variables: owner_password, app_password, relay_password, db_name

-- Migration/owner role. BYPASSRLS so SECURITY DEFINER resolver functions owned by it can see rows
-- before a tenant context exists; the application never connects with this role.
CREATE ROLE runvara_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS PASSWORD :'owner_password';

-- Application role: no RLS bypass, owns nothing.
CREATE ROLE runvara_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'app_password';

-- Outbox relay (Faz 5): BYPASSRLS, but table grants restrict it to outbox_events only.
CREATE ROLE runvara_relay LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS PASSWORD :'relay_password';

ALTER DATABASE :"db_name" OWNER TO runvara_owner;
ALTER SCHEMA public OWNER TO runvara_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO runvara_app, runvara_relay;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO runvara_owner, runvara_app, runvara_relay;
