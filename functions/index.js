/**
 * Masker by Ganit - PII Redaction API  (OCR-anchored)
 * Powered by Google Vision OCR + Gemini 2.5 Flash-Lite
 *
 * POST /redact  (multipart/form-data, field "file" = image or PDF)
 *   -> returns the redacted file (same format in, same format out)
 *      + header  X-Masker-Report  with a JSON summary of what was redacted
 *
 * How it works (OCR-anchored - boxes never drift):
 *   1. Read the uploaded image or PDF; PDFs are rendered to PNG per page.
 *   2. Google Vision OCR reads each page -> every WORD with its exact pixel box.
 *   3. Gemini receives the numbered word list (text only) and returns the
 *      indices of the words that are PII - it makes the judgement, not geometry.
 *   4. We black out the OCR pixel box of each flagged word. Pixel-perfect.
 *   5. Re-assemble: PDF -> PDF, image -> image.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const vision = require("@google-cloud/vision");
const Busboy = require("busboy");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { PDFDocument } = require("pdf-lib");
const path = require("path");
const { createRequire } = require("module");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const MODEL = "gemini-2.5-flash-lite";
const PDF_RENDER_SCALE = 2.0;

// Vision client authenticates automatically via the function's service account.
const visionClient = new vision.ImageAnnotatorClient();

// ---------------------------------------------------------------------------
// Prompt: Gemini classifies which numbered words are PII. No coordinates.
// ---------------------------------------------------------------------------
function buildPrompt(words) {
  const numbered = words.map((w, i) => `${i}: ${w.text}`).join("\n");
  return `You are a medical-document privacy expert. Below is a numbered list of every word read from one page of a medical document, in reading order.

Identify which words are Personally Identifiable Information (PII) or Protected Health Information (PHI) that must be redacted. Include:
- Patient / doctor / relative names (every name token, but NOT a "Dr"/"Mr"/"Mrs" title word on its own)
- Address parts, cities, postal codes, AND the house/building number (e.g. "27")
- Phone / fax numbers, email addresses (every token of them)
- Dates of birth, ages
- Medical record numbers (MRN), patient IDs, account numbers
- National IDs (Aadhaar, SSN, passport), insurance / policy numbers
- Signatures and handwritten identifiers

IMPORTANT - redact the WHOLE identifier including any prefix that OCR split off:
- If an ID reads as separate tokens like "MRN-" then "558213", flag BOTH tokens.
- Same for "INS-PL-" + number, "ID:" attached to a value, etc. Never leave the
  prefix or part of an ID/number/address visible. When unsure, redact it.

Do NOT redact: field labels (e.g. "Patient", "Name:", "Date of Birth:", "Address:", "Phone:", "Email:", "Insurance Policy:"), clinical findings, diagnoses, medication names, lab values, hospital/lab names, or generic words.

Return ONLY valid JSON, no markdown, in exactly this shape:
{ "pii": [ { "index": <number>, "type": "<category>" } ] }
Include one entry per PII word index. If none, return { "pii": [] }.

WORDS:
${numbered}`;
}

// ---------------------------------------------------------------------------
// Parse a multipart/form-data upload into { buffer, filename, mimeType }.
// ---------------------------------------------------------------------------
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    let fileBuffer = null, filename = "upload", mimeType = "application/octet-stream";
    bb.on("file", (_n, stream, info) => {
      filename = info.filename || filename;
      mimeType = info.mimeType || mimeType;
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => reject(new Error("File too large (max 25 MB).")));
      stream.on("end", () => (fileBuffer = Buffer.concat(chunks)));
    });
    bb.on("close", () => fileBuffer ? resolve({ buffer: fileBuffer, filename, mimeType }) : reject(new Error("No file received.")));
    bb.on("error", reject);
    bb.end(req.rawBody);
  });
}

// ---------------------------------------------------------------------------
// OCR a page PNG with Vision -> [{ text, box:{x,y,w,h} }] in pixel coords.
// ---------------------------------------------------------------------------
async function ocrWords(pngBuffer) {
  const [result] = await visionClient.documentTextDetection({ image: { content: pngBuffer } });
  const ann = result.fullTextAnnotation;
  const words = [];
  if (!ann) return words;
  for (const page of ann.pages || []) {
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const text = (word.symbols || []).map((s) => s.text).join("");
          const verts = (word.boundingBox && word.boundingBox.vertices) || [];
          if (!text || verts.length < 4) continue;
          const xs = verts.map((v) => v.x || 0), ys = verts.map((v) => v.y || 0);
          const x = Math.min(...xs), y = Math.min(...ys);
          words.push({ text, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } });
        }
      }
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// Ask Gemini which word indices are PII.  Returns Map<index, type>.
// ---------------------------------------------------------------------------
async function classifyPII(genAI, words) {
  if (words.length === 0) return new Map();
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent(buildPrompt(words));
  let text = result.response.text().trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const map = new Map();
  try {
    const parsed = JSON.parse(text);
    for (const it of parsed.pii || []) {
      if (typeof it.index === "number" && it.index >= 0 && it.index < words.length) {
        map.set(it.index, it.type || "PII");
      }
    }
  } catch { /* leave map empty on parse failure */ }
  return map;
}

// ---------------------------------------------------------------------------
// Black out the OCR boxes of the flagged words on a page image.
// Returns { pngBuffer, width, height, items:[{type, text}] }.
// ---------------------------------------------------------------------------
async function redactPage(pngBuffer, words, piiMap) {
  const img = await loadImage(pngBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "#000000";
  const items = [];
  for (const [idx, type] of piiMap) {
    const w = words[idx];
    if (!w) continue;
    const { x, y, w: bw, h: bh } = w.box;
    const pad = Math.max(2, bh * 0.18); // small even pad - OCR boxes are tight & accurate
    ctx.fillRect(x - pad, y - pad, bw + pad * 2, bh + pad * 2);
    items.push({ type, text: w.text });
  }
  return { pngBuffer: canvas.toBuffer("image/png"), width: img.width, height: img.height, items };
}

// Process one page: OCR -> classify -> redact.
async function processPage(genAI, pngBuffer) {
  const words = await ocrWords(pngBuffer);
  const piiMap = await classifyPII(genAI, words);
  return redactPage(pngBuffer, words, piiMap);
}

// ---------------------------------------------------------------------------
// Render every page of a PDF to a PNG buffer using pdfjs-dist.
// ---------------------------------------------------------------------------
async function renderPdfPages(pdfBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const req = createRequire(__filename);
  const fontsDir = path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts");
  const fs = require("fs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    StandardFontDataFactory: class {
      fetch({ filename }) { return new Uint8Array(fs.readFileSync(path.join(fontsDir, filename))); }
    },
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvasFactory: makeCanvasFactory() }).promise;
    pages.push(canvas.toBuffer("image/png"));
  }
  return pages;
}

function makeCanvasFactory() {
  return {
    create(width, height) { const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext("2d") }; },
    reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; },
    destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; },
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
exports.redact = onRequest(
  { secrets: [GEMINI_API_KEY], cors: true, memory: "1GiB", timeoutSeconds: 300, invoker: "public" },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Expose-Headers", "X-Masker-Report, Content-Disposition");

    try {
      const { buffer, filename, mimeType } = await parseUpload(req);
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
      const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
      const report = { pages: [], totalRedactions: 0 };

      if (isPdf) {
        const pagePngs = await renderPdfPages(buffer);
        const outPdf = await PDFDocument.create();
        for (let i = 0; i < pagePngs.length; i++) {
          const { pngBuffer, width, height, items } = await processPage(genAI, pagePngs[i]);
          const png = await outPdf.embedPng(pngBuffer);
          const pg = outPdf.addPage([width, height]);
          pg.drawImage(png, { x: 0, y: 0, width, height });
          report.pages.push({ page: i + 1, redactions: items.length, items: items.map(summarise) });
          report.totalRedactions += items.length;
        }
        const outBytes = await outPdf.save();
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="redacted-${safe(filename)}"`);
        res.set("X-Masker-Report", JSON.stringify(report));
        return res.status(200).send(Buffer.from(outBytes));
      } else {
        const { pngBuffer, items } = await processPage(genAI, buffer);
        report.pages.push({ page: 1, redactions: items.length, items: items.map(summarise) });
        report.totalRedactions += items.length;
        const outName = safe(filename).replace(/\.(jpe?g|webp|gif|bmp)$/i, ".png");
        res.set("Content-Type", "image/png");
        res.set("Content-Disposition", `attachment; filename="redacted-${outName}"`);
        res.set("X-Masker-Report", JSON.stringify(report));
        return res.status(200).send(pngBuffer);
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message || "Redaction failed." });
    }
  }
);

// Report rows mask the actual PII text.
function summarise(it) {
  const t = (it.text || "").toString();
  const masked = t.length <= 2 ? "**" : t[0] + "*".repeat(Math.max(1, t.length - 2)) + t.slice(-1);
  return { type: it.type || "PII", preview: masked };
}
function safe(name) { return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_"); }
