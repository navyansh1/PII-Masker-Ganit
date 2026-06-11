/**
 * Standalone end-to-end test of the redaction pipeline (no Firebase needed).
 * Runs the SAME detect -> redact logic as the Cloud Function against the
 * sample documents and writes the redacted output for visual inspection.
 *
 *   GEMINI_API_KEY=xxxx node test-redact.js
 */
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { PDFDocument } = require("pdf-lib");

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("Set GEMINI_API_KEY"); process.exit(1); }
const genAI = new GoogleGenerativeAI(KEY);
const MODEL = "gemini-2.5-flash-lite";
const DIR = process.env.SAMPLE_DIR || __dirname;

const PII_PROMPT = `You are a medical-document privacy expert. Look at this page image and find ALL Personally Identifiable Information (PII) and Protected Health Information (PHI).
Detect names, addresses, phones, emails, dates of birth, ages, MRNs/patient IDs, national IDs (Aadhaar/SSN), insurance/policy numbers, signatures, and any identifying text.
For EACH occurrence return a bounding box using coordinates where top-left is [0,0] and bottom-right is [1000,1000].
Return ONLY valid JSON: { "items": [ { "type": "<category>", "text": "<text>", "box": [ymin,xmin,ymax,xmax] } ] }
If none, return { "items": [] }.`;

async function detectPII(pngBuffer) {
  const model = genAI.getGenerativeModel({ model: MODEL });
  const r = await model.generateContent([
    PII_PROMPT,
    { inlineData: { mimeType: "image/png", data: pngBuffer.toString("base64") } },
  ]);
  let t = r.response.text().trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t).items || []; } catch { return []; }
}

async function redactPage(pngBuffer, items) {
  const img = await loadImage(pngBuffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "#000";
  for (const it of items) {
    if (!Array.isArray(it.box) || it.box.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = it.box;
    const x = (Math.min(xmin, xmax) / 1000) * img.width;
    const y = (Math.min(ymin, ymax) / 1000) * img.height;
    const w = (Math.abs(xmax - xmin) / 1000) * img.width;
    const h = (Math.abs(ymax - ymin) / 1000) * img.height;
    const padY = Math.max(3, h * 0.18);
    const padX = Math.max(6, h * 0.35);
    ctx.fillRect(x - padX, y - padY, w + padX * 2, h + padY * 2);
  }
  return c.toBuffer("image/png");
}

async function renderPdfPages(pdfBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fontsDir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer), disableWorker: true,
    StandardFontDataFactory: class {
      fetch({ filename }) { return new Uint8Array(fs.readFileSync(path.join(fontsDir, filename))); }
    },
  }).promise;
  const cf = {
    create(w, h) { const cv = createCanvas(w, h); return { canvas: cv, context: cv.getContext("2d") }; },
    reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; },
    destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; },
  };
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 2 });
    const cv = createCanvas(vp.width, vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, canvasFactory: cf }).promise;
    pages.push(cv.toBuffer("image/png"));
  }
  return pages;
}

(async () => {
  // ---- Image test ----
  console.log("\n=== discharge-summary.png ===");
  const imgBuf = fs.readFileSync(path.join(DIR, "discharge-summary.png"));
  const imgItems = await detectPII(imgBuf);
  console.log("Detected " + imgItems.length + " PII items:");
  imgItems.forEach((i) => console.log("  - [" + i.type + "] " + i.text));
  fs.writeFileSync(path.join(DIR, "OUT-discharge-redacted.png"), await redactPage(imgBuf, imgItems));
  console.log("Wrote OUT-discharge-redacted.png");

  // ---- PDF test (multi-page) ----
  console.log("\n=== lab-report.pdf ===");
  const pdfBuf = fs.readFileSync(path.join(DIR, "lab-report.pdf"));
  const pages = await renderPdfPages(pdfBuf);
  const outPdf = await PDFDocument.create();
  let total = 0;
  for (let i = 0; i < pages.length; i++) {
    const items = await detectPII(pages[i]);
    total += items.length;
    console.log("Page " + (i + 1) + ": " + items.length + " PII items");
    items.forEach((it) => console.log("    - [" + it.type + "] " + it.text));
    const red = await redactPage(pages[i], items);
    const png = await outPdf.embedPng(red);
    const img = await loadImage(red);
    const pg = outPdf.addPage([img.width, img.height]);
    pg.drawImage(png, { x: 0, y: 0, width: img.width, height: img.height });
  }
  fs.writeFileSync(path.join(DIR, "OUT-lab-report-redacted.pdf"), await outPdf.save());
  console.log("Wrote OUT-lab-report-redacted.pdf (" + total + " total redactions)");
  console.log("\nDONE.");
})();
