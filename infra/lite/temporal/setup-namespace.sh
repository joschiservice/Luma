#!/bin/sh
# Registers the cell's Temporal namespace once. History is retained for 14 days after a
# workflow closes.
set -eu

temporal_cli() {
  temporal "$@" --address temporal:7233 --tls --tls-ca-path /etc/temporal/tls/ca.pem \
    --tls-server-name temporal
}
if ! temporal_cli operator namespace describe --namespace "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
  temporal_cli operator namespace create --namespace "$TEMPORAL_NAMESPACE" --retention 14d
fi
