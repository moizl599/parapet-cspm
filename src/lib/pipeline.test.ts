import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeFindings, summarizeFindings } from "./ocsf.ts";
import { analyzeFindings, type StreamChatFn } from "./analyze.ts";
import { isValidScanId, scanDir } from "@/lib/scan-store";

/**
 * Integration test for the analysis pipeline with NO live dependencies:
 *   committed OCSF fixture (stands in for Prowler's output file)
 *     -> normalizeFindings -> summarizeFindings
 *     -> analyzeFindings (Ollama streamer mocked)
 *     -> prioritized report
 *
 * DB persistence (the storage the routes use) is covered in repository.test.ts.
 */

const fixtureUrl = new URL("./__fixtures__/sample.ocsf.json", import.meta.url);
const rawOcsf: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

const ANALYSIS_JSON = JSON.stringify({
  executive_summary: "Two failing controls dominate risk; fix the public path first.",
  posture_score: 55,
  items: [
    {
      title: "Lock down public S3 bucket",
      severity: "critical",
      priority_rank: 2,
      affected_resources: ["arn:aws:s3:::redacted-bucket"],
      why_it_matters: "Public buckets leak data.",
      attack_scenario: "Anonymous download of the bucket contents.",
      remediation_steps: ["Enable Block Public Access"],
      effort: "quick-win",
      risk_of_fix: "May break anonymous consumers.",
      references: [],
    },
    {
      title: "Restrict SSH from the internet",
      severity: "high",
      priority_rank: 1,
      affected_resources: ["sg-REDACTED"],
      why_it_matters: "Open admin ports invite brute force.",
      attack_scenario: "Internet-wide SSH brute force.",
      remediation_steps: ["Remove 0.0.0.0/0 rule"],
      effort: "moderate",
      risk_of_fix: "May disconnect admins.",
      references: [],
    },
  ],
  quick_wins: ["Lock down public S3 bucket"],
});

/** Mock Ollama streamer that yields a fixed valid analysis in two chunks. */
function mockStreamer(): { fn: StreamChatFn; calls: number } {
  const state = { fn: (() => {}) as unknown as StreamChatFn, calls: 0 };
  state.fn = (() => {
    state.calls += 1;
    return (async function* () {
      const mid = Math.floor(ANALYSIS_JSON.length / 2);
      yield ANALYSIS_JSON.slice(0, mid);
      yield ANALYSIS_JSON.slice(mid);
    })();
  }) as StreamChatFn;
  return state;
}

test("full pipeline: OCSF fixture -> normalize -> analyze -> prioritized report", async () => {
  const { findings, dropped } = normalizeFindings(rawOcsf);
  assert.equal(findings.length, 3);
  assert.equal(dropped, 2);

  const summary = summarizeFindings(findings);
  assert.equal(summary.totalFailed, 2);

  const streamer = mockStreamer();
  const tokens: string[] = [];
  const analysis = await analyzeFindings(findings, summary, {
    streamChat: streamer.fn,
    onToken: (t) => tokens.push(t),
  });

  assert.equal(streamer.calls, 1);
  assert.ok(tokens.join("").length > 0, "tokens streamed for live UI");
  assert.ok(analysis.posture_score >= 0 && analysis.posture_score <= 100);
  assert.equal(analysis.items.length, 2);
  assert.ok(analysis.executive_summary.length > 0);
  assert.ok(analysis.quick_wins.length > 0);
  const ranks = analysis.items.map((i) => i.priority_rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2]);
});

test("scan ids are validated against path traversal", () => {
  assert.equal(isValidScanId("../etc/passwd"), false);
  assert.equal(isValidScanId("a/b"), false);
  assert.equal(isValidScanId("good-id_123"), true);
  assert.throws(() => scanDir("../escape"));
});
