/**
 * PMapper integration (SERVER-SIDE ONLY) — AP-5, optional second scanner.
 *
 * Spawns `prowler/run-pmapper.sh` (a bash wrapper around the read-only PMapper
 * CLI, nccgroup/PMapper) exactly like the Prowler runner: read-only AWS creds
 * are injected via the child ENVIRONMENT (never the command line, never the
 * client), assume-role is delegated to the tool, and the wrapper prints the path
 * to the IAM graph JSON it produced. We parse that into our node/edge model.
 *
 * The app stays AWS-SDK-free: all AWS calls happen inside PMapper / aws-cli in
 * the wrapper. Gated by `isPmapperEnabled()` at the call site (scan-runner) so
 * v1 is unchanged when PMAPPER_ENABLED is off.
 *
 * Imports `node:child_process` -> Node.js runtime only.
 */
import "server-only";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getAwsCredentials } from "@/lib/config";
import { scanDir } from "@/lib/scan-store";
import { sanitizeRegions } from "@/lib/aws-validate";
import {
  parsePmapperGraph,
  type ParsedGraph,
} from "@/lib/graph/pmapper-parse";
import type { ProwlerScanOptions } from "@/lib/prowler";

const SCRIPT_PATH = path.join(process.cwd(), "prowler", "run-pmapper.sh");
const OUTPUT_PREFIX = "PMAPPER_OUTPUT=";

/**
 * Run PMapper for `scanId` and return the parsed IAM graph (source: "pmapper").
 * Uses the same base/assume-role credentials as Prowler. Resolves to an empty
 * graph only if the tool produced no parseable output.
 *
 * @throws if creds are missing, bash is unavailable, or the wrapper exits non-zero.
 */
export async function runPmapper(
  scanId: string,
  options: ProwlerScanOptions = {},
): Promise<ParsedGraph> {
  const creds = getAwsCredentials();
  const localDir = scanDir(scanId);
  await fs.mkdir(localDir, { recursive: true });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_DEFAULT_REGION: creds.region,
  };
  if (options.roleArn) {
    childEnv.PROWLER_ROLE = options.roleArn; // reuse the same var names as Prowler
    if (options.externalId) childEnv.PROWLER_EXTERNAL_ID = options.externalId;
  }
  const regions = sanitizeRegions(options.regions);
  if (regions.length > 0) childEnv.PROWLER_REGIONS = regions.join(" ");

  const conventionalPath = path.join(localDir, `${scanId}.pmapper.json`);

  const outputPath = await new Promise<string>((resolve, reject) => {
    const child = spawn("bash", [SCRIPT_PATH, scanId, localDir], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.log(`[pmapper ${scanId}] ${line}`);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.error(`[pmapper ${scanId}] ${line}`);
      }
    });
    child.on("error", (err) =>
      reject(
        new Error(`Failed to start PMapper. Is 'bash' available? (${err.message})`),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PMapper run '${scanId}' failed (exit code ${code}).`));
        return;
      }
      const reported = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .reverse()
        .find((l) => l.startsWith(OUTPUT_PREFIX));
      resolve(reported ? reported.slice(OUTPUT_PREFIX.length) : conventionalPath);
    });
  });

  const raw = await fs.readFile(outputPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`PMapper output at ${outputPath} is not valid JSON.`);
  }
  return parsePmapperGraph(parsed);
}
