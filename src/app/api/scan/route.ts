import { startScan } from "@/lib/scan-runner";

// Spawns Docker + touches the filesystem -> must run on the Node.js runtime,
// and must never be statically cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scan
 *
 * Body: { environmentId?: string }. With no body (or no environmentId) the scan
 * runs against the default 'base' environment. Returns the scan id immediately;
 * poll GET /api/scan/[id] for status + results.
 */
export async function POST(request: Request): Promise<Response> {
  let environmentId: string | undefined;
  try {
    const body = (await request.json()) as { environmentId?: unknown };
    if (typeof body?.environmentId === "string") environmentId = body.environmentId;
  } catch {
    // No / invalid JSON body -> default environment.
  }

  try {
    const record = startScan(environmentId);
    return Response.json(
      { scanId: record.scanId, status: record.status },
      { status: 202 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to start scan.";
    const notFound = message.startsWith("Environment not found");
    console.error("POST /api/scan failed:", message);
    return Response.json({ error: message }, { status: notFound ? 404 : 500 });
  }
}
