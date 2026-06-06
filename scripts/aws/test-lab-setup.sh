#!/usr/bin/env bash
# test-lab-setup.sh
# Creates INTENTIONALLY INSECURE AWS resources so you can validate Parapet
# against real findings. >>> SANDBOX / TEST ACCOUNTS ONLY — never run in an
# account with real data. <<< Everything is tagged Project=parapet-test and
# recorded to a state file for clean teardown.
#
# Run in AWS CloudShell:  bash test-lab-setup.sh

set -uo pipefail

PREFIX="parapet-test"
STATE_FILE="${HOME}/${PREFIX}-state.env"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "==> Account: $ACCOUNT_ID   Region: $REGION"
echo
echo "This creates intentionally insecure resources:"
echo "  1. Security group open to 0.0.0.0/0 on ports 22 + 3389"
echo "  2. Public, unversioned S3 bucket (kept EMPTY)"
echo "  3. EBS default encryption DISABLED (account/region)"
echo "  4. IAM user with an unused access key and no MFA"
echo
read -r -p "Sandbox account only. Continue? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 1; }

{ echo "REGION=$REGION"; echo "ACCOUNT_ID=$ACCOUNT_ID"; } > "$STATE_FILE"

echo "==> [1/4] Open security group"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
[[ "$VPC_ID" == "None" || -z "$VPC_ID" ]] && VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 create-security-group --region "$REGION" \
  --group-name "${PREFIX}-open-sg" \
  --description "Parapet test - intentionally world-open (DELETE ME)" \
  --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PREFIX}}]" \
  --query GroupId --output text 2>/dev/null) || SG_ID=""
if [[ -n "$SG_ID" ]]; then
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 22   --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 3389 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
  echo "SG_ID=$SG_ID" >> "$STATE_FILE"
  echo "    created $SG_ID (22 + 3389 open to the world)"
else
  echo "    SG may already exist; skipping."
fi

echo "==> [2/4] Public, unversioned S3 bucket (kept empty)"
BUCKET="${PREFIX}-${ACCOUNT_ID}-$(date +%s)"
if [[ "$REGION" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null 2>&1
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false >/dev/null 2>&1 || true
cat > "/tmp/${PREFIX}-policy.json" <<EOF
{ "Version": "2012-10-17", "Statement": [{ "Sid": "ParapetTestPublicRead", "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::${BUCKET}/*" }] }
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file:///tmp/${PREFIX}-policy.json" >/dev/null 2>&1 \
  && echo "    public-read policy attached (bucket is empty — nothing real exposed)" \
  || echo "    public policy blocked by SCP — disabled-public-access-block finding still applies"
echo "BUCKET=$BUCKET" >> "$STATE_FILE"
echo "    created $BUCKET (Block Public Access OFF, no versioning)"

echo "==> [3/4] Disable EBS default encryption"
ORIG_EBS=$(aws ec2 get-ebs-encryption-by-default --region "$REGION" --query EbsEncryptionByDefault --output text 2>/dev/null || echo "Unknown")
echo "ORIG_EBS_ENC=$ORIG_EBS" >> "$STATE_FILE"
aws ec2 disable-ebs-encryption-by-default --region "$REGION" >/dev/null 2>&1 || true
echo "    EBS default encryption disabled (was: $ORIG_EBS)"

echo "==> [4/4] IAM user with unused access key, no MFA"
IAM_USER="${PREFIX}-user"
aws iam create-user --user-name "$IAM_USER" --tags Key=Project,Value=${PREFIX} >/dev/null 2>&1 \
  && echo "    created user $IAM_USER" || echo "    user $IAM_USER may already exist"
aws iam create-access-key --user-name "$IAM_USER" --query 'AccessKey.AccessKeyId' --output text >/dev/null 2>&1 \
  && echo "    access key created (no permissions, no MFA)" || echo "    access key not created (limit/restricted)"
echo "IAM_USER=$IAM_USER" >> "$STATE_FILE"

echo
echo "==> Done. State recorded to: $STATE_FILE  (tagged Project=${PREFIX})"
echo "    Run a scan from Parapet, then remove everything with:  bash test-lab-teardown.sh"
