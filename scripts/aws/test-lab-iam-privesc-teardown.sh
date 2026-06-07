#!/usr/bin/env bash
# test-lab-iam-privesc-teardown.sh — reverses test-lab-iam-privesc-setup.sh.
# Run in AWS CloudShell:  bash test-lab-iam-privesc-teardown.sh

set -uo pipefail

PREFIX="parapet-iam"
STATE_FILE="${HOME}/${PREFIX}-state.env"
[[ -f "$STATE_FILE" ]] || { echo "No state file at $STATE_FILE — nothing to tear down."; exit 1; }
# shellcheck disable=SC1090
source "$STATE_FILE"

echo "==> Tearing down ${PREFIX}"

if [[ -n "${USER_NAME:-}" ]]; then
  aws iam delete-user-policy --user-name "$USER_NAME" --policy-name "${PREFIX}-assume-admin" >/dev/null 2>&1 || true
  aws iam delete-user --user-name "$USER_NAME" >/dev/null 2>&1 \
    && echo "    deleted user $USER_NAME" || echo "    user $USER_NAME NOT deleted — check manually"
fi

if [[ -n "${ROLE_NAME:-}" ]]; then
  aws iam detach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$ROLE_NAME" >/dev/null 2>&1 \
    && echo "    deleted role $ROLE_NAME" || echo "    role $ROLE_NAME NOT deleted — check manually"
fi

echo "==> Done. Remove the state file when satisfied:  rm $STATE_FILE"
