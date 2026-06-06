/**
 * Scan filesystem helpers (SERVER-SIDE ONLY).
 *
 * Status/results now live in SQLite (see src/lib/db). What remains here is the
 * on-disk location of the raw Prowler OCSF output (referenced by scans.ocsf_path)
 * and scan-id validation, since the id is used as a path segment and a Docker
 * filename argument.
 */
import "server-only";
import path from "node:path";

const SCANS_ROOT = path.join(process.cwd(), "scans");

/** Scan ids are path segments / Docker args — constrain them tightly. */
const SCAN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidScanId(scanId: string): boolean {
  return SCAN_ID_PATTERN.test(scanId);
}

function assertValidScanId(scanId: string): void {
  if (!isValidScanId(scanId)) {
    throw new Error(`Invalid scan id: ${JSON.stringify(scanId)}`);
  }
}

/** Directory holding the scan's OCSF output: scans/<scanId>/. */
export function scanDir(scanId: string): string {
  assertValidScanId(scanId);
  return path.join(SCANS_ROOT, scanId);
}
