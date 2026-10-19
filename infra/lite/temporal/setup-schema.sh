#!/bin/sh
# Creates or upgrades the Temporal persistence and visibility schemas. luma-deploy has already
# created the luma_temporal login and its databases; reruns apply only newer versions.
set -eu

for database in temporal temporal_visibility; do
  schema=temporal
  [ "$database" = temporal_visibility ] && schema=visibility
  sql() {
    temporal-sql-tool --plugin postgres12 --ep postgres -p 5432 \
      -u luma_temporal --pw "$POSTGRES_PWD" --db "$database" "$@"
  }
  if ! sql update-schema -d "/etc/temporal/schema/postgresql/v12/$schema/versioned"; then
    sql setup-schema -v 0.0
    sql update-schema -d "/etc/temporal/schema/postgresql/v12/$schema/versioned"
  fi
done
