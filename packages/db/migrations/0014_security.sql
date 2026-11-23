-- P7d (TEN-04, docs/p7-plan.md §18–20): SAML providers next to OIDC, the password measure a session was
-- opened with (tenant password rules, B77), provider discovery by e-mail domain.

-- ---------------------------------------------------------------------------------------------
-- SAML 2.0 providers. OIDC columns are empty for SAML and the SAML columns for OIDC (one CHECK per kind).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenant_sso_providers DROP CONSTRAINT tenant_sso_providers_kind_check;
ALTER TABLE tenant_sso_providers
  ALTER COLUMN issuer DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN client_secret_enc DROP NOT NULL,
  ALTER COLUMN key_version DROP NOT NULL,
  ADD COLUMN idp_entity_id text,
  ADD COLUMN idp_sso_url   text,
  ADD COLUMN idp_certs     text[];
ALTER TABLE tenant_sso_providers
  ADD CONSTRAINT tenant_sso_providers_kind_check CHECK (kind IN ('oidc', 'saml')),
  ADD CONSTRAINT tenant_sso_providers_oidc_fields CHECK (kind <> 'oidc' OR (
    issuer IS NOT NULL AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL AND key_version IS NOT NULL
    AND idp_entity_id IS NULL AND idp_sso_url IS NULL AND idp_certs IS NULL)),
  ADD CONSTRAINT tenant_sso_providers_saml_fields CHECK (kind <> 'saml' OR (
    idp_entity_id IS NOT NULL AND idp_sso_url IS NOT NULL AND cardinality(idp_certs) BETWEEN 1 AND 3
    AND issuer IS NULL AND client_id IS NULL AND client_secret_enc IS NULL)),
  ADD CONSTRAINT tenant_sso_providers_domains CHECK (cardinality(email_domains) BETWEEN 1 AND 20);

GRANT DELETE ON tenant_sso_providers TO flexa_app;

-- Enabled providers of active workspaces that accept an e-mail domain (login page "Sign in with SSO").
-- Returns no tenant information: only what the login button needs.
CREATE FUNCTION app.sso_providers_for_domain(p_domain text) RETURNS TABLE (id uuid, name text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id, p.name, p.kind FROM tenant_sso_providers p JOIN tenants t ON t.id = p.tenant_id
  WHERE p.enabled AND t.status IN ('trial', 'active') AND lower(p_domain) = ANY (p.email_domains)
  ORDER BY p.name, p.id
  LIMIT 10
$$;
REVOKE ALL ON FUNCTION app.sso_providers_for_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sso_providers_for_domain(text) TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- The measure of the password a session was opened with: length and whether it mixes upper case, lower
-- case and digits. Never the password itself. Null for sessions opened another way (SSO) or before P7d.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth_sessions ADD COLUMN password_profile jsonb
  CHECK (password_profile IS NULL OR (jsonb_typeof(password_profile -> 'length') = 'number' AND jsonb_typeof(password_profile -> 'mixed') = 'boolean'));

-- find_refresh_token also returns the session's opening and last use (session length policy).
DROP FUNCTION app.find_refresh_token(bytea);
CREATE FUNCTION app.find_refresh_token(p_hash bytea)
RETURNS TABLE (token_id uuid, session_id uuid, user_id uuid, family_id uuid, expires_at timestamptz, used_at timestamptz,
               session_revoked boolean, session_tenant_id uuid, session_amr text[], session_created_at timestamptz,
               session_last_used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.id, r.session_id, r.user_id, r.family_id, r.expires_at, r.used_at, s.revoked_at IS NOT NULL, s.tenant_id, s.amr,
         s.created_at, s.last_used_at
  FROM refresh_tokens r JOIN auth_sessions s ON s.id = r.session_id
  WHERE r.token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION app.find_refresh_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_refresh_token(bytea) TO flexa_app;
