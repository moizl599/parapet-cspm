/**
 * Prowler integration (SERVER-SIDE ONLY).
 *
 * Spawns `prowler/run-scan.sh` (a bash wrapper around the Prowler Docker image)
 * and resolves with the path to the JSON-OCSF file it produced. Reads the
 * read-only AWS credentials from the validated config and injects them into the
 * child's environment — credentials are NEVER passed on the command line and
 * never reach the client.
 *
 * Imports `node:child_process`, so this module can only run in the Node.js
 * runtime (mark routes that use it with `export const runtime = "nodejs"`).
 *
 * NOTE: the wrapper is a `.sh` script, so a POSIX `bash` must be on PATH. On
 * Windows that means Git Bash or WSL; under Docker Compose / Linux it is native.
 */

import "server-only";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getAwsCredentials } from "@/lib/config";
import { scanDir } from "@/lib/scan-store";
import { sanitizeRegions } from "@/lib/aws-validate";

/** Per-environment scan parameters (Prowler performs any assume-role itself). */
export interface ProwlerScanOptions {
  roleArn?: string | null;
  externalId?: string | null;
  /** Region filter; empty/undefined = scan all enabled regions. */
  regions?: string[] | null;
}

const SCRIPT_PATH = path.join(process.cwd(), "prowler", "run-scan.sh");
const OCSF_OUTPUT_PREFIX = "OCSF_OUTPUT=";

/**
 * Resolve the Docker `-v` mount SOURCE for a scan.
 *
 * Prowler runs on the HOST Docker daemon (via the mounted socket), so the mount
 * source must be a path the HOST understands. Inside the web container the scan
 * dir is `/app/scans/<id>`, but on the host that same directory lives at
 * `${HOST_SCANS_DIR}/<id>` (HOST_SCANS_DIR is the host path bound to
 * /app/scans in docker-compose). When HOST_SCANS_DIR is unset we are running
 * directly on the host and the two paths coincide.
 */
function resolveHostBindSource(scanId: string, localDir: string): string {
  const hostScansDir = process.env.HOST_SCANS_DIR?.trim();
  if (!hostScansDir) return localDir;
  // Normalize Windows backslashes to forward slashes so the nested `docker run
  // -v` source is a form Docker Desktop accepts (e.g. C:/Users/.../scans/<id>),
  // then join with POSIX "/". (On Docker Desktop, set HOST_SCANS_DIR to the
  // absolute host path of ./scans.)
  const base = hostScansDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${scanId}`;
}

/**
 * Run a Prowler scan for `scanId`. The OCSF output is written into the scan's
 * directory (`scans/<scanId>/<scanId>.ocsf.json`).
 *
 * The base creds are the hub identity passed into the container. For a 'role'
 * environment, `options.roleArn`/`externalId` make Prowler assume that role via
 * STS (no AWS SDK in this app). `options.regions` filters the scan.
 *
 * @returns absolute (container-visible) path to the JSON-OCSF output file.
 * @throws if creds are missing, bash/docker is unavailable, or the scan fails.
 */
export async function runProwlerScan(
  scanId: string,
  options: ProwlerScanOptions = {},
): Promise<string> {
  const creds = getAwsCredentials(); // throws with a clear message if missing
  const localDir = scanDir(scanId); // container-visible path (e.g. /app/scans/<id>)
  // Ensure the OCSF output dir exists (the DB-backed createScan no longer makes
  // it). Via the ./scans bind mount this also creates it on the host.
  await fs.mkdir(localDir, { recursive: true });
  const hostBindSource = resolveHostBindSource(scanId, localDir);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_DEFAULT_REGION: creds.region,
  };
  if (options.roleArn) {
    childEnv.PROWLER_ROLE = options.roleArn;
    if (options.externalId) childEnv.PROWLER_EXTERNAL_ID = options.externalId;
  }
  const regions = sanitizeRegions(options.regions);
  if (regions.length > 0) childEnv.PROWLER_REGIONS = regions.join(" ");

  const conventionalPath = path.join(localDir, `${scanId}.ocsf.json`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn("bash", [SCRIPT_PATH, scanId, hostBindSource, localDir], {
      env: childEnv,
      // stdout is parsed for the OCSF_OUTPUT line; stderr is wrapper/Prowler logs.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.log(`[prowler ${scanId}] ${line}`);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.error(`[prowler ${scanId}] ${line}`);
      }
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to start Prowler scan. Is 'bash' available on PATH? (${err.message})`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Prowler scan '${scanId}' failed (exit code ${code}).`));
        return;
      }
      // Prefer the path the wrapper reports; fall back to the conventional one.
      const reported = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .reverse()
        .find((l) => l.startsWith(OCSF_OUTPUT_PREFIX));
      const ocsfPath = reported
        ? reported.slice(OCSF_OUTPUT_PREFIX.length)
        : conventionalPath;
      resolve(ocsfPath);
    });
  });
}
