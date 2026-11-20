-- Cluster roles for Flexa (ADR-0003 §2). Executed once per database by a superuser:
--   docker:  infra/postgres/init/01-roles.sh (psql variables)
--   tests:   @flexa/test-utils applyRolesSql() (same file, variables substituted)
-- Variables: owner_password, app_password, relay_password, db_name

-- Migration/owner role. BYPASSRLS so SECURITY DEFINER resolver functions owned by it can see rows
-- before a tenant context exists; the application never connects with this role.
CREATE ROLE flexa_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS PASSWORD :'owner_password';

-- Application role: no RLS bypass, owns nothing.
CREATE ROLE flexa_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'app_password';

-- Outbox relay (Faz 5): BYPASSRLS, but table grants restrict it to outbox_events only.
CREATE ROLE flexa_relay LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS PASSWORD :'relay_password';

ALTER DATABASE :"db_name" OWNER TO flexa_owner;
ALTER SCHEMA public OWNER TO flexa_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO flexa_app, flexa_relay;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO flexa_owner, flexa_app, flexa_relay;
