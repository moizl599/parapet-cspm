/**
 * OCSF (Open Cybersecurity Schema Framework) parsing + normalization.
 *
 * Prowler's `json-ocsf` output is an array of OCSF "Detection Finding" objects.
 * The raw types below mirror the subset Prowler actually emits (confirmed by
 * reading the image's `lib/outputs/ocsf/ocsf.py`). Every field is optional —
 * Prowler output is UNTRUSTED input (see CLAUDE.md), so we never assume shape.
 *
 * `normalizeFindings` converts the raw array into our clean internal `Finding`
 * type. It NEVER throws on a single malformed finding — bad entries are dropped
 * and counted, never allowed to abort the whole batch.
 *
 * This module is pure (no I/O), so it is safe to import anywhere and is unit
 * tested directly against a committed fixture.
 */

/* -------------------------------------------------------------------------- */
/* Raw OCSF shape (as emitted by Prowler — all fields optional/untrusted)     */
/* -------------------------------------------------------------------------- */

export interface OcsfFindingInfo {
  uid?: string;
  title?: string;
  desc?: string;
  name?: string;
  types?: string[];
}

export interface OcsfRemediation {
  desc?: string;
  references?: string[];
}

export interface OcsfGroup {
  name?: string;
}

export interface OcsfResource {
  name?: string;
  uid?: string;
  type?: string;
  region?: string;
  cloud_partition?: string;
  group?: OcsfGroup;
  labels?: string[];
  data?: unknown;
}

export interface OcsfCloudAccount {
  uid?: string;
  name?: string;
}

export interface OcsfCloud {
  region?: string;
  provider?: string;
  account?: OcsfCloudAccount;
}

export interface OcsfProduct {
  name?: string;
  vendor_name?: string;
  version?: string;
}

export interface OcsfMetadata {
  /** Prowler stores the check id here, e.g. "ec2_securitygroup_allow_ingress…". */
  event_code?: string;
  product?: OcsfProduct;
}

export interface OcsfUnmapped {
  related_url?: string;
  categories?: unknown;
  /** Map of framework name -> requirement ids. Prowler nests compliance here. */
  compliance?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single OCSF Detection Finding as produced by Prowler. */
export interface OcsfDetectionFinding {
  finding_info?: OcsfFindingInfo;
  severity?: string;
  severity_id?: number;
  /** OCSF lifecycle status name, e.g. "New" / "Suppressed". */
  status?: string;
  /** Prowler check outcome: "PASS" | "FAIL" | "MANUAL" | "MUTED". */
  status_code?: string;
  status_detail?: string;
  message?: string;
  risk_details?: string;
  remediation?: OcsfRemediation;
  resources?: OcsfResource[];
  metadata?: OcsfMetadata;
  cloud?: OcsfCloud;
  unmapped?: OcsfUnmapped;
  /** Some pipelines surface compliance at the top level; we accept both. */
  compliance?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Clean internal model                                                       */
/* -------------------------------------------------------------------------- */

export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = ["pass", "fail", "manual"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** A related resource Prowler attached to a finding (e.g. an instance's role or
 *  security groups). Used to derive REAL graph edges — never co-location. */
export interface RelatedResource {
  type: string;
  id: string;
}

export interface Finding {
  id: string;
  /** Prowler check id (OCSF metadata.event_code), e.g. "ec2_sg_open". */
  checkId?: string;
  checkTitle: string;
  service: string;
  severity: Severity;
  status: FindingStatus;
  region: string;
  resourceId: string;
  resourceType: string;
  description: string;
  riskDetail: string;
  remediationText: string;
  remediationUrl: string | null;
  complianceFrameworks: string[];
  /** AWS account id (OCSF cloud.account.uid) when present. */
  accountId?: string;
  /** Additional resources Prowler listed alongside the primary one (resources[1..]).
   *  The graph layer turns roles / security groups here into real edges. */
  relatedResources?: RelatedResource[];
}

export interface NormalizeResult {
  findings: Finding[];
  /** Count of raw entries that were malformed and skipped. */
  dropped: number;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

const SEVERITY_BY_NAME: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  informational: "informational",
};

// OCSF SeverityID values (per the schema Prowler uses).
const SEVERITY_BY_ID: Record<number, Severity> = {
  1: "informational",
  2: "low",
  3: "medium",
  4: "high",
  5: "critical",
};

const STATUS_BY_CODE: Record<string, FindingStatus> = {
  PASS: "pass",
  FAIL: "fail",
  MANUAL: "manual",
  // A muted finding still carries its underlying PASS/FAIL in status_code, but
  // guard for it appearing here directly.
  MUTED: "manual",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toSeverity(name: unknown, id: unknown): Severity {
  if (typeof name === "string") {
    const matched = SEVERITY_BY_NAME[name.toLowerCase()];
    if (matched) return matched;
  }
  if (typeof id === "number" && SEVERITY_BY_ID[id]) {
    return SEVERITY_BY_ID[id];
  }
  // Unknown/Other/Fatal -> safest non-alarming default; the finding is kept.
  return "informational";
}

function toStatus(code: unknown): FindingStatus {
  if (typeof code === "string") {
    const matched = STATUS_BY_CODE[code.toUpperCase()];
    if (matched) return matched;
  }
  // Unknown status -> treat as needing human attention rather than guessing.
  return "manual";
}

/** Derive a coarse service name from a check id like "ec2_sg_open" -> "ec2". */
function serviceFromCheckId(checkId: string | undefined): string | undefined {
  if (!checkId) return undefined;
  const head = checkId.split("_", 1)[0];
  return head.length > 0 ? head : undefined;
}

function firstHttpUrl(references: unknown): string | null {
  if (!Array.isArray(references)) return null;
  for (const ref of references) {
    if (typeof ref === "string" && /^https?:\/\//i.test(ref)) return ref;
  }
  return null;
}

function complianceKeys(finding: OcsfDetectionFinding): string[] {
  const source = finding.unmapped?.compliance ?? finding.compliance;
  if (!isRecord(source)) return [];
  return Object.keys(source);
}

/**
 * Normalize a single raw OCSF finding. Returns `null` (never throws) if the
 * entry is too malformed to be useful — currently that means: not an object,
 * or missing a stable unique id.
 */
export function normalizeFinding(raw: unknown): Finding | null {
  try {
    if (!isRecord(raw)) return null;
    const finding = raw as OcsfDetectionFinding;

    const info = isRecord(finding.finding_info) ? finding.finding_info : {};
    const resource: OcsfResource =
      Array.isArray(finding.resources) && isRecord(finding.resources[0])
        ? (finding.resources[0] as OcsfResource)
        : {};
    const remediation = isRecord(finding.remediation) ? finding.remediation : {};

    const id = asString(info.uid);
    if (!id) return null; // no stable identity -> drop

    const checkId = asString(finding.metadata?.event_code);

    // Additional resources beyond the primary (resources[1..]). Prowler
    // occasionally lists an instance's attached role / security groups here —
    // the only honest source of v1 graph edges.
    const relatedResources: RelatedResource[] = Array.isArray(finding.resources)
      ? finding.resources
          .slice(1)
          .filter(isRecord)
          .map((r) => ({
            type: asString((r as OcsfResource).type) ?? "",
            id:
              asString((r as OcsfResource).uid) ??
              asString((r as OcsfResource).name) ??
              "",
          }))
          .filter((r) => r.id.length > 0)
      : [];

    return {
      id,
      checkId,
      checkTitle: asString(info.title) ?? checkId ?? "Untitled check",
      service:
        asString(resource.group?.name) ??
        serviceFromCheckId(checkId) ??
        "unknown",
      severity: toSeverity(finding.severity, finding.severity_id),
      status: toStatus(finding.status_code),
      region:
        asString(finding.cloud?.region) ?? asString(resource.region) ?? "global",
      resourceId: asString(resource.uid) ?? asString(resource.name) ?? "unknown",
      resourceType: asString(resource.type) ?? "unknown",
      description:
        asString(info.desc) ??
        asString(finding.status_detail) ??
        asString(finding.message) ??
        "",
      riskDetail: asString(finding.risk_details) ?? "",
      remediationText: asString(remediation.desc) ?? "",
      remediationUrl: firstHttpUrl(remediation.references),
      complianceFrameworks: complianceKeys(finding),
      accountId: asString(finding.cloud?.account?.uid),
      relatedResources: relatedResources.length > 0 ? relatedResources : undefined,
    };
  } catch {
    // Defensive: any unexpected shape error drops just this finding.
    return null;
  }
}

/**
 * Normalize the full raw OCSF payload (the parsed array Prowler writes).
 * Accepts the array directly, or an object with a `findings`/`data` array, or
 * anything else (yields an empty result). Never throws.
 */
export function normalizeFindings(rawOcsf: unknown): NormalizeResult {
  let entries: unknown[];
  if (Array.isArray(rawOcsf)) {
    entries = rawOcsf;
  } else if (isRecord(rawOcsf) && Array.isArray(rawOcsf.findings)) {
    entries = rawOcsf.findings;
  } else if (isRecord(rawOcsf) && Array.isArray(rawOcsf.data)) {
    entries = rawOcsf.data;
  } else {
    return { findings: [], dropped: 0 };
  }

  const findings: Finding[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const normalized = normalizeFinding(entry);
    if (normalized) findings.push(normalized);
    else dropped += 1;
  }
  return { findings, dropped };
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

export interface FindingsSummary {
  /** Number of FAILED findings (the summary intentionally ignores pass/manual). */
  totalFailed: number;
  bySeverity: Record<Severity, number>;
  byService: Record<string, number>;
}

/**
 * Summarize FAILED findings only: counts by severity and by service. Passing
 * and manual findings are excluded — the dashboard's headline is about what is
 * actually wrong.
 */
export function summarizeFindings(findings: Finding[]): FindingsSummary {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  const byService: Record<string, number> = {};

  let totalFailed = 0;
  for (const finding of findings) {
    if (finding.status !== "fail") continue;
    totalFailed += 1;
    bySeverity[finding.severity] += 1;
    byService[finding.service] = (byService[finding.service] ?? 0) + 1;
  }

  return { totalFailed, bySeverity, byService };
}
