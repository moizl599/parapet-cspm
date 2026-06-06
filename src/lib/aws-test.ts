/**
 * Assume-role connectivity test (SERVER-SIDE ONLY).
 *
 * Verifies the base (hub) identity can assume a given role WITHOUT a full scan,
 * by running a throwaway `amazon/aws-cli` container that performs
 * `sts assume-role`. No AWS SDK in this app — the container does the STS call.
 * Returns the assumed account id, or a clear, actionable error.
 */
import "server-only";
import { spawn } from "node:child_process";

import { getAwsCredentials, type AwsCredentials } from "@/lib/config";
import { isValidExternalId, isValidRoleArn } from "@/lib/aws-validate";

const AWS_CLI_IMAGE = process.env.AWS_CLI_IMAGE ?? "amazon/aws-cli";
const SESSION_NAME = "cspm-test";
const TIMEOUT_MS = 90_000; // includes a possible first-time image pull

export interface AssumeRoleResult {
  ok: boolean;
  accountId?: string;
  error?: string;
}

/** Map aws-cli stderr to a friendly, actionable message. */
function classifyError(stderr: string): string {
  const s = stderr;
  if (/ValidationError|Invalid length|Member must|valid.*RoleArn/i.test(s)) {
    return "Invalid role ARN format. Expected arn:aws:iam::<account-id>:role/<name>.";
  }
  if (/ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|security token.*invalid/i.test(s)) {
    return "The base (hub) AWS credentials are invalid or expired. Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.";
  }
  if (/could not be found|cannot be found|does not exist|NoSuchEntity/i.test(s)) {
    return "Role not found — double-check the role ARN.";
  }
  if (/AccessDenied|not authorized to perform: sts:AssumeRole/i.test(s)) {
    return (
      "Access denied assuming the role. Verify the role's trust policy allows your base identity AND the external ID matches. " +
      "(A freshly created role can take a few seconds to become assumable — retry shortly.)"
    );
  }
  const lastLine =
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "assume-role failed";
  return `Assume-role failed: ${lastLine.slice(0, 240)}`;
}

export async function testAssumeRole(
  roleArn: string,
  externalId: string,
): Promise<AssumeRoleResult> {
  if (!isValidRoleArn(roleArn)) {
    return {
      ok: false,
      error: "Invalid role ARN format. Expected arn:aws:iam::<account-id>:role/<name>.",
    };
  }
  if (!isValidExternalId(externalId)) {
    return { ok: false, error: "Invalid external id format." };
  }

  let creds: AwsCredentials;
  try {
    creds = getAwsCredentials();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Base credentials not configured.",
    };
  }

  const args = [
    "run",
    "--rm",
    "-e",
    "AWS_ACCESS_KEY_ID",
    "-e",
    "AWS_SECRET_ACCESS_KEY",
    "-e",
    "AWS_DEFAULT_REGION",
    AWS_CLI_IMAGE,
    "sts",
    "assume-role",
    "--role-arn",
    roleArn,
    "--external-id",
    externalId,
    "--role-session-name",
    SESSION_NAME,
    "--duration-seconds",
    "900",
    "--query",
    "AssumedRoleUser.Arn",
    "--output",
    "text",
  ];

  return new Promise<AssumeRoleResult>((resolve) => {
    const child = spawn("docker", args, {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_DEFAULT_REGION: creds.region,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `Could not run the aws-cli container (is Docker available?): ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // stdout is the assumed-role ARN: arn:aws:sts::<account>:assumed-role/...
        const arn = stdout.trim();
        const accountId = arn.split(":")[4];
        if (accountId && /^\d{12}$/.test(accountId)) {
          resolve({ ok: true, accountId });
        } else {
          resolve({
            ok: false,
            error: `Assume-role succeeded but the account id could not be parsed from "${arn}".`,
          });
        }
        return;
      }
      resolve({ ok: false, error: classifyError(stderr) });
    });
  });
}
