/** Screenshot the re-run report rendering live (real container, real data). */
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

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.getByText("Executive summary").waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/p11-rerun-report.png` });
console.log("✓ p11-rerun-report.png");

await browser.close();
console.log("done");
