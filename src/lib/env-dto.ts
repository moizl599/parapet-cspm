/**
 * Environment API serialization + input validation (pure; shared by routes).
 *
 * SECURITY: the external ID is a secret and is NEVER serialized back to the
 * client — DTOs expose only `hasExternalId`. The client only ever has the value
 * it just typed; on edit it must re-enter it to change it.
 */
import {
  isValidExternalId,
  isValidRegion,
  isValidRoleArn,
} from "@/lib/aws-validate";
import type { CreateEnvironmentInput, Environment } from "@/lib/db/repository";

export interface EnvironmentDto {
  id: string;
  name: string;
  targetAccountId: string | null;
  authMode: "role" | "base";
  roleArn: string | null;
  regions: string[];
  /** Whether an external ID is stored — the value itself is never returned. */
  hasExternalId: boolean;
  createdAt: string;
  lastScanId: string | null;
  lastScanAt: string | null;
  lastPostureScore: number | null;
}

export function toEnvironmentDto(env: Environment): EnvironmentDto {
  return {
    id: env.id,
    name: env.name,
    targetAccountId: env.targetAccountId ?? null,
    authMode: env.authMode,
    roleArn: env.roleArn ?? null,
    regions: env.regions ?? [],
    hasExternalId: Boolean(env.externalId),
    createdAt: (env.createdAt instanceof Date
      ? env.createdAt
      : new Date()
    ).toISOString(),
    lastScanId: env.lastScanId ?? null,
    lastScanAt: env.lastScanAt ? env.lastScanAt.toISOString() : null,
    lastPostureScore: env.lastPostureScore ?? null,
  };
}

export type ValidatedEnvInput =
  | { ok: true; value: CreateEnvironmentInput }
  | { ok: false; error: string };

/**
 * Validate + normalize an environment create/update body.
 * @param requireRoleFields - true for create (role mode needs ARN + external id);
 *   false for edit (external id optional — omit to keep the existing one).
 */
export function validateEnvironmentInput(
  body: unknown,
  { requireRoleFields }: { requireRoleFields: boolean },
): ValidatedEnvInput {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be an object." };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required." };

  const authMode = b.authMode === "role" ? "role" : "base";
  const targetAccountId =
    typeof b.targetAccountId === "string" && b.targetAccountId.trim()
      ? b.targetAccountId.trim()
      : null;

  let regions: string[] = [];
  if (Array.isArray(b.regions)) {
    const raw = b.regions
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter(Boolean);
    const bad = raw.filter((r) => !isValidRegion(r));
    if (bad.length) {
      return { ok: false, error: `Invalid region(s): ${bad.join(", ")}` };
    }
    regions = raw;
  }

  let roleArn: string | null = null;
  let externalId: string | undefined;

  if (authMode === "role") {
    roleArn = typeof b.roleArn === "string" ? b.roleArn.trim() : "";
    if (!roleArn || !isValidRoleArn(roleArn)) {
      return {
        ok: false,
        error:
          "A valid role ARN is required for assume-role mode (arn:aws:iam::<account-id>:role/<name>).",
      };
    }
    const ext = typeof b.externalId === "string" ? b.externalId.trim() : "";
    if (ext) {
      if (!isValidExternalId(ext)) {
        return { ok: false, error: "Invalid external ID format." };
      }
      externalId = ext;
    } else if (requireRoleFields) {
      return {
        ok: false,
        error: "An external ID is required for assume-role mode.",
      };
    }
  }

  return {
    ok: true,
    value: { name, authMode, targetAccountId, roleArn, externalId, regions },
  };
}
