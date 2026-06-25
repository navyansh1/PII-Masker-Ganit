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
// Models tried in order. When the primary keeps returning 503 ("high demand")
// after its retries are exhausted, we fall back to the next model so the run
// completes instead of failing the whole document.
const MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const PDF_RENDER_SCALE = 2.0;
const PAGE_CONCURRENCY = 4;   // pages classified in parallel (bounded)
// Keep total retry time bounded: with 2 models, this is at most
// 2 retries * 2 models per page. Long retry storms used to blow the gateway
// timeout and surface as a 502 to the browser, so we fail over to the regex
// fallback faster instead of hanging.
const MAX_RETRIES = 2;        // retries per Gemini call on transient errors

// True for errors worth retrying / falling back on: 5xx/429 from the API,
// "high demand" overload messages, and transient network blips.
function isTransient(err) {
  const msg = String(err && err.message);
  return /\b(429|500|502|503|504)\b/.test(msg) ||
    /overloaded|high demand|unavailable|deadline|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

// Run an async task with exponential backoff + jitter on transient Gemini
// failures (503 overloaded / 429 rate-limit / network blips). Non-transient
// errors are re-thrown immediately.
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message);
      if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400);
      console.warn(`[retry] ${label} attempt ${attempt + 1} failed (${msg.slice(0, 120)}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Map over items with a bounded number running concurrently. Results keep
// input order. Throws if any task throws (after its own retries are exhausted).
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// Vision client authenticates automatically via the function's service account.
const visionClient = new vision.ImageAnnotatorClient();

// ---------------------------------------------------------------------------
// Prompt: Gemini classifies which numbered words are PII. No coordinates.
// `mode` selects how much to redact:
//   "full"    (default) - all PII/PHI categories below.
//   "id-name"            - ONLY the patient id value and the patient name.
// ---------------------------------------------------------------------------
function buildPrompt(words, mode) {
  const numbered = words.map((w, i) => `${i}: ${w.text}`).join("\n");

  if (mode === "id-name") {
    return `You are a medical-document privacy expert. Below is a numbered list of every word read from one page of a medical document, in reading order.

Redact ONLY these three things, and NOTHING else:
- The PATIENT ID value - the identifier next to a label like "Patient Id", "Patient ID", "MRN", "UHID", "Reg No", "Patient No". Flag every token of the value, including any prefix OCR split off (e.g. "MMD3180157", or "MRN-" + "558213" = both tokens).
- The PATIENT NAME value - every name token of the patient (first/middle/last), but NOT a "Dr"/"Mr"/"Mrs"/"Ms" title word on its own.
- The AADHAAR number - the 12-digit Indian national ID, usually shown as three 4-digit groups (e.g. "4729 8841 2096" = all three tokens) or as one 12-digit block. Flag every token of it, including any "Aadhaar"/"UID" value that is a number. Do NOT flag the label word "Aadhaar"/"UID" itself.

Do NOT redact anything else: not the field labels themselves ("Patient", "Patient Id", "Name", "Aadhaar", etc.), not dates, not age/sex, not doctor names, not addresses, phones, emails, encounter/voucher/account/policy numbers, amounts, diagnoses, or any other text. ONLY the patient id value, the patient name value, and the Aadhaar number.

Return ONLY valid JSON, no markdown, in exactly this shape:
{ "pii": [ { "index": <number>, "type": "<patient_id|patient_name|aadhaar>" } ] }
Include one entry per flagged word index. If none, return { "pii": [] }.

WORDS:
${numbered}`;
  }

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
// Rule-based PII detector. Last-resort fallback for when EVERY Gemini model is
// down (Google capacity spike). Far less precise than the LLM, but guarantees
// the document still gets redacted rather than failing. Errs toward
// over-redaction: anything that looks like a number/id/contact is masked.
// Returns Map<index, type>.
// ---------------------------------------------------------------------------
const LABEL_WORDS = new Set([
  "patient", "name", "doctor", "dr", "mr", "mrs", "ms", "date", "of", "birth",
  "dob", "address", "phone", "tel", "fax", "email", "e-mail", "mrn", "id",
  "age", "sex", "gender", "insurance", "policy", "ward", "bed", "room",
  "hospital", "report", "summary", "discharge", "admission", "department",
]);
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_PHONE = /^\+?\(?\d[\d\s().-]{6,}$/;          // 7+ digits, phone-ish
const RE_ID = /^[A-Za-z]{0,4}[-:#]?\d{3,}[-\dA-Za-z]*$/; // MRN-12345, INS-PL-9, 558213
const RE_IDPREFIX = /^(MRN|INS|PL|ID|UHID|SSN|AADHAAR|ACC|REF|POLICY)[-:#]?$/i;
const RE_DATE = /^\d{1,4}[/\-.]\d{1,2}([/\-.]\d{1,4})?$/; // 12/03/1980, 1980-03-12
const RE_CAPNAME = /^[A-Z][a-z]{1,}$/;                 // Capitalised word (name-ish)

function classifyPIIRegex(words) {
  const map = new Map();
  for (let i = 0; i < words.length; i++) {
    const raw = (words[i].text || "").trim();
    if (!raw) continue;
    const lower = raw.toLowerCase().replace(/[:.]$/, "");
    if (LABEL_WORDS.has(lower)) continue; // never redact a field label itself

    let type = null;
    if (RE_EMAIL.test(raw)) type = "email";
    else if (RE_IDPREFIX.test(raw)) type = "id";
    else if (RE_DATE.test(raw)) type = "date";
    else if (RE_PHONE.test(raw) && (raw.replace(/\D/g, "").length >= 7)) type = "phone";
    else if (RE_ID.test(raw) && /\d/.test(raw)) type = "id";
    else if (RE_CAPNAME.test(raw)) {
      // A capitalised word right after a name/doctor label is very likely a name.
      const prev = (words[i - 1]?.text || "").toLowerCase().replace(/[:.]$/, "");
      const prev2 = (words[i - 2]?.text || "").toLowerCase().replace(/[:.]$/, "");
      if (["name", "patient", "doctor", "dr", "mr", "mrs", "ms"].includes(prev) ||
          ["name", "patient", "doctor"].includes(prev2)) type = "name";
    }
    if (type) map.set(i, type);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Parse a multipart/form-data upload into { buffer, filename, mimeType }.
// ---------------------------------------------------------------------------
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    let fileBuffer = null, filename = "upload", mimeType = "application/octet-stream";
    let mode = "full";
    bb.on("field", (name, val) => { if (name === "mode") mode = val; });
    bb.on("file", (_n, stream, info) => {
      filename = info.filename || filename;
      mimeType = info.mimeType || mimeType;
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => reject(new Error("File too large (max 25 MB).")));
      stream.on("end", () => (fileBuffer = Buffer.concat(chunks)));
    });
    bb.on("close", () => fileBuffer ? resolve({ buffer: fileBuffer, filename, mimeType, mode }) : reject(new Error("No file received.")));
    bb.on("error", reject);
    bb.end(req.rawBody);
  });
}

// ---------------------------------------------------------------------------
// OCR a page PNG with Vision -> [{ text, box:{x,y,w,h} }] in pixel coords.
// ---------------------------------------------------------------------------
async function ocrWords(pngBuffer) {
  const [result] = await withRetry(
    () => visionClient.documentTextDetection({ image: { content: pngBuffer } }),
    "vision-ocr"
  );
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
async function classifyPII(genAI, words, mode) {
  if (words.length === 0) return { map: new Map(), engine: "gemini" };
  const prompt = buildPrompt(words, mode);
  // Try each model in order. withRetry handles short-lived spikes within a
  // model; if a model is still 503-ing after all retries, fall back to the
  // next one. If EVERY model is down (Google-wide spike), fall back to the
  // rule-based detector so the document is still redacted rather than failing.
  let result, lastErr;
  for (let m = 0; m < MODELS.length; m++) {
    const name = MODELS[m];
    try {
      const model = genAI.getGenerativeModel({ model: name });
      result = await withRetry(() => model.generateContent(prompt), `gemini-classify:${name}`);
      if (m > 0) console.warn(`[fallback] classified with ${name} after ${MODELS[m - 1]} was unavailable`);
      break;
    } catch (err) {
      lastErr = err;
      if (isTransient(err) && m < MODELS.length - 1) {
        console.warn(`[fallback] ${name} unavailable (${String(err.message).slice(0, 120)}); trying ${MODELS[m + 1]}`);
        continue;
      }
      if (isTransient(err)) break; // all models exhausted -> regex fallback below
      throw err;                   // non-transient (bad key, bad request) -> real error
    }
  }
  if (!result) {
    // id-name mode needs the LLM to tell apart the patient id/name from every
    // other id, date, doctor, etc. The blunt regex detector can't do that
    // without over-redacting, so we surface a real error instead of guessing.
    if (mode === "id-name") {
      throw new Error("AI service is temporarily unavailable. Please try again shortly.");
    }
    console.warn(`[fallback] all Gemini models unavailable (${String(lastErr && lastErr.message).slice(0, 120)}); using regex detector`);
    return { map: classifyPIIRegex(words), engine: "regex" };
  }
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
  return { map, engine: "gemini" };
}

// ---------------------------------------------------------------------------
// Black out the OCR boxes of the flagged words on a page image.
// Returns { pngBuffer, width, height, items:[{type, text}] }.
// ---------------------------------------------------------------------------
async function redactPage(pngBuffer, words, piiMap, engine) {
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
  return { pngBuffer: canvas.toBuffer("image/png"), width: img.width, height: img.height, items, engine };
}

// Process one page: OCR -> classify -> redact.
async function processPage(genAI, pngBuffer, mode) {
  const words = await ocrWords(pngBuffer);
  const { map, engine } = await classifyPII(genAI, words, mode);
  return redactPage(pngBuffer, words, map, engine);
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
      const { buffer, filename, mimeType, mode } = await parseUpload(req);
      // Only two modes are valid; anything else falls back to full redaction.
      const redactMode = mode === "id-name" ? "id-name" : "full";
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
      const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
      // engine: "gemini" normally, "regex" if every model was down and we fell
      // back to the rule-based detector for any page. The UI reads this to warn
      // the user that AI redaction was unavailable.
      const report = { pages: [], totalRedactions: 0, engine: "gemini", mode: redactMode };

      if (isPdf) {
        const pagePngs = await renderPdfPages(buffer);
        // Classify pages concurrently (bounded); each call retries on transient
        // Gemini/Vision errors so one hiccup no longer fails the whole document.
        const processed = await mapConcurrent(pagePngs, PAGE_CONCURRENCY, (png) => processPage(genAI, png, redactMode));
        // Assemble in original page order.
        const outPdf = await PDFDocument.create();
        for (let i = 0; i < processed.length; i++) {
          const { pngBuffer, width, height, items, engine } = processed[i];
          if (engine === "regex") report.engine = "regex";
          const png = await outPdf.embedPng(pngBuffer);
          const pg = outPdf.addPage([width, height]);
          pg.drawImage(png, { x: 0, y: 0, width, height });
          report.pages.push({ page: i + 1, redactions: items.length, items: items.map(summarise) });
          report.totalRedactions += items.length;
        }
        const outBytes = await outPdf.save();
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="redacted-${safe(filename)}"`);
        res.set("X-Masker-Report", headerSafeJson(report));
        return res.status(200).send(Buffer.from(outBytes));
      } else {
        const { pngBuffer, items, engine } = await processPage(genAI, buffer, redactMode);
        if (engine === "regex") report.engine = "regex";
        report.pages.push({ page: 1, redactions: items.length, items: items.map(summarise) });
        report.totalRedactions += items.length;
        const outName = safe(filename).replace(/\.(jpe?g|webp|gif|bmp)$/i, ".png");
        res.set("Content-Type", "image/png");
        res.set("Content-Disposition", `attachment; filename="redacted-${outName}"`);
        res.set("X-Masker-Report", headerSafeJson(report));
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

// HTTP header values must be ASCII (no newlines/control/non-Latin1 chars).
// OCR'd PII previews can contain Devanagari, accents, etc. — strip them so the
// X-Masker-Report header never crashes the response after the work is done.
function headerSafeJson(obj) {
  return JSON.stringify(obj).replace(/[^\x20-\x7E]/g, "?");
}
