#!/usr/bin/env bash
#
# run-scan.sh - Run Prowler against an AWS account (READ-ONLY) and emit a
# predictable JSON-OCSF report path.
#
# Usage:
#   run-scan.sh <scan-id> <bind-source-dir> [local-output-dir]
#
#   bind-source-dir  : path handed to "docker run -v" as the mount SOURCE. It is
#                      interpreted by the Docker DAEMON host. When this script
#                      runs inside the web container (talking to the host daemon
#                      over the mounted socket), this must be the HOST path that
#                      backs the scan dir - NOT the container /app/scans path.
#                      (Ignored in PROWLER_EXEC_MODE=local.)
#   local-output-dir : path THIS script can read to locate the produced file.
#                      Defaults to bind-source-dir for host-only runs.
#
# AWS credentials are read from the environment as the BASE (hub) identity:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
#
# Optional environment-driven scan parameters:
#   PROWLER_ROLE         - role ARN to assume (adds --role); Prowler does the STS
#   PROWLER_EXTERNAL_ID  - external id for the assume-role (adds --external-id)
#   PROWLER_REGIONS      - space-separated region list (adds --region); empty=all
#   PROWLER_EXEC_MODE    - "socket" (default): run Prowler in a throwaway
#                          container on the host Docker daemon. "local": run the
#                          installed "prowler" CLI directly (Kubernetes/AKS image
#                          bakes Prowler in - no Docker socket needed).
#
# Prowler runs read-only; it NEVER modifies cloud resources.
#
# On success the LAST stdout line is:
#   OCSF_OUTPUT=<local path to the .ocsf.json file>
#
# Exits non-zero with a clear message (to stderr) on any failure.

set -euo pipefail

# Image is overridable for pinning a digest/version later (see CLAUDE.md).
PROWLER_IMAGE="${PROWLER_IMAGE:-prowlercloud/prowler}"

die() {
  echo "run-scan.sh: ERROR: $*" >&2
  exit 1
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] ||
  die "usage: run-scan.sh <scan-id> <bind-source-dir> [local-output-dir]"

SCAN_ID="$1"
BIND_SOURCE="$2"
LOCAL_DIR="${3:-$2}"

# The scan id is used as a filename and a CLI arg - constrain it hard.
[ -n "$SCAN_ID" ] || die "scan id must not be empty"
case "$SCAN_ID" in
  *[!A-Za-z0-9_-]*) die "invalid scan id '$SCAN_ID' (allowed: A-Z a-z 0-9 _ -)" ;;
esac

# BIND_SOURCE may be a Windows host path (C:/... on Docker Desktop), so accept a
# drive-letter prefix in addition to POSIX "/".
case "$BIND_SOURCE" in
  /* | [A-Za-z]:/* | [A-Za-z]:\\*) : ;;
  *) die "bind-source-dir must be absolute, got '$BIND_SOURCE'" ;;
esac
case "$LOCAL_DIR" in /*) : ;; *) die "local-output-dir must be absolute, got '$LOCAL_DIR'" ;; esac

[ -d "$LOCAL_DIR" ] || die "local output dir does not exist: $LOCAL_DIR"

# Fail early with a clear message if creds are missing.
: "${AWS_ACCESS_KEY_ID:?run-scan.sh: ERROR: AWS_ACCESS_KEY_ID is not set}"
: "${AWS_SECRET_ACCESS_KEY:?run-scan.sh: ERROR: AWS_SECRET_ACCESS_KEY is not set}"
: "${AWS_DEFAULT_REGION:?run-scan.sh: ERROR: AWS_DEFAULT_REGION is not set}"

PROWLER_EXEC_MODE="${PROWLER_EXEC_MODE:-socket}"

OCSF_FILE="${LOCAL_DIR}/${SCAN_ID}.ocsf.json"

echo "run-scan.sh: starting read-only Prowler scan '${SCAN_ID}' (mode: ${PROWLER_EXEC_MODE})" >&2
echo "run-scan.sh:   reading result locally at: ${OCSF_FILE}" >&2

# Output dir differs by mode. In 'local' mode Prowler writes straight to the
# container-visible LOCAL_DIR. In 'socket' mode it writes to /output inside the
# throwaway Prowler container, which is the bind-mounted host directory.
if [ "$PROWLER_EXEC_MODE" = "local" ]; then
  OUTPUT_DIR="$LOCAL_DIR"
else
  OUTPUT_DIR="/output"
fi

# Base Prowler args:
#   -M json-ocsf : OCSF output format only
#   -o <dir>     : output directory (mode-dependent, see above)
#   -F <scan-id> : output filename WITHOUT extension => <scan-id>.ocsf.json
#   -z           : do not exit 3 merely because failing findings exist
#   -b           : hide the banner
PROWLER_ARGS=(aws -M json-ocsf -o "${OUTPUT_DIR}" -F "${SCAN_ID}" -z -b)

# Assume-role: Prowler performs the STS assume-role itself (no AWS SDK here).
if [ -n "${PROWLER_ROLE:-}" ]; then
  PROWLER_ARGS+=(--role "${PROWLER_ROLE}")
  echo "run-scan.sh:   assuming role: ${PROWLER_ROLE}" >&2
  [ -n "${PROWLER_EXTERNAL_ID:-}" ] && PROWLER_ARGS+=(--external-id "${PROWLER_EXTERNAL_ID}")
fi

# Region filter: --region <r1> <r2 ...>. Empty => scan all enabled regions.
if [ -n "${PROWLER_REGIONS:-}" ]; then
  echo "run-scan.sh:   regions: ${PROWLER_REGIONS}" >&2
  # shellcheck disable=SC2206
  PROWLER_ARGS+=(--region ${PROWLER_REGIONS})
fi

if [ "$PROWLER_EXEC_MODE" = "local" ]; then
  # In-process scanner: Prowler is installed in the image (Kubernetes/AKS), reads
  # creds from this environment, and writes directly to LOCAL_DIR. No Docker.
  command -v prowler >/dev/null 2>&1 || die "prowler not found on PATH (PROWLER_EXEC_MODE=local)"
  prowler "${PROWLER_ARGS[@]}" || die "prowler exited non-zero for scan '${SCAN_ID}'"
else
  # Default 'socket' mode: run Prowler in a throwaway container on the host daemon.
  echo "run-scan.sh:   mount source (daemon host): ${BIND_SOURCE}" >&2
  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  # --user root: the bind-mounted output dir is created by the web container
  # (root) and the prowler image otherwise runs as a non-root user that cannot
  # write to it. This throwaway --rm container is read-only toward AWS.
  docker run --rm \
    --user root \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -v "${BIND_SOURCE}:/output" \
    "${PROWLER_IMAGE}" "${PROWLER_ARGS[@]}" \
    || die "prowler container exited non-zero for scan '${SCAN_ID}'"
fi

[ -f "$OCSF_FILE" ] || die "expected OCSF output not found at ${OCSF_FILE}"

echo "run-scan.sh: scan '${SCAN_ID}' complete." >&2
echo "OCSF_OUTPUT=${OCSF_FILE}"
