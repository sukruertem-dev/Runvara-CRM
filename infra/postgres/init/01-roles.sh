#!/bin/sh
# Runs once on an empty data directory (postgres docker entrypoint). Creates the Runvara roles from the
# same SQL file the tests use (packages/db/sql/roles.sql, mounted at /runvara/roles.sql).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$RUNVARA_OWNER_PASSWORD" \
  -v app_password="$RUNVARA_APP_PASSWORD" \
  -v relay_password="$RUNVARA_RELAY_PASSWORD" \
  -v db_name="$POSTGRES_DB" \
  -f /runvara/roles.sql
