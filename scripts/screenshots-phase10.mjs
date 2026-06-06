/**
 * Phase 10 review screenshots, taken against the LIVE container (BASE_URL,
 * default http://localhost:3000). The container serves the real Phase 10 UI;
 * the scan-history and diff API responses are mocked here because the real DB
 * has only ONE completed scan (a diff/trend needs two+). Everything else —
 * layout, header, env switcher, tabs — is the container's real output.
 *
 *   node scripts/screenshots-phase10.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const HISTORY = [
  { id: "scan-0004", status: "done", analysisStatus: "done", startedAt: "2026-06-06T13:05:00.000Z", finishedAt: "2026-06-06T14:00:00.000Z", postureScore: 75, failedCount: 38 },
  { id: "scan-0003", status: "done", analysisStatus: "done", startedAt: "2026-06-05T13:05:00.000Z", finishedAt: "2026-06-05T14:00:00.000Z", postureScore: 64, failedCount: 45 },
  { id: "scan-0002", status: "error", analysisStatus: "error", startedAt: "2026-06-04T13:05:00.000Z", finishedAt: "2026-06-04T13:07:00.000Z", postureScore: null, failedCount: null },
  { id: "scan-0001", status: "done", analysisStatus: "done", startedAt: "2026-06-03T13:05:00.000Z", finishedAt: "2026-06-03T14:00:00.000Z", postureScore: 58, failedCount: 52 },
];

const f = (checkId, checkTitle, severity, resourceId, region) => ({
  id: `${checkId}:${resourceId}:${region}`,
  checkId,
  checkTitle,
  service: checkId.split("_")[0],
  severity,
  status: "fail",
  region,
  resourceId,
  resourceType: "resource",
  description: "",
  riskDetail: "",
  remediationText: "",
  remediationUrl: null,
  complianceFrameworks: [],
});

const introduced = [
  f("s3_bucket_public", "S3 bucket is publicly readable", "critical", "arn:aws:s3:::acme-public-assets", "eu-west-1"),
  f("rds_public", "RDS instance is publicly accessible", "high", "db-prod-2", "us-east-1"),
  f("ec2_sg_open_ssh", "Security group allows 0.0.0.0/0 on port 22", "high", "sg-0af3c21b", "us-east-1"),
];
const resolved = [
  f("iam_root_access_keys", "Root account has active access keys", "critical", "<root_account>", "global"),
  f("cloudtrail_enabled", "CloudTrail not enabled in region", "high", "trail/ap-south-1", "ap-south-1"),
  f("iam_user_mfa", "IAM user without MFA enabled", "medium", "user/alice", "global"),
  f("ebs_encryption", "EBS volume not encrypted at rest", "medium", "vol-09a12bc", "us-east-1"),
  f("s3_access_logging", "S3 bucket missing access logging", "low", "arn:aws:s3:::acme-logs", "us-east-1"),
];
const unchanged = [
  f("iam_password_policy", "Account password policy is too weak", "high", "<account>", "global"),
  f("kms_key_rotation", "KMS key rotation disabled", "medium", "key/9f2c", "us-east-1"),
  f("vpc_flow_logs", "VPC flow logs are disabled", "medium", "vpc-01d9", "us-east-1"),
  f("iam_unused_role", "Unused IAM role (90+ days)", "low", "role/legacy-deploy", "global"),
];

const DIFF = {
  diff: {
    beforeScanId: "scan-0003",
    afterScanId: "scan-0004",
    introduced,
    resolved,
    unchanged,
    postureDelta: { before: 64, after: 75, delta: 11 },
    summaryDelta: {
      before: { totalFailed: 45, bySeverity: {}, byService: {} },
      after: { totalFailed: 38, bySeverity: {}, byService: {} },
      totalFailedDelta: -7,
      bySeverityDelta: {},
    },
  },
  before: { scanId: "scan-0003", startedAt: "2026-06-05T13:05:00.000Z", postureScore: 64 },
  after: { scanId: "scan-0004", startedAt: "2026-06-06T13:05:00.000Z", postureScore: 75 },
};

async function mock(page) {
  // History endpoint for any environment id.
  await page.route("**/api/environments/*/scans", (route) =>
    route.fulfill({ json: { scans: HISTORY } }),
  );
  // Diff endpoint for any scan id (default or ?against=...).
  await page.route("**/api/scans/*/diff*", (route) =>
    route.fulfill({ json: DIFF }),
  );
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await mock(page);

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// Overview "what changed since last scan" callout.
try {
  await page.getByText("Since your last scan").waitFor({ timeout: 4000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/p10-overview-callout.png` });
  console.log("✓ p10-overview-callout.png");
} catch {
  console.log("· overview callout not shown (no completed report for selected env)");
}

// History view (posture trend + table).
await page.getByRole("button", { name: "History" }).click();
await page.getByText("Posture trend").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/p10-history.png` });
console.log("✓ p10-history.png");

// Diff view (posture delta + New / Resolved / Still open).
await page.getByRole("button", { name: "Changes" }).click();
await page.getByText("New issues").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/p10-diff.png` });
console.log("✓ p10-diff.png");

await browser.close();
console.log("done");
