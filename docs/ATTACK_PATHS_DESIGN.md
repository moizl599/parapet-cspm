# Attack-Path Simulation — Design & Build Plan

This is the design for Parapet's marquee v2 feature: turning a flat list of findings into **attack paths** — concrete chains showing how an attacker could move from an exposed entry point to a sensitive target, ranked by real-world risk and explained by the local LLM.

> **The non-negotiable rule:** attack paths are **computed from real data**. The LLM only *narrates* paths the engine found — it never invents a path. A fabricated-but-plausible attack chain is worse than none, because people act on it.

The feature ships in two stages:

- **v1 — toxic-combination & exposure engine (no new dependency).** A best-effort graph built from Prowler's findings: tag resources with capabilities, detect dangerous combinations, and render short chains (internet → exposed resource → sensitive capability). Honest scope: where Prowler's output carries a relationship (e.g. an instance's attached role), we get a real edge; otherwise we surface high-confidence single-resource toxic combos. This is *not* full graph-theoretic analysis yet — and we label it that way.
- **v2 — PMapper-backed IAM graph (true multi-hop chains).** Add [PMapper](https://github.com/nccgroup/PMapper) as a second read-only scanner (same model as Prowler), giving authoritative IAM can-assume / privilege-escalation edges. This is what turns v1's combos into genuine multi-hop attack paths.

Everything reuses patterns Parapet already has: the normalized `Finding` model, SQLite/Drizzle persistence, the background-job + structured-output (`json_schema`) + partial-report LLM pipeline, the diff engine, and the dashboard tab pattern.

---

## Concepts

- **Node** — a resource or identity (EC2 instance, S3 bucket, RDS instance, IAM role/user, security group, …). Carries **capability tags**.
- **Capability tag** — a security-relevant property derived from the FAILED findings touching that node: `exposed_internet`, `publicly_accessible`, `privileged`, `holds_data`, `unencrypted`, `weak_auth`, `credential_exposure`, `logging_blind`.
- **Edge** — a concrete relationship between nodes (`uses_role`, `in_security_group`, `can_assume`, `can_access`), created **only** from relationships actually present in the data. We never invent reachability from mere co-location.
- **Entry point** — a node tagged `exposed_internet` / `publicly_accessible` (where an attacker starts).
- **Target (crown jewel)** — a node tagged `holds_data` or `privileged` (what they're after).
- **Attack path** — a chain entry → … → target that matches a rule. v1 paths are 0–2 hops; v2 adds longer IAM chains.

---

## Data model (SQLite via Drizzle, per scan)

```
graph_nodes      id, scan_id (fk), node_key (stable: type+resource id), type,
                 name, region, account_id, capabilities (json string[]),
                 source ('prowler' | 'pmapper')

graph_edges      id, scan_id (fk), src_key, dst_key, relation
                 ('uses_role'|'in_security_group'|'can_assume'|'can_access'),
                 evidence (json: which finding/pmapper fact produced it),
                 source

attack_paths     id, scan_id (fk), rule_id, title, severity
                 ('critical'|'high'|'medium'|'low'), entry_key, target_key,
                 hops (json: ordered node_keys + edges), capabilities (json),
                 narrative (json, filled by the LLM), confidence
                 ('high'|'medium'|'low'), created_at
```

Keyed per `scan_id` like findings, so the existing **diff engine extends naturally** to "attack paths introduced / resolved since last scan" (diff key = `rule_id + entry_key + target_key`).

---

## Capability tagging (findings → tags)

A pure mapping from FAILED finding `check_id` / `service` / `resource_type` to capability tags on the resource's node. Starter table (extend over time; match by prefix/glob):

| Capability | Triggers (check_id / signal) |
|---|---|
| `exposed_internet` | `ec2_securitygroup_allow_ingress_from_internet*`, internet-facing ELB/ALB, `*_publicly_accessible` on network resources |
| `publicly_accessible` | `s3_bucket_public*`, `s3_account_level_public_access_blocks`, `rds_instance_no_public_access` (failing = public), public OpenSearch/Redshift/SNS/SQS |
| `privileged` | `iam_*administrator*`, `iam_policy_allows_privilege_escalation`, `*_full_administrative_privileges`, `iam_role_*` with `*:*`, root-account usage |
| `holds_data` | resource_type ∈ {S3 bucket, RDS, DynamoDB, Redshift, EFS, Secrets Manager, SQS} (potential data store — LLM notes uncertainty) |
| `unencrypted` | `*_encryption*` failing (`s3_*_encryption`, `ec2_ebs_*_encryption`, `rds_*_encrypted`) |
| `weak_auth` | `iam_user_*_mfa*`, `iam_root_*_mfa*`, weak password policy |
| `credential_exposure` | exposed access keys, hardcoded-secret findings, long-unrotated keys |
| `logging_blind` | `cloudtrail_*` disabled, `vpc_flow_logs*` disabled (context: weakens detection) |

`holds_data` is a *potential*-sensitivity heuristic by resource type — flagged as such so the LLM hedges appropriately rather than asserting data sensitivity it can't know.

---

## Edges (v1 — only real relationships)

Build edges **only** from relationships present in the data, never from co-location:

- From the OCSF finding detail where Prowler includes related resources (e.g. an EC2 finding that lists the instance's attached IAM role and security groups) → `uses_role`, `in_security_group` edges.
- No edge available → the node still participates in single-resource toxic-combo rules.

This keeps v1 honest: real edges where we have them, high-confidence single-node combos otherwise. (v2/PMapper supplies the authoritative `can_assume` / privesc edges.)

---

## The rule set (toxic combinations)

Each rule = a pattern over node capabilities (and edges where required), a severity, and a one-line rationale. v1 starter set:

| Rule | Pattern | Severity | Why |
|---|---|---|---|
| `public-data-exposure` | node has `publicly_accessible` + `holds_data` | critical | Anyone on the internet can read a data store. (`unencrypted` raises confidence/severity.) |
| `internet-compute-to-privileged-role` | node `exposed_internet` + edge `uses_role` → node `privileged` | critical | Compromise the exposed host → steal its over-privileged role credentials → escalate. |
| `wildcard-trust-admin-role` | `privileged` role whose trust allows broad principals | critical | Role assumable too widely + admin = direct takeover. |
| `public-database` | `publicly_accessible` + database resource_type | high | Internet-reachable DB (`unencrypted` → critical). |
| `privilege-escalation-identity` | `privileged` with a privesc finding | high | Identity can escalate to admin. |
| `exposed-credentials-to-privilege` | `credential_exposure` + (same identity `privileged`) | high | Leaked/long-lived creds on a powerful identity. |
| `public-compute-unencrypted` | `exposed_internet` + `unencrypted` volume | medium | Exposed host with unprotected data at rest. |
| `blind-spot-amplifier` | any critical path **and** account `logging_blind` | (boost) | No CloudTrail/flow logs = the attack goes unseen; raises urgency, not a path itself. |

The engine emits a path per rule match, with `confidence` reflecting whether the link was a real edge (high) or a same-resource/heuristic combo (medium).

---

## Path engine

Per completed scan, after findings persist:

1. **Build nodes** from FAILED findings' resources; attach capability tags via the mapping.
2. **Build edges** from finding relationship detail (v1) and PMapper (v2).
3. **Identify** entry nodes (exposed) and target nodes (sensitive/privileged).
4. **Match rules**: single-node combos directly; relational rules via bounded BFS (≤ N hops, N=4) from entry → target over edges.
5. **Dedupe & rank** by severity then confidence; cap to a sane number (e.g. top 50) to bound LLM cost.
6. **Persist** to `attack_paths` (narrative empty until the LLM step).

Pure, deterministic, unit-testable with fixtures (a node/edge set in → expected paths out). No network, no LLM.

---

## LLM narration contract (grounded)

Reuse the existing structured-output pipeline (`json_schema` first, chunked, partial-report-tolerant, background job). The model is given **one computed path at a time** and must describe only that path.

Input per path: the ordered nodes + edges, their capability tags, the matched rule, and the underlying findings' titles.

Output schema:

```json
{
  "summary": "string (one sentence)",
  "attack_scenario": "string — concrete step-by-step of how this chain is exploited",
  "blast_radius": "string — what an attacker reaches if successful",
  "severity_rationale": "string — why this severity vs Prowler's labels",
  "break_the_chain": [
    { "link": "which node/edge to cut", "action": "remediation (console + CLI)", "effort": "quick-win|moderate|involved" }
  ],
  "confidence_note": "string — call out heuristic links / unknown data sensitivity",
  "false_positive_risk": "low|medium|high"
}
```

System-prompt rules: describe ONLY the provided path; do not introduce resources/edges not in the input; explicitly flag where a link is heuristic (e.g. `holds_data` is type-based, sensitivity unconfirmed); prefer the cheapest single link to cut.

---

## UI — "Attack Paths" tab

Invoke `ui-ux-pro-max`; reuse the existing dark SOC tokens/components. A new tab beside Overview / Action queue / Findings / History / Changes:

- **Path list**, ranked by severity. Each card: a compact chain visualization (Internet → [exposed node] → … → [target node]) with capability badges on nodes, a severity badge, hop count, and a confidence chip.
- **Expand** → the LLM narrative: attack scenario, blast radius, the prioritized **"break this link"** remediation (copy-to-clipboard CLI), confidence + false-positive note.
- A small summary header: "N attack paths · X critical" and a callout on the Overview ("⚠ 2 paths reach sensitive data") linking here.
- States: none found ("No attack paths detected — nice"), loading, error. Accessibility consistent with Phases 5/9.

For the chain visual, a simple horizontal node-edge SVG (or Mermaid) is enough — entry on the left, target on the right, capability-coloured nodes.

---

## v2 — PMapper integration (true IAM chains) — SHIPPED (AP-5)

PMapper is read-only and runs as a CLI, so it slots in exactly like Prowler ("run a scanner, parse output"). It is **gated behind `PMAPPER_ENABLED` (default off)** — with it off, behavior is identical to v1.

How it's wired:

1. **Run** (`prowler/run-pmapper.sh`, invoked by `src/lib/pmapper.ts`): read-only, credentials injected via the environment (never the command line), assume-role delegated to `aws sts assume-role` in the wrapper (same base/assume-role creds as Prowler). PMapper builds the IAM authorization graph and computes privesc, then the wrapper serializes it to a single `{nodes, edges}` JSON via PMapper's own Python API. **The app stays AWS-SDK-free** — every AWS call happens inside PMapper / aws-cli.
2. **Parse** (`src/lib/graph/pmapper-parse.ts`, pure): PMapper nodes → `graph_nodes` (`source='pmapper'`), keyed `iam_role:<arn>` / `iam_user:<arn>` so they **merge** with Prowler nodes for the same ARN. `is_admin` → `privileged`; a broad/wildcard trust policy → `wildcard_trust`. PMapper edges → `graph_edges` with `relation='can_assume'` (reason mentions assume) or `'can_access'`.
3. **Merge** (`mergeGraphs`) the PMapper graph onto the Prowler graph **before** the path engine runs (capabilities unioned, edges deduped).
4. **Engine**: a directed rule, `privilege-escalation-chain`, walks `can_assume`/`can_access` edges (direction matters — "A can assume B" ≠ the reverse) from any IAM identity to a `privileged` target, producing **real identity multi-hop chains** at **`confidence=high`**. The previously-dormant **`wildcard-trust-admin-role`** rule now fires when PMapper supplies a `privileged` role with `wildcard_trust`.

### Setup

PMapper, `aws-cli`, and `python3` must be available in the runtime image (opt-in; only needed when enabled). Then:

```bash
PMAPPER_ENABLED=true          # in .env
# pmapper graph create runs read-only with the scan's credentials
```

The same read-only credential model applies; for a 'role' environment the wrapper assumes the role via STS first.

---

## Scope boundary — the remaining gap (EC2 instance-profile edges)

**PMapper does NOT model EC2-instance → IAM-role attachment.** Its graph is the IAM *authorization* graph (which principals can assume/access which), not which compute resources carry which role. So the lab chain **internet → EC2 instance → its instance-profile role → admin does NOT fully connect from PMapper alone** — the `internet-exposed instance → uses_role → role` hop is missing on both sides:

- **Prowler** flags the instance as internet-facing-with-a-profile (`ec2_instance_internet_facing_with_instance_profile`) but its normalized finding carries only the instance as a single resource — no related role/SG (the AP-1/AP-4 finding).
- **PMapper** knows the role's privileges and who can assume it, but not that *this instance* is bound to it.

Closing this requires an **EC2 instance-profile edge collector**: `ec2:DescribeInstances` + `iam:GetInstanceProfile` to emit `uses_role` / `in_security_group` edges from instances. That is a deliberate **future** item, **not implemented here**, because capturing it requires an **EC2 describe call** — which would mean either importing an AWS SDK (breaking the AWS-SDK-free property) or adding yet another delegated CLI collector. Flagged, not hacked around. Until then, PMapper enables *identity-to-identity* multi-hop chains; instance→role attachment remains the honest boundary.

---

## Honest limitations

- v1 (Prowler-only) is **toxic-combination detection**, not full attack-graph analysis. PMapper (AP-5) adds authoritative **identity** multi-hop chains; EC2 instance→role attachment is still a gap (see Scope boundary).
- The LLM narrates computed paths only; never let it generate the path.
- `holds_data` sensitivity is a type-based heuristic; the narrative must hedge.
- Keep the LLM to the top-N paths to bound CPU latency (same constraint as the main analysis).

---

## Phased Claude Code prompts

Hand these over one at a time, reviewing each before the next — same cadence as the original build.

### AP-1 — Graph data model + capability tagging

```text
Add the attack-path data layer. New Drizzle tables (generate a migration): graph_nodes, graph_edges, attack_paths (see docs/ATTACK_PATHS_DESIGN.md "Data model"), all keyed by scan_id with cascade delete and an index on (scan_id).

Create src/lib/graph/tagging.ts: a PURE function that takes the persisted FAILED findings for a scan and produces graph_nodes (one per distinct resource: type, name, region, account_id) with capability tags applied via the mapping table in the design doc (match check_id by prefix/glob; holds_data by resource_type). Also derive graph_edges ONLY from relationships present in the finding detail (attached role, security groups) — never from co-location.

Add repository functions: saveGraph(scanId, nodes, edges), getGraph(scanId). Wire graph-building into the scan pipeline right after findings persist (before/independent of the LLM analysis). Add unit tests with a fixture finding set asserting the expected nodes, tags, and edges. Run typecheck/lint/test/build. Do NOT add rules or UI yet.
```

### AP-2 — Path engine + rules

```text
Add src/lib/graph/paths.ts: a PURE path engine. Given a scan's nodes+edges, identify entry nodes (exposed_internet/publicly_accessible) and target nodes (holds_data/privileged), run the toxic-combination rule set from docs/ATTACK_PATHS_DESIGN.md ("The rule set"), and produce attack_paths: single-node combos directly, relational rules via bounded BFS (max 4 hops) over edges. Set confidence = high for real-edge links, medium for same-resource/heuristic combos. Dedupe, rank by severity then confidence, cap to top 50. Persist via a saveAttackPaths(scanId, paths) repo function.

Encode rules declaratively (a list of {id, severity, predicate}) so they're easy to extend. Unit-test each rule with fixtures (nodes/edges in -> expected paths out), including a no-paths case and a multi-hop case. No LLM, no network, no UI. Run typecheck/lint/test/build.
```

### AP-3 — Grounded LLM narration

```text
Narrate attack paths with the local LLM, reusing the existing structured-output pipeline (json_schema first, chunked, partial-report tolerant, background job). Create src/lib/graph/narrate.ts and a SYSTEM prompt that takes ONE computed path at a time (nodes, edges, capability tags, matched rule, underlying finding titles) and returns JSON matching the narration schema in docs/ATTACK_PATHS_DESIGN.md (summary, attack_scenario, blast_radius, severity_rationale, break_the_chain[], confidence_note, false_positive_risk).

Hard rule in the system prompt: describe ONLY the provided path; never introduce resources or edges not in the input; flag heuristic links (e.g. holds_data is type-based) and unknown data sensitivity. Persist each narrative onto its attack_paths row. Run narration as part of the existing background analysis job (after the findings analysis), updating progress the same way. Add a test that a path with a deliberately-broken model response still degrades gracefully (path persists without narrative). Run typecheck/lint/test/build. Don't rescan AWS — use a seeded scan.
```

### AP-4 — "Attack Paths" UI + diff extension

```text
Invoke ui-ux-pro-max. Add an "Attack Paths" tab to the dashboard (beside Findings/History/Changes), reusing the dark SOC tokens. Poll the scan's attack paths via a new GET /api/scan/[id]/paths.

- Ranked path list; each card shows a compact horizontal chain (Internet -> exposed node -> ... -> target) with capability badges, a reassessed severity badge, hop count, and a confidence chip.
- Expand -> the LLM narrative: attack_scenario, blast_radius, break_the_chain steps with copy-to-clipboard CLI, confidence_note, false_positive_risk.
- Header summary ("N paths - X critical") and an Overview callout ("paths reach sensitive data") linking to the tab.
- States: none-found, loading skeletons, error. Accessibility consistent with the rest of the app.

Also extend the diff engine (src/lib/diff.ts) to compute attack-path deltas keyed by rule_id+entry_key+target_key, and surface "new / resolved attack paths" in the Changes view. Run typecheck/lint/test/build, then screenshot the Attack Paths tab (populate with a seeded scan or mock) for review.
```

### AP-5 — (v2) PMapper integration

```text
Add PMapper as a second read-only scanner to produce authoritative IAM edges. Following the PROWLER_EXEC_MODE pattern, run PMapper for the environment (container or CLI), parse its IAM authorization + privilege-escalation graph into graph_nodes/graph_edges with source='pmapper' and relations can_assume/can_access (+privesc), and merge with the Prowler-derived graph before the path engine runs. Real IAM links get confidence=high. Keep it read-only and AWS-SDK-free (delegate to the tool). Gate behind a PMAPPER_ENABLED flag so v1 still works without it. Add parsing unit tests with a sample PMapper output. Document setup in docs/ATTACK_PATHS_DESIGN.md. Run typecheck/lint/test/build.
```

---

When v1 (AP-1 → AP-4) is in, Parapet doesn't just list problems — it shows the *routes*, and recurring scans show which routes you've closed. That's the feature that makes it stand out.
