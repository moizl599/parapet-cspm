import { createEnvironment, listEnvironments } from "@/lib/db/repository";
import { toEnvironmentDto, validateEnvironmentInput } from "@/lib/env-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/environments — list environments (external IDs are never returned). */
export async function GET(): Promise<Response> {
  return Response.json({ environments: listEnvironments().map(toEnvironmentDto) });
}

/** POST /api/environments — create an environment. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = validateEnvironmentInput(body, { requireRoleFields: true });
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const env = createEnvironment(parsed.value);
  return Response.json({ environment: toEnvironmentDto(env) }, { status: 201 });
}
