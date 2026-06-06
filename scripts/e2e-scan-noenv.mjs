// Verify the unhappy path: trigger a real scan with no AWS creds and confirm it
// surfaces status "error" with an actionable message (never a crash).
const base = process.env.BASE_URL || "http://localhost:3000";
const r = await fetch(`${base}/api/scan`, { method: "POST" });
const { scanId } = await r.json();
console.log("POST /api/scan ->", r.status, "scanId:", scanId);
for (let i = 0; i < 15; i++) {
  await new Promise((s) => setTimeout(s, 800));
  const g = await (await fetch(`${base}/api/scan/${scanId}`)).json();
  const st = g.status?.status;
  console.log(`  poll ${i}: ${st}${g.status?.error ? " | " + g.status.error : ""}`);
  if (st === "error" || st === "done") break;
}
