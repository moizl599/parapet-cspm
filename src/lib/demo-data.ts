/**
 * Sample data for design-review mode (`?demo=1`). This is illustrative content
 * so the populated UI can be reviewed without live AWS credentials or a model
 * run — it is clearly labelled as a sample in the UI and never hits the API.
 */
import { summarizeFindings } from "@/lib/ocsf";
import type { Analysis, Finding, FindingsSummary } from "@/lib/severity";

const FINDINGS: Finding[] = [
  {
    id: "ec2-sg-22",
    checkTitle: "Security group allows ingress from 0.0.0.0/0 to port 22",
    service: "ec2",
    severity: "high",
    status: "fail",
    region: "us-east-1",
    resourceId: "sg-0ab12cd34ef56",
    resourceType: "AwsEc2SecurityGroup",
    description: "SSH (port 22) is open to the entire internet.",
    riskDetail: "Internet-exposed admin ports invite brute-force and exploitation.",
    remediationText: "Restrict ingress to known CIDRs.",
    remediationUrl:
      "https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html",
    complianceFrameworks: ["CIS-2.0", "AWS-FSBP"],
  },
  {
    id: "s3-public",
    checkTitle: "S3 bucket does not block public access",
    service: "s3",
    severity: "critical",
    status: "fail",
    region: "us-east-1",
    resourceId: "arn:aws:s3:::acme-customer-exports",
    resourceType: "AwsS3Bucket",
    description: "Bucket-level Block Public Access is disabled.",
    riskDetail: "Public buckets are a leading cause of data breaches.",
    remediationText: "Enable Block Public Access at the account and bucket level.",
    remediationUrl:
      "https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html",
    complianceFrameworks: ["CIS-2.0", "PCI-4.0"],
  },
  {
    id: "iam-root-mfa",
    checkTitle: "Root account does not have MFA enabled",
    service: "iam",
    severity: "critical",
    status: "fail",
    region: "global",
    resourceId: "arn:aws:iam::000000000000:root",
    resourceType: "AwsIamUser",
    description: "The root user has no multi-factor authentication.",
    riskDetail: "Root has unrestricted access; a stolen password is catastrophic.",
    remediationText: "Enable a hardware or virtual MFA device on the root user.",
    remediationUrl:
      "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html",
    complianceFrameworks: ["CIS-2.0"],
  },
  {
    id: "rds-public",
    checkTitle: "RDS instance is publicly accessible",
    service: "rds",
    severity: "high",
    status: "fail",
    region: "eu-west-1",
    resourceId: "arn:aws:rds:eu-west-1:000000000000:db:analytics-prod",
    resourceType: "AwsRdsDbInstance",
    description: "The database instance has a public endpoint.",
    riskDetail: "Publicly reachable databases dramatically widen the attack surface.",
    remediationText: "Disable public accessibility and place the instance in private subnets.",
    remediationUrl:
      "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.html",
    complianceFrameworks: ["AWS-FSBP"],
  },
  {
    id: "cloudtrail-off",
    checkTitle: "CloudTrail is not enabled in all regions",
    service: "cloudtrail",
    severity: "medium",
    status: "fail",
    region: "global",
    resourceId: "arn:aws:cloudtrail:us-east-1:000000000000:trail/management",
    resourceType: "AwsCloudTrailTrail",
    description: "A multi-region trail is not configured.",
    riskDetail: "Without full audit logging, incidents cannot be reconstructed.",
    remediationText: "Create a multi-region CloudTrail trail with log file validation.",
    remediationUrl:
      "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-a-trail-using-the-cli.html",
    complianceFrameworks: ["CIS-2.0", "SOC2"],
  },
  {
    id: "ebs-unencrypted",
    checkTitle: "EBS volume is not encrypted at rest",
    service: "ec2",
    severity: "medium",
    status: "fail",
    region: "us-east-1",
    resourceId: "vol-0f1e2d3c4b5a6",
    resourceType: "AwsEc2Volume",
    description: "The attached EBS volume has no encryption.",
    riskDetail: "Unencrypted volumes expose data if snapshots or disks leak.",
    remediationText: "Enable EBS default encryption and re-create the volume from an encrypted snapshot.",
    remediationUrl:
      "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EBSEncryption.html",
    complianceFrameworks: ["AWS-FSBP"],
  },
  {
    id: "iam-key-rotation",
    checkTitle: "IAM access key has not been rotated in 90 days",
    service: "iam",
    severity: "low",
    status: "fail",
    region: "global",
    resourceId: "AKIAEXAMPLE000DEMO",
    resourceType: "AwsIamAccessKey",
    description: "An active access key is older than 90 days.",
    riskDetail: "Long-lived keys increase the window for credential compromise.",
    remediationText: "Rotate the key and update consumers.",
    remediationUrl:
      "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
    complianceFrameworks: ["CIS-2.0"],
  },
  {
    id: "s3-encrypted-pass",
    checkTitle: "S3 bucket has default encryption enabled",
    service: "s3",
    severity: "medium",
    status: "pass",
    region: "us-east-1",
    resourceId: "arn:aws:s3:::acme-logs",
    resourceType: "AwsS3Bucket",
    description: "Default SSE is enabled on the bucket.",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: ["CIS-2.0"],
  },
  {
    id: "iam-pw-policy-pass",
    checkTitle: "IAM password policy requires minimum length of 14",
    service: "iam",
    severity: "low",
    status: "pass",
    region: "global",
    resourceId: "arn:aws:iam::000000000000:account",
    resourceType: "AwsIamAccountPasswordPolicy",
    description: "Password policy meets the length requirement.",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: ["CIS-2.0"],
  },
];

const ANALYSIS: Analysis = {
  executive_summary:
    "Two critical, internet-facing exposures dominate this account's risk: a publicly accessible S3 bucket holding customer exports and a root account without MFA. Both are directly exploitable and should be remediated today. A cluster of network-exposure and encryption gaps follows. Most issues are low-effort, high-impact fixes; prioritize the public data path first.",
  posture_score: 47,
  quick_wins: [
    "Enable MFA on the root account (minutes, eliminates a catastrophic single point of failure).",
    "Turn on S3 Account-level Block Public Access to cover the exposed bucket.",
    "Enable EBS default encryption so new volumes are protected automatically.",
  ],
  items: [
    {
      title: "Lock down the public customer-data S3 bucket",
      severity: "critical",
      priority_rank: 1,
      affected_resources: ["arn:aws:s3:::acme-customer-exports"],
      why_it_matters:
        "This bucket is named like it holds customer exports and currently allows public access. Public S3 buckets are the single most common source of large AWS data breaches — anyone on the internet who guesses or discovers the name may be able to list and download objects.",
      attack_scenario:
        "An attacker enumerates bucket names, finds it readable, and exfiltrates the entire customer export set without ever touching your account credentials.",
      remediation_steps: [
        "In the S3 console, open the bucket → Permissions → Block public access and enable all four settings.",
        "Apply it account-wide as a backstop: `aws s3control put-public-access-block --account-id 000000000000 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`",
        "Review the bucket policy and ACLs for any explicit public grants and remove them.",
      ],
      effort: "quick-win",
      risk_of_fix:
        "If any legitimate consumer relies on public/anonymous access (e.g. a static site), it will break. Confirm access patterns and move them to CloudFront/OAC or signed URLs first.",
      references: [
        "https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html",
        "CIS-2.0 2.1.5",
      ],
    },
    {
      title: "Enable MFA on the root account",
      severity: "critical",
      priority_rank: 2,
      affected_resources: ["arn:aws:iam::000000000000:root"],
      why_it_matters:
        "The root user can do anything in the account, including closing it or removing other admins. Without MFA, a single leaked or phished password gives an attacker total control with no second factor to stop them.",
      attack_scenario:
        "A reused root password surfaces in a credential dump; the attacker logs in unchallenged and creates persistent backdoor admin users.",
      remediation_steps: [
        "Sign in as root → Security credentials → Multi-factor authentication (MFA) → Assign MFA device.",
        "Prefer a hardware key (FIDO2) or a virtual authenticator app; store backup codes securely.",
        "After enabling, stop using root for day-to-day work entirely.",
      ],
      effort: "quick-win",
      risk_of_fix:
        "Minimal. Ensure the MFA device is registered to a shared, recoverable owner — losing the only root MFA device can lock you out.",
      references: [
        "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html",
        "CIS-2.0 1.5",
      ],
    },
    {
      title: "Remove internet exposure from network resources",
      severity: "high",
      priority_rank: 3,
      affected_resources: [
        "sg-0ab12cd34ef56",
        "arn:aws:rds:eu-west-1:000000000000:db:analytics-prod",
      ],
      why_it_matters:
        "An SSH port is open to 0.0.0.0/0 and a production RDS instance has a public endpoint. Each is a direct, internet-reachable entry point an attacker can probe continuously.",
      attack_scenario:
        "Automated scanners find the open SSH port and the public database endpoint within hours and begin credential brute-forcing against both.",
      remediation_steps: [
        "Restrict the security group to known CIDRs: `aws ec2 revoke-security-group-ingress --group-id sg-0ab12cd34ef56 --protocol tcp --port 22 --cidr 0.0.0.0/0`",
        "Prefer SSM Session Manager over open SSH where possible.",
        "Disable public access on the database: `aws rds modify-db-instance --db-instance-identifier analytics-prod --no-publicly-accessible --apply-immediately`",
      ],
      effort: "moderate",
      risk_of_fix:
        "Revoking SSH or the public DB endpoint can disconnect existing operators or clients that depend on them — stage a private access path (bastion/SSM/VPN) before applying.",
      references: [
        "https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html",
        "AWS-FSBP EC2.13",
      ],
    },
    {
      title: "Close encryption-at-rest gaps",
      severity: "medium",
      priority_rank: 4,
      affected_resources: ["vol-0f1e2d3c4b5a6"],
      why_it_matters:
        "An EBS volume is unencrypted. While not directly internet-exposed, unencrypted storage means leaked snapshots or disposed disks expose data in cleartext, and it fails common compliance baselines.",
      attack_scenario:
        "A shared or public snapshot of the unencrypted volume leaks its full contents with no key required.",
      remediation_steps: [
        "Turn on account default encryption: `aws ec2 enable-ebs-encryption-by-default --region us-east-1`",
        "Snapshot the volume, copy the snapshot with encryption enabled, and recreate the volume from the encrypted copy.",
      ],
      effort: "moderate",
      risk_of_fix:
        "Re-creating the volume requires a brief detach/attach maintenance window for the instance.",
      references: [
        "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EBSEncryption.html",
      ],
    },
    {
      title: "Establish full audit logging and key hygiene",
      severity: "medium",
      priority_rank: 5,
      affected_resources: [
        "arn:aws:cloudtrail:us-east-1:000000000000:trail/management",
        "AKIAEXAMPLE000DEMO",
      ],
      why_it_matters:
        "CloudTrail is not multi-region, so activity in some regions is unlogged, and an IAM access key is over 90 days old. Together these weaken your ability to detect and investigate misuse.",
      attack_scenario:
        "An attacker operates in an unlogged region using a stale long-lived key, leaving little forensic trail.",
      remediation_steps: [
        "Create a multi-region trail with log validation: `aws cloudtrail create-trail --name org-management --s3-bucket-name acme-cloudtrail-logs --is-multi-region-trail --enable-log-file-validation`",
        "Start logging: `aws cloudtrail start-logging --name org-management`",
        "Rotate the aged access key and update consumers, then deactivate the old key.",
      ],
      effort: "involved",
      risk_of_fix:
        "Rotating a key in active use will break any service still referencing the old credential — roll out the new key to all consumers before deactivating the old one.",
      references: [
        "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-a-trail-using-the-cli.html",
        "SOC2 CC7.2",
      ],
    },
  ],
};

export interface DemoData {
  findings: Finding[];
  summary: FindingsSummary;
  analysis: Analysis;
}

export function getDemoData(): DemoData {
  return {
    findings: FINDINGS,
    summary: summarizeFindings(FINDINGS),
    analysis: ANALYSIS,
  };
}

/** All-clear variant: every check passes, posture 100, no action items. */
const ALL_CLEAR_FINDINGS: Finding[] = FINDINGS.filter(
  (f) => f.status === "pass",
).concat([
  {
    id: "ec2-sg-clear",
    checkTitle: "No security group allows ingress from 0.0.0.0/0 to admin ports",
    service: "ec2",
    severity: "high",
    status: "pass",
    region: "us-east-1",
    resourceId: "sg-0ab12cd34ef56",
    resourceType: "AwsEc2SecurityGroup",
    description: "No admin ports are exposed to the internet.",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: ["CIS-2.0"],
  },
  {
    id: "iam-root-mfa-clear",
    checkTitle: "Root account has MFA enabled",
    service: "iam",
    severity: "critical",
    status: "pass",
    region: "global",
    resourceId: "arn:aws:iam::000000000000:root",
    resourceType: "AwsIamUser",
    description: "The root user has MFA configured.",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: ["CIS-2.0"],
  },
]);

export function getAllClearDemo(): DemoData {
  return {
    findings: ALL_CLEAR_FINDINGS,
    summary: summarizeFindings(ALL_CLEAR_FINDINGS),
    analysis: {
      executive_summary:
        "No failed findings were detected in this scan. All monitored controls passed. Keep credentials read-only and re-scan regularly to catch drift.",
      posture_score: 100,
      items: [],
      quick_wins: [],
    },
  };
}
