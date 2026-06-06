import {
  deleteEnvironment,
  getEnvironment,
  updateEnvironment,
  type UpdateEnvironmentInput,
} from "@/lib/db/repository";
import { toEnvironmentDto, validateEnvironmentInput } from "@/lib/env-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/environments/[id] */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const env = getEnvironment(id);
  if (!env) return Response.json({ error: "Environment not found." }, { status: 404 });
  return Response.json({ environment: toEnvironmentDto(env) });
}

/** PATCH /api/environments/[id] — external ID is only updated if provided. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!getEnvironment(id)) {
    return Response.json({ error: "Environment not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = validateEnvironmentInput(body, { requireRoleFields: false });
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const patch: UpdateEnvironmentInput = {
    name: parsed.value.name,
    authMode: parsed.value.authMode,
    targetAccountId: parsed.value.targetAccountId,
    roleArn: parsed.value.roleArn,
    regions: parsed.value.regions,
  };
  // Only overwrite the secret if the user actually re-entered it.
  if (parsed.value.externalId !== undefined) {
    patch.externalId = parsed.value.externalId;
  } else if (parsed.value.authMode === "base") {
    patch.externalId = null; // base mode clears any stored secret
  }

  const env = updateEnvironment(id, patch);
  if (!env) return Response.json({ error: "Environment not found." }, { status: 404 });
  return Response.json({ environment: toEnvironmentDto(env) });
}

/** DELETE /api/environments/[id] — cascades scans/findings/analyses. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!getEnvironment(id)) {
    return Response.json({ error: "Environment not found." }, { status: 404 });
  }
  deleteEnvironment(id);
  return Response.json({ ok: true });
}
