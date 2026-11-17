-- Auth-table owner / administrator phase, after normal migrations.
-- Local only via scripts/prepare-local.mjs. No shared/hosted application here.
-- No Auth columns, credentials, or rows are changed. Keep this after each reset.
BEGIN;
GRANT USAGE ON SCHEMA auth TO mjstats_auth_validator;
GRANT UPDATE (id) ON auth.users, auth.sessions TO mjstats_auth_validator;
-- The role has no login, membership, schema CREATE, or BYPASSRLS. It can only
-- inspect the seven granted metadata columns through the fixed function.
DROP POLICY IF EXISTS mjstats_validator_read ON auth.users;
DROP POLICY IF EXISTS mjstats_validator_lock ON auth.users;
DROP POLICY IF EXISTS mjstats_validator_read ON auth.sessions;
DROP POLICY IF EXISTS mjstats_validator_lock ON auth.sessions;
CREATE POLICY mjstats_validator_read ON auth.users FOR SELECT TO mjstats_auth_validator USING (true);
CREATE POLICY mjstats_validator_lock ON auth.users FOR UPDATE TO mjstats_auth_validator USING (true) WITH CHECK (false);
CREATE POLICY mjstats_validator_read ON auth.sessions FOR SELECT TO mjstats_auth_validator USING (true);
CREATE POLICY mjstats_validator_lock ON auth.sessions FOR UPDATE TO mjstats_auth_validator USING (true) WITH CHECK (false);
COMMIT;
