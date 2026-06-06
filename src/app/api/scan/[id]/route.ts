import { isValidScanId } from "@/lib/scan-store";
import {
  getAnalysisForScan,
  getFindingsForScan,
  getScan,
  type Scan,
} from "@/lib/db/repository";
import type { FindingsSummary } from "@/lib/severity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Map a DB scan row to the lifecycle the client polls. */
function toStatusRecord(scan: Scan) {
  return {
    scanId: scan.id,
    status: scan.status,
    createdAt: (scan.startedAt ?? new Date()).toISOString(),
    updatedAt: (scan.finishedAt ?? scan.startedAt ?? new Date()).toISOString(),
    ocsfPath: scan.ocsfPath ?? undefined,
    error: scan.error ?? undefined,
    // Analysis sub-lifecycle (decoupled background job).
    analysisStatus: scan.analysisStatus,
    analysisProgress: scan.analysisProgress ?? undefined,
    analysisError: scan.analysisError ?? undefined,
  };
}

/**
 * GET /api/scan/[id]
 *
 * Full lifecycle for polling: queued -> scanning -> done, plus the analysis
 * sub-state (pending -> running [N/M] -> done | error). Includes findings +
 * summary once the scan is done, and the persisted report once analysis is done.
 * Reads from SQLite (source of truth). Next.js 16: `params` is a Promise.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!isValidScanId(id)) {
    return Response.json({ error: "Invalid scan id." }, { status: 400 });
  }

  const scan = getScan(id);
  if (!scan) {
    return Response.json({ error: "Scan not found." }, { status: 404 });
  }

  const status = toStatusRecord(scan);
  if (scan.status !== "done") {
    return Response.json({ status });
  }

  return Response.json({
    status,
    findings: getFindingsForScan(id),
    summary: (scan.summary as FindingsSummary | null) ?? null,
    report: scan.analysisStatus === "done" ? getAnalysisForScan(id) : null,
  });
}
