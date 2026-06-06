#!/usr/bin/env bash
# test-lab-multihop-setup.sh
# Plants a MULTI-HOP attack-path scenario in a SANDBOX account to exercise
# Parapet's relational rules: an EC2 instance using an over-privileged
# (AdministratorAccess) instance role, behind a security group open to
# 0.0.0.0/0 — i.e. internet -> exposed host -> instance role -> admin.
#
# >>> SANDBOX ACCOUNTS ONLY. This LAUNCHES A BILLABLE EC2 INSTANCE. <<<
# Tear it down promptly with test-lab-multihop-teardown.sh.
#
# Run in AWS CloudShell:  bash test-lab-multihop-setup.sh

set -uo pipefail

PREFIX="parapet-mh"
STATE_FILE="${HOME}/${PREFIX}-state.env"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ROLE_NAME="${PREFIX}-admin-role"
PROFILE_NAME="${PREFIX}-admin-profile"
SG_NAME="${PREFIX}-open-sg"
INSTANCE_TYPE="t3.micro"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "==> Account: $ACCOUNT_ID   Region: $REGION"
echo
echo "This creates (SANDBOX ONLY):"
echo "  - IAM role ${ROLE_NAME} with AdministratorAccess + an instance profile"
echo "  - Security group ${SG_NAME} open to 0.0.0.0/0 on port 22"
echo "  - A ${INSTANCE_TYPE} EC2 instance using that role, behind that SG"
echo
echo "  >>> The EC2 instance is BILLABLE while it runs. Tear it down when done. <<<"
echo
read -r -p "Sandbox account only. Continue? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 1; }

{ echo "REGION=$REGION"; echo "ACCOUNT_ID=$ACCOUNT_ID"; } > "$STATE_FILE"

echo "==> Resolving default VPC + subnet"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
[[ "$VPC_ID" == "None" || -z "$VPC_ID" ]] && VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0].SubnetId' --output text)
[[ -z "$SUBNET_ID" || "$SUBNET_ID" == "None" ]] && { echo "No subnet found in $VPC_ID"; exit 1; }
echo "    VPC=$VPC_ID  SUBNET=$SUBNET_ID"

echo "==> Creating over-privileged role + instance profile"
cat > "/tmp/${PREFIX}-trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document "file:///tmp/${PREFIX}-trust.json" \
  --tags Key=Project,Value=${PREFIX} >/dev/null 2>&1 && echo "    role created" || echo "    role may already exist"
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null 2>&1 || true
aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1 || true
aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
echo "ROLE_NAME=$ROLE_NAME" >> "$STATE_FILE"
echo "PROFILE_NAME=$PROFILE_NAME" >> "$STATE_FILE"
echo "    waiting ~12s for instance-profile propagation"
sleep 12

echo "==> Creating open security group"
SG_ID=$(aws ec2 create-security-group --region "$REGION" \
  --group-name "$SG_NAME" --description "Parapet MH - intentionally open (DELETE ME)" \
  --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PREFIX}}]" \
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
echo "SG_ID=$SG_ID" >> "$STATE_FILE"
echo "    $SG_ID open :22 to 0.0.0.0/0"

echo "==> Launching ${INSTANCE_TYPE} instance (latest Amazon Linux 2023)"
AMI_ID=$(aws ssm get-parameters --region "$REGION" \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameters[0].Value' --output text)
INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$PROFILE_NAME" \
  --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=${PREFIX}},{Key=Name,Value=${PREFIX}-instance}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "INSTANCE_ID=$INSTANCE_ID" >> "$STATE_FILE"

echo
echo "==> Done. instance=$INSTANCE_ID  role=$ROLE_NAME (admin)  sg=$SG_ID (open :22)"
echo "    State recorded: $STATE_FILE   (everything tagged Project=${PREFIX})"
echo "    Now run a scan in Parapet, then inspect graph_edges (see notes)."
echo "    >>> BILLABLE instance is RUNNING. Remove with: bash test-lab-multihop-teardown.sh <<<"
