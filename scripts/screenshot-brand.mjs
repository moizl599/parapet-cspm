/**
 * Verify the Parapet branding live: screenshot the header (logo + wordmark),
 * a tight crop of just the brand, and confirm the favicon (/icon.svg) + tab
 * title are served. Loads the real container at BASE_URL (default :3000).
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

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.getByText("Parapet", { exact: true }).first().waitFor();
await page.waitForTimeout(400);

// Full header.
await page.screenshot({ path: `${OUT}/p12-header.png`, clip: { x: 0, y: 0, width: 1440, height: 64 } });
console.log("✓ p12-header.png");

// Tight brand crop (logo + wordmark).
const brand = page.locator('a[href="/"]').first();
await brand.screenshot({ path: `${OUT}/p12-brand.png` });
console.log("✓ p12-brand.png");

// Tab title.
const title = await page.title();
console.log("tab title:", JSON.stringify(title));

// Favicon served + linked.
const iconHref = await page
  .locator('link[rel="icon"]')
  .first()
  .getAttribute("href")
  .catch(() => null);
console.log("favicon link href:", iconHref);
const res = await page.request.get(`${BASE}/icon.svg`);
console.log("/icon.svg status:", res.status(), "content-type:", res.headers()["content-type"]);

// Favicon legibility preview: render the icon at real favicon sizes (16/32/48)
// on a dark chip so we can confirm it isn't muddy at small scale.
const preview = await browser.newPage();
await preview.setViewportSize({ width: 360, height: 140 });
await preview.setContent(
  `<body style="margin:0;background:#0a0e14;display:flex;gap:28px;align-items:center;justify-content:center;height:140px;font-family:sans-serif">
     <div style="text-align:center;color:#6b7890;font-size:11px">
       <img src="${BASE}/icon.svg" width="16" height="16"><div>16px</div>
     </div>
     <div style="text-align:center;color:#6b7890;font-size:11px">
       <img src="${BASE}/icon.svg" width="32" height="32"><div>32px</div>
     </div>
     <div style="text-align:center;color:#6b7890;font-size:11px">
       <img src="${BASE}/icon.svg" width="48" height="48"><div>48px</div>
     </div>
   </body>`,
);
await preview.waitForTimeout(300);
await preview.screenshot({ path: `${OUT}/p12-favicon-sizes.png` });
console.log("✓ p12-favicon-sizes.png");

await browser.close();
console.log("done");
