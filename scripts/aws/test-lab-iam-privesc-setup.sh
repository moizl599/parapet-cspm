#!/usr/bin/env bash
# test-lab-iam-privesc-setup.sh
# Plants an IAM-only privilege-escalation scenario for PMapper to detect:
#   - an admin role (AdministratorAccess), trusted by the account
#   - a low-privilege IAM user whose only permission is sts:AssumeRole on that role
# PMapper computes: low-priv user --can_assume--> admin role  => an identity
# escalation chain (Parapet's privilege-escalation-chain rule, confidence=high).
#
# IAM-only — NO billable compute. Still SANDBOX ONLY (it creates a real admin role).
#
# Run in AWS CloudShell:  bash test-lab-iam-privesc-setup.sh

set -uo pipefail

PREFIX="parapet-iam"
STATE_FILE="${HOME}/${PREFIX}-state.env"
ROLE_NAME="${PREFIX}-admin"
USER_NAME="${PREFIX}-lowpriv"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "==> Account: $ACCOUNT_ID"
echo "Creates (SANDBOX ONLY): admin role ${ROLE_NAME} + low-priv user ${USER_NAME}"
echo "that can assume it. IAM-only, no billable resources."
read -r -p "Continue? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 1; }

{ echo "ACCOUNT_ID=$ACCOUNT_ID"; echo "ROLE_NAME=$ROLE_NAME"; echo "USER_NAME=$USER_NAME"; } > "$STATE_FILE"

# Admin role, trusted by the account root (so same-account principals holding
# sts:AssumeRole can assume it — this is what makes the privesc edge real).
cat > "/tmp/${PREFIX}-trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::${ACCOUNT_ID}:root"},"Action":"sts:AssumeRole"}]}
EOF
echo "==> Creating admin role $ROLE_NAME"
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document "file:///tmp/${PREFIX}-trust.json" \
  --description "Parapet IAM privesc lab (DELETE ME)" \
  --tags Key=Project,Value=${PREFIX} >/dev/null 2>&1 && echo "    role created" || echo "    role may exist"
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null 2>&1 || true

echo "==> Creating low-priv user $USER_NAME (can only assume the admin role)"
aws iam create-user --user-name "$USER_NAME" --tags Key=Project,Value=${PREFIX} >/dev/null 2>&1 \
  && echo "    user created" || echo "    user may exist"
cat > "/tmp/${PREFIX}-assume.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"${ROLE_ARN}"}]}
EOF
aws iam put-user-policy --user-name "$USER_NAME" \
  --policy-name "${PREFIX}-assume-admin" \
  --policy-document "file:///tmp/${PREFIX}-assume.json" >/dev/null 2>&1 \
  && echo "    attached assume-admin inline policy" || echo "    could not attach policy"

echo
echo "==> Done. Privesc chain planted: ${USER_NAME} --can_assume--> ${ROLE_NAME} (admin)"
echo "    State: $STATE_FILE   (tagged Project=${PREFIX})"
echo "    Enable PMAPPER_ENABLED, scan, and look for the privilege-escalation-chain path."
echo "    Remove with: bash test-lab-iam-privesc-teardown.sh"
