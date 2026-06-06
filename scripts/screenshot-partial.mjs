/**
 * Screenshot the "Partial report" note rendering above a report (uses the
 * ?demo=partial mode so it doesn't depend on a live partial run). Loads the
 * real container UI at BASE_URL (default http://localhost:3000).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page.goto(`${BASE}/?demo=partial`, { waitUntil: "networkidle" });
await page.getByText("Partial report").waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/p11-partial-note.png` });
console.log("✓ p11-partial-note.png");

await browser.close();
console.log("done");
