#!/usr/bin/env bash
#
# run-pmapper.sh - Build an AWS IAM authorization graph with PMapper
# (nccgroup/PMapper) READ-ONLY and emit it as a single JSON file our parser
# (src/lib/graph/pmapper-parse.ts) understands.
#
# This is the AP-5 second scanner. It follows the same model as run-scan.sh:
# READ-ONLY, credentials taken from the ENVIRONMENT (never the command line),
# assume-role delegated to the tool — the app never imports an AWS SDK.
#
# Usage:
#   run-pmapper.sh <scan-id> <output-dir>
#
# AWS credentials (base / hub identity), from the environment:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
#
# Optional (same variable names as the Prowler wrapper):
#   PROWLER_ROLE         - role ARN to assume first (via aws-cli STS) before
#                          building the graph, for cross-account scanning
#   PROWLER_EXTERNAL_ID  - external id for that assume-role
#
# Requirements in the runtime image (opt-in; only needed when PMAPPER_ENABLED):
#   - pmapper (principalmapper) CLI, python3, and aws-cli.
#
# PMapper performs only read-only IAM/STS list/get/describe calls. It does NOT
# model EC2 instance-profile attachment (see docs/ATTACK_PATHS_DESIGN.md
# "Scope boundary").
#
# On success the LAST stdout line is:
#   PMAPPER_OUTPUT=<path to the graph .json file>

set -euo pipefail

die() { echo "run-pmapper.sh: ERROR: $*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: run-pmapper.sh <scan-id> <output-dir>"
SCAN_ID="$1"
OUTPUT_DIR="$2"

case "$SCAN_ID" in
  *[!A-Za-z0-9_-]*) die "invalid scan id '$SCAN_ID'" ;;
esac
[ -d "$OUTPUT_DIR" ] || die "output dir does not exist: $OUTPUT_DIR"

: "${AWS_ACCESS_KEY_ID:?run-pmapper.sh: ERROR: AWS_ACCESS_KEY_ID is not set}"
: "${AWS_SECRET_ACCESS_KEY:?run-pmapper.sh: ERROR: AWS_SECRET_ACCESS_KEY is not set}"
: "${AWS_DEFAULT_REGION:?run-pmapper.sh: ERROR: AWS_DEFAULT_REGION is not set}"

command -v pmapper >/dev/null 2>&1 || die "pmapper not found on PATH"
command -v aws >/dev/null 2>&1 || die "aws CLI not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH"

OUT_FILE="${OUTPUT_DIR}/${SCAN_ID}.pmapper.json"
echo "run-pmapper.sh: building IAM graph (read-only) for scan '${SCAN_ID}'" >&2

# Assume the target role first (delegated to aws-cli, not an SDK) so PMapper runs
# against the target account with short-lived STS credentials.
if [ -n "${PROWLER_ROLE:-}" ]; then
  echo "run-pmapper.sh:   assuming role: ${PROWLER_ROLE}" >&2
  EXTID_ARGS=()
  [ -n "${PROWLER_EXTERNAL_ID:-}" ] && EXTID_ARGS=(--external-id "${PROWLER_EXTERNAL_ID}")
  CREDS_JSON="$(aws sts assume-role \
    --role-arn "${PROWLER_ROLE}" \
    --role-session-name "parapet-pmapper-${SCAN_ID}" \
    "${EXTID_ARGS[@]}" \
    --output json)" || die "assume-role failed for ${PROWLER_ROLE}"
  AWS_ACCESS_KEY_ID="$(echo "$CREDS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Credentials"]["AccessKeyId"])')"
  AWS_SECRET_ACCESS_KEY="$(echo "$CREDS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Credentials"]["SecretAccessKey"])')"
  AWS_SESSION_TOKEN="$(echo "$CREDS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Credentials"]["SessionToken"])')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || die "could not resolve account id"

# Restrict regional edge-gathering to the environment's region(s) (the `global`
# region — where IAM / sts:AssumeRole edges live — is ALWAYS included). Without
# this, PMapper iterates every region and raises a HARD EndpointConnectionError
# on disabled opt-in regions (e.g. autoscaling.me-south-1), failing the build.
# IAM identity edges are global, so this loses no can_assume/can_access edges.
REGIONS="${PROWLER_REGIONS:-$AWS_DEFAULT_REGION}"
echo "run-pmapper.sh:   regions (+ global): ${REGIONS}" >&2

# Build the graph (read-only). PMapper stores it under its data directory.
# shellcheck disable=SC2086
pmapper graph create --include-regions ${REGIONS} || die "pmapper graph create failed"

# Serialize PMapper's on-disk graph into our normalized {nodes,edges} JSON using
# PMapper's own Python API (no AWS calls here, just disk read).
python3 - "$ACCOUNT_ID" "$OUT_FILE" <<'PY' || die "failed to serialize PMapper graph"
import json, sys
from principalmapper.graphing import graph_actions
from principalmapper.util import storage

account_id, out_file = sys.argv[1], sys.argv[2]
graph = graph_actions.get_graph_from_disk(
    storage.get_storage_root() + "/" + account_id
)

def node_dict(n):
    return {
        "arn": n.arn,
        "id_value": getattr(n, "id_value", None),
        "is_admin": bool(getattr(n, "is_admin", False)),
        "trust_policy": getattr(n, "trust_policy", None),
    }

def edge_dict(e):
    return {
        "source": e.source.arn,
        "destination": e.destination.arn,
        "reason": getattr(e, "reason", ""),
        "short_reason": getattr(e, "short_reason", ""),
    }

out = {"nodes": [node_dict(n) for n in graph.nodes],
       "edges": [edge_dict(e) for e in graph.edges]}
with open(out_file, "w") as f:
    json.dump(out, f)
PY

[ -f "$OUT_FILE" ] || die "expected graph output not found at ${OUT_FILE}"
echo "run-pmapper.sh: graph written for scan '${SCAN_ID}'." >&2
echo "PMAPPER_OUTPUT=${OUT_FILE}"
