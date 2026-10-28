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

# Replaces /opt/luma with the host files in a directory, keeping the old copy beside it.
install_host_files() {
  local files=$1
  rm -rf "$LUMA_HOME.previous"
  if [[ -d $LUMA_HOME ]]; then mv "$LUMA_HOME" "$LUMA_HOME.previous"; fi
  mv "$files" "$LUMA_HOME"
  chmod 0755 "$LUMA_HOME"/bin/*
}

# Installs the host files of the CDK bundle. Only images built before host files moved into
# the server image need it; the first boot fetches the bundle in the instance user data.
refresh_host_files() {
  local url staging
  url=$(aws ssm get-parameter --name "$PARAMETER_PATH/host/BUNDLE_URL" \
    --query Parameter.Value --output text)
  staging=$(mktemp -d)
  aws s3 cp --only-show-errors "$url" "$staging/host-files.zip"
  python3 -m zipfile -e "$staging/host-files.zip" "$staging/files"
  install_host_files "$staging/files"
  rm -rf "$staging"
}

# Installs the host files from /opt/luma-host in a pulled server image, so the host runs the
# files of the commit it deploys. Returns 1 when the image has none.
extract_host_files() {
  local image=$1 container staging status=0
  staging=$(mktemp -d)
  container=$(docker create "$image")
  docker cp "$container:/opt/luma-host" "$staging/files" >/dev/null 2>&1 || status=1
  docker rm "$container" >/dev/null
  if ((status == 0)); then
    chown -R root:root "$staging/files"
    install_host_files "$staging/files"
  fi
  rm -rf "$staging"
  return "$status"
}

# Prints the deployed image tag and, when it was deployed by digest, the digest after a space.
# state/image holds only the tag, so scripts of older images keep reading it; state/image-digest
# names its tag, so a digest left by an older deploy is never paired with another tag.
deployed_image() {
  local tag digest_tag digest
  tag=$(cat "$LUMA_STATE_DIR/state/image" 2>/dev/null) || return 0
  if read -r digest_tag digest 2>/dev/null <"$LUMA_STATE_DIR/state/image-digest" &&
    [[ $digest_tag == "$tag" && -n $digest ]]; then
    printf '%s %s\n' "$tag" "$digest"
  else
    printf '%s\n' "$tag"
  fi
}

# Publishes an email alert to the stage's alert topic. A failed publish is logged and never
# fails the caller, which is usually already handling a failure. Messages must not carry
# tenant data or secrets.
notify_alert() {
  local subject="Luma $LUMA_STAGE: $1" message=$2 topic
  log "alert: $1"
  topic=$(aws ssm get-parameter --name "$PARAMETER_PATH/host/ALERT_TOPIC_ARN" \
    --query Parameter.Value --output text 2>/dev/null) || topic=
  [[ -n $topic ]] || {
    log 'alert not sent: host/ALERT_TOPIC_ARN is missing'
    return 0
  }
  aws sns publish --topic-arn "$topic" --subject "${subject:0:100}" \
    --message "$message"$'\n\n'"Host: $(hostname)" >/dev/null ||
    log 'alert not sent: publishing failed'
}

# Publishes one data point of a host metric with the stage as its only dimension, so alarms
# survive a replaced instance.
put_metric() {
  aws cloudwatch put-metric-data --namespace Luma/Lite --metric-name "$1" \
    --dimensions "Stage=$LUMA_STAGE" --value "${2:-1}" --unit Count
}

# Prints the S3 prefix of the newest backup that finished completely, or nothing.
latest_backup() {
  local bucket=$1
  aws s3api list-objects-v2 --bucket "$bucket" --prefix "lite/$LUMA_STAGE/" \
    --query "Contents[?ends_with(Key, '/COMPLETE')].Key" --output text |
    tr '\t' '\n' | { grep -v '^None$' || true; } | sort | tail -n 1 | sed 's|/COMPLETE$||'
}

# Installs the host's systemd units and the CloudWatch agent. Host setup and every deploy run
# it, so a running host picks up new units and agent settings with its next deploy.
install_host_services() {
  local agent=/opt/aws/amazon-cloudwatch-agent
  install -m 0644 "$LUMA_HOME"/systemd/*.service "$LUMA_HOME"/systemd/*.timer \
    /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now luma-backup.timer luma-restore-drill.timer luma-watchdog.timer

  rpm -q amazon-cloudwatch-agent >/dev/null 2>&1 || dnf install -y -q amazon-cloudwatch-agent
  install -d "$agent/etc"
  sed "s/__STAGE__/$LUMA_STAGE/g" "$LUMA_HOME/cloudwatch-agent.json" \
    >"$agent/etc/luma.json.new"
  if ! cmp -s "$agent/etc/luma.json.new" "$agent/etc/luma.json" ||
    ! systemctl is-active --quiet amazon-cloudwatch-agent; then
    mv "$agent/etc/luma.json.new" "$agent/etc/luma.json"
    "$agent/bin/amazon-cloudwatch-agent-ctl" -a fetch-config -m ec2 -s \
      -c "file:$agent/etc/luma.json" >/dev/null
  else
    rm -f "$agent/etc/luma.json.new"
  fi
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
