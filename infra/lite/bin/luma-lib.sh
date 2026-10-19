# shellcheck shell=bash
# Shared helpers for the Lite cell host scripts. Sourced, not executed; expects root.
# /etc/luma/host.env, written by the instance user data, provides LUMA_STAGE, AWS_REGION and
# LUMA_DATA_VOLUME_ID.
set -euo pipefail

# shellcheck source=/dev/null
source /etc/luma/host.env
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

LUMA_HOME=/opt/luma
LUMA_STATE_DIR=/var/lib/luma
PARAMETER_PATH="/luma/$LUMA_STAGE"
export LUMA_STATE_DIR

log() { printf '%s luma: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

# Reads every parameter of this stage once; later lookups use the cached JSON.
load_parameters() {
  PARAMETERS=$(aws ssm get-parameters-by-path --path "$PARAMETER_PATH/" --recursive \
    --with-decryption --query 'Parameters[].{name:Name,value:Value}' --output json)
}

# Prints one parameter by its name below the stage path, or nothing when it is missing.
parameter() {
  jq -r --arg name "$PARAMETER_PATH/$1" \
    '.[] | select(.name == $name) | .value' <<<"$PARAMETERS"
}

# Prints NAME=value lines for every parameter in one section, such as `app` or `staff`.
# Values must be single lines because the environment files hold one setting per line.
section() {
  jq -r --arg prefix "$PARAMETER_PATH/$1/" '.[] | select(.name | startswith($prefix))
    | if (.value | contains("\n")) then error(.name + " must be a single line")
      else (.name | ltrimstr($prefix)) + "=" + .value end' <<<"$PARAMETERS"
}

# Creates a SecureString parameter below generated/ unless it exists, with the output of a
# generator function. Generated values never change afterwards, so every deploy and a replaced
# instance use the same secrets.
ensure_generated() {
  local name=$1 generator=$2
  if [[ -z $(parameter "generated/$name") ]]; then
    log "generating $name"
    aws ssm put-parameter --name "$PARAMETER_PATH/generated/$name" --type SecureString \
      --value "$("$generator")" --no-overwrite >/dev/null
  fi
}

random_secret() { openssl rand -hex 32; }

# Downloads the current host files and replaces /opt/luma with them.
refresh_host_files() {
  local url staging
  url=$(aws ssm get-parameter --name "$PARAMETER_PATH/host/BUNDLE_URL" \
    --query Parameter.Value --output text)
  staging=$(mktemp -d)
  aws s3 cp --only-show-errors "$url" "$staging/host-files.zip"
  python3 -m zipfile -e "$staging/host-files.zip" "$staging/files"
  rm -rf "$LUMA_HOME.previous"
  [[ -d $LUMA_HOME ]] && mv "$LUMA_HOME" "$LUMA_HOME.previous"
  mv "$staging/files" "$LUMA_HOME"
  chmod 0755 "$LUMA_HOME"/bin/*
  rm -rf "$staging"
}

# Runs Docker Compose for the cell with the rendered settings.
compose() {
  local profiles=()
  [[ -f $LUMA_STATE_DIR/env/staff-enabled ]] && profiles=(--profile staff)
  docker compose --project-directory "$LUMA_HOME" -f "$LUMA_HOME/compose.yaml" \
    --env-file "$LUMA_STATE_DIR/env/compose.env" "${profiles[@]}" "$@"
}

# Reads instance metadata through IMDSv2. Only the host can reach it; containers cannot.
imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  curl -fsS -H "X-aws-ec2-metadata-token: $token" \
    "http://169.254.169.254/latest/meta-data/$1"
}
