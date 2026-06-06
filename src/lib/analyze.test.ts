import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeFindings, summarizeFindings } from "./ocsf.ts";
import {
  analyzeFindings,
  chunkFindings,
  parseAnalysis,
  type StreamChatFn,
} from "./analyze.ts";
import type { ChatMessage } from "./ollama.ts";
import type { Finding } from "./ocsf.ts";

const fixtureUrl = new URL("./__fixtures__/sample.ocsf.json", import.meta.url);
const rawOcsf: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const { findings } = normalizeFindings(rawOcsf);
const summary = summarizeFindings(findings);

const VALID_ANALYSIS = JSON.stringify({
  executive_summary: "Two failing controls expose admin ports and public storage.",
  posture_score: 62,
  items: [
    {
      title: "Restrict SSH ingress",
      severity: "high",
      priority_rank: 1,
      affected_resources: ["sg-REDACTED"],
      why_it_matters: "Port 22 is open to the internet.",
      attack_scenario: "An attacker brute-forces SSH from anywhere.",
      remediation_steps: ["Remove 0.0.0.0/0 rule", "Restrict to office CIDR"],
      effort: "quick-win",
      risk_of_fix: "May disconnect admins on dynamic IPs.",
      references: [],
    },
  ],
  quick_wins: ["Restrict SSH ingress"],
});

/**
 * Build a mock streamer that returns the supplied responses in order (one per
 * call), yielding each in two chunks to exercise token streaming. Records the
 * messages it was called with so we can assert on the retry prompt.
 */
function mockStreamer(responses: string[]) {
  const calls: ChatMessage[][] = [];
  const fn: StreamChatFn = (messages) => {
    const text = responses[Math.min(calls.length, responses.length - 1)];
    calls.push(messages);
    return (async function* () {
      const mid = Math.floor(text.length / 2);
      yield text.slice(0, mid);
      yield text.slice(mid);
    })();
  };
  return { fn, calls };
}

test("parseAnalysis accepts valid JSON and coerces soft fields", () => {
  const analysis = parseAnalysis(
    JSON.stringify({
      executive_summary: "ok",
      posture_score: 200, // out of range -> clamped
      items: [
        {
          title: "t",
          severity: "HIGH", // case -> normalized
          effort: "easy", // unknown -> default "moderate"
          // priority_rank missing -> defaults to index+1
        },
      ],
      quick_wins: ["a", 5], // non-strings filtered out
    }),
  );
  assert.ok(analysis);
  assert.equal(analysis.posture_score, 100);
  assert.equal(analysis.items[0].severity, "high");
  assert.equal(analysis.items[0].effort, "moderate");
  assert.equal(analysis.items[0].priority_rank, 1);
  assert.deepEqual(analysis.quick_wins, ["a"]);
});

test("parseAnalysis extracts JSON from code fences", () => {
  const analysis = parseAnalysis(
    "Here you go:\n```json\n" + VALID_ANALYSIS + "\n```\nHope that helps!",
  );
  assert.ok(analysis);
  assert.equal(analysis.items.length, 1);
});

test("parseAnalysis returns null on structurally invalid responses", () => {
  assert.equal(parseAnalysis("no json at all"), null);
  assert.equal(parseAnalysis("{not valid json}"), null);
  assert.equal(parseAnalysis(JSON.stringify({ posture_score: 50 })), null); // no exec summary / items
  assert.equal(
    parseAnalysis(JSON.stringify({ executive_summary: "x" })),
    null,
  ); // items missing
});

test("analyzeFindings succeeds on first valid response and streams tokens", async () => {
  const streamer = mockStreamer([VALID_ANALYSIS]);
  const tokens: string[] = [];

  const analysis = await analyzeFindings(findings, summary, {
    streamChat: streamer.fn,
    onToken: (t) => tokens.push(t),
  });

  assert.equal(streamer.calls.length, 1); // no retry needed
  assert.equal(analysis.items[0].title, "Restrict SSH ingress");
  assert.equal(tokens.join(""), VALID_ANALYSIS); // every token surfaced
});

test("analyzeChunk retries on a transient miss and succeeds within the attempt budget", async () => {
  const streamer = mockStreamer([
    "Sure! Here's the plan (not json).",
    VALID_ANALYSIS,
  ]);

  const analysis = await analyzeFindings(findings, summary, {
    streamChat: streamer.fn,
  });

  // First json_schema attempt missed, second succeeded — within the 3-attempt
  // budget, no weak fallback needed.
  assert.equal(streamer.calls.length, 2);
  assert.equal(analysis.posture_score, 62);
});

test("analyzeFindings errors only when ALL chunks fail; uses 3 retries + 1 fallback", async () => {
  // mockStreamer reuses the last response, so every call returns garbage.
  const streamer = mockStreamer(["garbage"]);

  await assert.rejects(
    analyzeFindings(findings, summary, { streamChat: streamer.fn }),
    /All 1 finding group\(s\) failed/i,
  );
  // One chunk: 3 json_schema attempts + 1 json_object fallback = 4 model calls.
  assert.equal(streamer.calls.length, 4);
});

test("partial report: a chunk that always fails is SKIPPED, the rest still produce a report", async () => {
  // 8 "failme" + 8 "ec2" findings -> 2 service-grouped chunks of 8.
  const failed = [
    ...makeFailingFindings(8, "failme"),
    ...makeFailingFindings(8, "ec2"),
  ];
  assert.equal(chunkFindings(failed).length, 2);

  // The "failme" chunk always returns garbage (fails after retries + fallback);
  // the "ec2" chunk returns a valid report.
  let calls = 0;
  const partialStreamer: StreamChatFn = (messages) => {
    calls += 1;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const text = userMsg.includes('"service":"failme"') ? "not json" : VALID_ANALYSIS;
    return (async function* () {
      yield text;
    })();
  };

  const progress: Array<[number, number]> = [];
  const analysis = await analyzeFindings(failed, summarizeFindings(failed), {
    streamChat: partialStreamer,
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  // Report is PARTIAL but still produced from the chunk that succeeded.
  assert.equal(analysis.partial, true);
  assert.equal(analysis.analyzedGroups, 1);
  assert.equal(analysis.totalGroups, 2);
  assert.ok(analysis.items.length > 0);
  assert.ok(analysis.executive_summary.length > 0);
  // Progress advanced past the failed chunk (not stuck).
  assert.deepEqual(progress.at(-1), [2, 2]);
  // failing chunk: 3 schema + 1 fallback = 4; ok chunk: 1 => 5 total.
  assert.equal(calls, 5);
});

test("analyzeFindings short-circuits with no failed findings (model not called)", async () => {
  const streamer = mockStreamer(["should not be called"]);
  const passingOnly = findings.filter((f) => f.status !== "fail");

  const analysis = await analyzeFindings(passingOnly, summarizeFindings(passingOnly), {
    streamChat: streamer.fn,
  });

  assert.equal(streamer.calls.length, 0); // LLM skipped entirely
  assert.equal(analysis.posture_score, 100);
  assert.deepEqual(analysis.items, []);
});

/** Build N failing findings (optionally pinned to one service, to force chunking). */
function makeFailingFindings(n: number, service?: string): Finding[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${service ?? "f"}-${i}`,
    checkId: `chk_${service ?? ""}_${i}`,
    checkTitle: `Finding ${i}`,
    service: service ?? (i % 2 === 0 ? "iam" : "ec2"),
    severity: "high",
    status: "fail",
    region: "us-east-2",
    resourceId: `res-${i}`,
    resourceType: "Thing",
    description: "d",
    riskDetail: "r",
    remediationText: "fix",
    remediationUrl: null,
    complianceFrameworks: [],
  }));
}

test("structured output: a large chunk that previously broke now passes in one call per chunk", async () => {
  // 14 findings > CHUNK_SIZE(12) -> 2 service-grouped chunks. Previously, a big
  // free-form chunk returned invalid JSON and burned the retry; now each request
  // sends response_format json_schema and the (simulated) constrained output
  // validates on the first attempt — no retry.
  const failed = makeFailingFindings(14);
  const expectedChunks = chunkFindings(failed).length;
  assert.equal(expectedChunks, 2);

  const formats: unknown[] = [];
  let calls = 0;
  const structuredStreamer: StreamChatFn = (_messages, options) => {
    calls += 1;
    formats.push(options?.responseFormat);
    // What Ollama structured outputs guarantees: schema-valid JSON.
    return (async function* () {
      yield VALID_ANALYSIS;
    })();
  };

  const analysis = await analyzeFindings(
    failed,
    summarizeFindings(failed),
    { streamChat: structuredStreamer },
  );

  // One call per chunk, NO retry (the previously-breaking path).
  assert.equal(calls, expectedChunks);
  // Every request used structured json_schema output.
  assert.equal(formats.length, expectedChunks);
  for (const f of formats) {
    assert.equal((f as { type?: string })?.type, "json_schema");
  }
  // Produced a valid, merged report.
  assert.ok(analysis.items.length > 0);
  assert.ok(analysis.posture_score >= 0 && analysis.posture_score <= 100);
  assert.ok(analysis.executive_summary.length > 0);
});
