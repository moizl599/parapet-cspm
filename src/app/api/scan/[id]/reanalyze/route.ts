import { rerunAnalysis } from "@/lib/analysis-jobs";
import { isValidScanId } from "@/lib/scan-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scan/[id]/reanalyze
 *
 * Re-run the LLM analysis for an existing completed scan WITHOUT rescanning AWS
 * (reuses the persisted findings). Starts a fresh background job and returns
 * immediately; poll GET /api/scan/[id] for analysis_status/progress, or attach
 * to POST /api/analyze/[id] for a live view.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!isValidScanId(id)) {
    return Response.json({ error: "Invalid scan id." }, { status: 400 });
  }

  const result = rerunAnalysis(id);
  if (!result.ok) {
    const status = result.reason === "Scan not found." ? 404 : 409;
    return Response.json({ error: result.reason }, { status });
  }
  return Response.json(
    { scanId: id, analysisStatus: "running" },
    { status: 202 },
  );
}
