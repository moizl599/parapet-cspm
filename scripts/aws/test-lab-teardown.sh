#!/usr/bin/env bash
# test-lab-teardown.sh
# Reverses everything created by test-lab-setup.sh, using the recorded state file.
#
# Run in AWS CloudShell:  bash test-lab-teardown.sh

set -uo pipefail

PREFIX="parapet-test"
STATE_FILE="${HOME}/${PREFIX}-state.env"

[[ -f "$STATE_FILE" ]] || { echo "No state file at $STATE_FILE — nothing to tear down."; exit 1; }
# shellcheck disable=SC1090
source "$STATE_FILE"
REGION="${REGION:-us-east-1}"

echo "==> Tearing down ${PREFIX} resources in $REGION"

if [[ -n "${BUCKET:-}" ]]; then
  aws s3 rm "s3://${BUCKET}" --recursive >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 \
    && echo "    deleted bucket $BUCKET" || echo "    bucket $BUCKET NOT deleted — check manually"
fi

if [[ -n "${SG_ID:-}" ]]; then
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" >/dev/null 2>&1 \
    && echo "    deleted security group $SG_ID" || echo "    SG $SG_ID NOT deleted — check manually"
fi

if [[ "${ORIG_EBS_ENC:-}" == "True" ]]; then
  aws ec2 enable-ebs-encryption-by-default --region "$REGION" >/dev/null 2>&1 \
    && echo "    re-enabled EBS default encryption (restored original)" || true
else
  echo "    EBS default encryption left disabled (its original state)"
fi

if [[ -n "${IAM_USER:-}" ]]; then
  for k in $(aws iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
    aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$k" >/dev/null 2>&1 || true
  done
  aws iam delete-user --user-name "$IAM_USER" >/dev/null 2>&1 \
    && echo "    deleted IAM user $IAM_USER" || echo "    IAM user $IAM_USER NOT deleted — check manually"
fi

echo "==> Done. Remove the state file when satisfied:  rm $STATE_FILE"
