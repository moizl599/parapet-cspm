#!/usr/bin/env bash
# create-scan-role.sh
# Creates a READ-ONLY IAM role for assume-role scanning, trusted by the
# parapet-scanner identity and locked with a generated external ID.
# Attaches SecurityAudit + ViewOnlyAccess to the role, and grants the scanner
# user permission to assume it. Use this for the assume-role / multi-account path.
#
# Run in AWS CloudShell:  bash create-scan-role.sh

set -uo pipefail

ROLE_NAME="${ROLE_NAME:-parapet-scan-role}"
SCAN_USER="${SCAN_USER:-parapet-scanner}"
STATE_FILE="${HOME}/parapet-role-state.env"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
SCAN_USER_ARN="arn:aws:iam::${ACCOUNT_ID}:user/${SCAN_USER}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
EXTERNAL_ID="parapet-$(openssl rand -hex 12)"

echo "==> Account: $ACCOUNT_ID"

if ! aws iam get-user --user-name "$SCAN_USER" >/dev/null 2>&1; then
  echo "    WARNING: user '$SCAN_USER' not found. Run create-scan-user.sh first,"
  echo "    or set SCAN_USER to your scanner identity."
fi

# Trust policy: only the scanner user, only with the external ID.
cat > /tmp/parapet-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "${SCAN_USER_ARN}" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "${EXTERNAL_ID}" } }
  }]
}
EOF

echo "==> Creating role $ROLE_NAME"
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/parapet-trust.json \
  --description "Parapet read-only scan role" >/dev/null 2>&1 \
  && echo "    role created" \
  || { echo "    role may already exist; updating trust policy";
       aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
         --policy-document file:///tmp/parapet-trust.json >/dev/null 2>&1 || true; }

echo "==> Attaching read-only policies to the role"
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/SecurityAudit >/dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess >/dev/null 2>&1 || true
echo "    SecurityAudit + ViewOnlyAccess attached"

# A few extra read-only permissions the managed policies miss (e.g. EBS default
# encryption). Strictly Get/List — still read-only.
cat > /tmp/parapet-additions.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:GetEbsEncryptionByDefault","ec2:GetEbsDefaultKmsKeyId","account:GetContactInformation","account:ListRegions"],
    "Resource": "*"
  }]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name parapet-additions --policy-document file:///tmp/parapet-additions.json >/dev/null 2>&1 \
  && echo "    added read-only additions policy (full-coverage checks)" || true

# Let the scanner user assume this role.
cat > /tmp/parapet-assume.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "${ROLE_ARN}" }]
}
EOF
aws iam put-user-policy --user-name "$SCAN_USER" \
  --policy-name parapet-assume-scan-role --policy-document file:///tmp/parapet-assume.json >/dev/null 2>&1 \
  && echo "==> Granted $SCAN_USER permission to assume the role" \
  || echo "==> Could not attach assume policy to $SCAN_USER (check the user exists)"

{
  echo "ROLE_NAME=$ROLE_NAME"
  echo "ROLE_ARN=$ROLE_ARN"
  echo "SCAN_USER=$SCAN_USER"
  echo "EXTERNAL_ID=$EXTERNAL_ID"
} > "$STATE_FILE"

echo
echo "============================================================"
echo " Register this environment in the Parapet UI:"
echo "============================================================"
echo "Role ARN     : $ROLE_ARN"
echo "External ID  : $EXTERNAL_ID"
echo "Account ID   : $ACCOUNT_ID"
echo "============================================================"
echo
echo "Note: a new role can take ~10-15 seconds before it can be assumed."
echo "To remove later:"
echo "  aws iam delete-user-policy --user-name $SCAN_USER --policy-name parapet-assume-scan-role"
echo "  aws iam delete-role-policy --role-name $ROLE_NAME --policy-name parapet-additions"
echo "  aws iam detach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/SecurityAudit"
echo "  aws iam detach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
echo "  aws iam delete-role --role-name $ROLE_NAME"
