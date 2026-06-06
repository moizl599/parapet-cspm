#!/usr/bin/env bash
# test-lab-multihop-teardown.sh
# Reverses test-lab-multihop-setup.sh: terminates the instance, deletes the SG,
# and removes the instance profile + over-privileged role.
#
# Run in AWS CloudShell:  bash test-lab-multihop-teardown.sh

set -uo pipefail

PREFIX="parapet-mh"
STATE_FILE="${HOME}/${PREFIX}-state.env"
[[ -f "$STATE_FILE" ]] || { echo "No state file at $STATE_FILE — nothing to tear down."; exit 1; }
# shellcheck disable=SC1090
source "$STATE_FILE"
REGION="${REGION:-us-east-1}"

echo "==> Tearing down ${PREFIX} in $REGION"

# 1. Terminate the instance and WAIT (so the ENI releases the SG)
if [[ -n "${INSTANCE_ID:-}" ]]; then
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 \
    && echo "    terminating $INSTANCE_ID ..." || echo "    instance $INSTANCE_ID not found"
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID" 2>/dev/null \
    && echo "    instance terminated" || echo "    (timed out waiting; SG delete may need a retry)"
fi

# 2. Security group (only deletable once the instance ENI is gone)
if [[ -n "${SG_ID:-}" ]]; then
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" >/dev/null 2>&1 \
    && echo "    deleted SG $SG_ID" \
    || echo "    SG $SG_ID NOT deleted yet — retry in a minute once the instance fully releases it"
fi

# 3. Instance profile + role
if [[ -n "${PROFILE_NAME:-}" && -n "${ROLE_NAME:-}" ]]; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
  aws iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1 \
    && echo "    deleted instance profile $PROFILE_NAME" || true
fi
if [[ -n "${ROLE_NAME:-}" ]]; then
  aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$ROLE_NAME" >/dev/null 2>&1 \
    && echo "    deleted role $ROLE_NAME" || echo "    role $ROLE_NAME NOT deleted — check manually"
fi

echo "==> Done. Remove the state file when satisfied:  rm $STATE_FILE"
