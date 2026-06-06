import { testAssumeRole } from "@/lib/aws-test";

// Runs a throwaway aws-cli container (Docker) -> Node.js runtime, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/environments/test
 *
 * Body: { role_arn, external_id }. Verifies the base identity can assume the
 * role (no full scan, no AWS SDK — a throwaway aws-cli container does the STS
 * call). Returns { ok: true, account_id } or { ok: false, error }.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { role_arn?: unknown; external_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const roleArn = body?.role_arn;
  const externalId = body?.external_id;
  if (typeof roleArn !== "string" || typeof externalId !== "string") {
    return Response.json(
      { error: "role_arn and external_id are required." },
      { status: 400 },
    );
  }

  const result = await testAssumeRole(roleArn, externalId);
  if (result.ok) {
    return Response.json({ ok: true, account_id: result.accountId });
  }
  return Response.json({ ok: false, error: result.error });
}
