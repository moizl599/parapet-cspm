#!/usr/bin/env bash
# create-scan-user.sh
# Creates a READ-ONLY IAM user for Parapet to scan with, attaches the AWS managed
# SecurityAudit + ViewOnlyAccess policies, and prints the .env lines.
# The secret access key is shown ONCE — copy it immediately.
#
# Run in AWS CloudShell (or any shell with admin AWS CLI access):
#   bash create-scan-user.sh

set -uo pipefail

SCAN_USER="${SCAN_USER:-parapet-scanner}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

echo "==> Creating read-only scan user '$SCAN_USER' (region for scans: $REGION)"

aws iam create-user --user-name "$SCAN_USER" >/dev/null 2>&1 \
  && echo "    user created" \
  || echo "    user may already exist; continuing"

aws iam attach-user-policy --user-name "$SCAN_USER" \
  --policy-arn arn:aws:iam::aws:policy/SecurityAudit >/dev/null 2>&1 || true
aws iam attach-user-policy --user-name "$SCAN_USER" \
  --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess >/dev/null 2>&1 || true
echo "    attached SecurityAudit + ViewOnlyAccess (read-only)"

echo "==> Creating access key..."
KEY_JSON=$(aws iam create-access-key --user-name "$SCAN_USER" --output json 2>/dev/null)
if [[ -z "$KEY_JSON" ]]; then
  echo "    Could not create an access key (a user can have at most 2)."
  echo "    List existing keys:  aws iam list-access-keys --user-name $SCAN_USER"
  exit 1
fi
AK=$(echo "$KEY_JSON" | grep -o '"AccessKeyId": *"[^"]*"' | cut -d'"' -f4)
SK=$(echo "$KEY_JSON" | grep -o '"SecretAccessKey": *"[^"]*"' | cut -d'"' -f4)

echo
echo "============================================================"
echo " Paste these into your .env  (secret shown ONCE):"
echo "============================================================"
echo "AWS_ACCESS_KEY_ID=$AK"
echo "AWS_SECRET_ACCESS_KEY=$SK"
echo "AWS_DEFAULT_REGION=$REGION"
echo "AWS_REGION=$REGION"
echo "============================================================"
echo
echo "Note: a new IAM key can take ~10-15 seconds to become active."
echo "To revoke later:"
echo "  aws iam delete-access-key --user-name $SCAN_USER --access-key-id $AK"
echo "  aws iam detach-user-policy --user-name $SCAN_USER --policy-arn arn:aws:iam::aws:policy/SecurityAudit"
echo "  aws iam detach-user-policy --user-name $SCAN_USER --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
echo "  aws iam delete-user --user-name $SCAN_USER"
