import { toAttackPathDtos } from "@/lib/attack-path-dto";
import { getAttackPaths, getGraph, getScan } from "@/lib/db/repository";
import { isValidScanId } from "@/lib/scan-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/scan/[id]/paths
 *
 * The scan's computed attack paths (AP-2) enriched with graph-node detail and
 * the LLM narrative where present (AP-3; null for lower-priority paths). Ranked
 * by severity then confidence. Next.js 16: `params` is a Promise.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!isValidScanId(id)) {
    return Response.json({ error: "Invalid scan id." }, { status: 400 });
  }
  if (!getScan(id)) {
    return Response.json({ error: "Scan not found." }, { status: 404 });
  }

  const paths = toAttackPathDtos(getAttackPaths(id), getGraph(id).nodes);
  const critical = paths.filter((p) => p.severity === "critical").length;

  return Response.json({ paths, total: paths.length, critical });
}
