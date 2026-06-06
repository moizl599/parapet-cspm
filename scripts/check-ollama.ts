// CLI health check for the local Ollama service. Run via `npm run check:ollama`.
// Prints a structured result and a human-friendly status line. It always exits
// 0 — being "not running yet" is an expected state during setup, not a failure.
import { healthCheck } from "@/lib/ollama";

const health = await healthCheck();

console.log(JSON.stringify(health, null, 2));
console.log(
  `\nOllama: ${health.ok ? "READY ✓" : `${health.status.toUpperCase()} ✗`} — ${health.message}`,
);

process.exit(0);
