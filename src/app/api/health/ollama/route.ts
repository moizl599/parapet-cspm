import { healthCheck } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health/ollama
 *
 * Surfaces Ollama reachability + model availability so the UI (and operators)
 * can see the state instead of the app crashing. Mirrors `npm run check:ollama`,
 * but works inside the slim standalone container where the dev script is absent.
 * Returns 200 when ready, 503 otherwise (status field distinguishes
 * unreachable / model-not-found / error).
 */
export async function GET(): Promise<Response> {
  const health = await healthCheck();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
