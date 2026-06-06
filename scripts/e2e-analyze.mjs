// Drive POST /api/analyze/<id> against the running container and consume the
// SSE stream (real Ollama). Prints streamed token count + the validated report.
// Uses undici with disabled header/body timeouts so a slow CPU chunk prefill
// (a >5min gap with no tokens) doesn't trip the default 5-min client timeout.
import { fetch, Agent } from "undici";

const id = process.argv[2] || "fixture-e2e";
const base = process.env.BASE_URL || "http://localhost:3000";
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const t0 = Date.now();
const res = await fetch(`${base}/api/analyze/${id}`, {
  method: "POST",
  dispatcher,
});
console.log("HTTP", res.status, res.headers.get("content-type"));
if (!res.body) {
  console.log("no body");
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let tokens = 0;
let result = null;
const errors = [];
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) !== -1) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    let p;
    try {
      p = JSON.parse(data.join("\n"));
    } catch {
      continue;
    }
    if (ev === "token") tokens++;
    else if (ev === "result") result = p.analysis;
    else if (ev === "error") errors.push(p.error);
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`streamed ${tokens} token events in ${secs}s`);
if (errors.length) console.log("errors:", errors);
if (!result) {
  console.log("NO RESULT EVENT");
  process.exit(1);
}
console.log("posture_score:", result.posture_score);
console.log("items:", result.items.length);
for (const it of result.items) {
  console.log(`  [${it.severity} / rank ${it.priority_rank}] ${it.title} (effort: ${it.effort})`);
}
console.log("quick_wins:", result.quick_wins.length);
console.log("exec_summary:", result.executive_summary.slice(0, 200));
