# Masker by Ganit

Automatic **PII / PHI redaction** for medical documents and reports. Upload any
image or PDF, and Masker finds every piece of personal information on every page
and blacks it out — then hands you the redacted file to download.

Built on **Google Vision OCR + Gemini 2.5 Flash-Lite** and deployed entirely on
**Firebase** (Hosting + Cloud Functions).

> **Live:** https://masker-ganit.web.app

### Why OCR-anchored

A vision LLM is great at *reading and understanding* a document but unreliable at
*precise pixel geometry* — its bounding boxes drift between runs, which can leave
a field partly exposed. So Masker splits the job by strength:

- **Google Vision OCR** returns the **exact pixel box** of every word — deterministic.
- **Gemini 2.5 Flash-Lite** reads the word list (text only) and decides **which**
  words are PII — no coordinates, nothing to drift.
- We black out the OCR box of each flagged word → **pixel-perfect, every time.**

---

## What it does

- Accepts **images** (JPG, PNG) and **PDFs** (single or multi-page).
- Detects names, addresses, phone numbers, emails, dates of birth, MRNs /
  patient IDs, national IDs (Aadhaar / SSN), insurance / policy numbers,
  signatures, and other identifying text.
- Paints solid **black boxes** over each detected item — on every page, at every
  spot on a page.
- Returns the redacted file in the **same format** it received (PDF in → PDF out,
  image in → image out).
- Shows the **original and redacted** side by side in the browser, plus a report
  of what was removed.

---

## Architecture

```
                          Browser (Firebase Hosting)
        ┌──────────────────────────────────────────────────────┐
        │  index.html / styles.css / app.js                    │
        │  • drag-drop upload                                   │
        │  • side-by-side original vs redacted preview         │
        │  • download button + "what was redacted" report      │
        └───────────────────────────┬──────────────────────────┘
                                     │  POST /redact  (multipart file)
                                     ▼
                    Cloud Function for Firebase (Node 20)
        ┌──────────────────────────────────────────────────────┐
        │  functions/index.js                                  │
        │                                                      │
        │  1. Parse upload (busboy)                            │
        │  2. PDF? render each page → PNG (pdfjs-dist + canvas)│
        │  3. Vision OCR → every word + exact pixel box        │
        │  4. Gemini → which word indices are PII (text only)  │
        │  5. Draw black rectangles over those OCR boxes       │
        │  6. Re-assemble (pdf-lib for PDF) → return file      │
        │       + X-Masker-Report header (summary JSON)        │
        └──────────────┬───────────────────────┬───────────────┘
                       │  HTTPS                 │  HTTPS
                       ▼                        ▼
            Google Vision API          Google Gemini API
          (documentTextDetection)    (gemini-2.5-flash-lite)
```

### Why this shape

- **Frontend is static** → lives on Firebase Hosting (could also be GitHub Pages).
- **The AI key must stay server-side** → it lives in the Cloud Function as a
  Firebase secret, never shipped to the browser.
- **Coordinates come from the model.** Gemini returns each PII item's bounding box
  in a normalised `[ymin, xmin, ymax, xmax]` system (0–1000). We scale those to
  the page's pixel size and fill black rectangles — which is how multi-page and
  multi-spot redaction "just works".

### Project layout

```
Masker by Ganit/
├── firebase.json          Firebase config: Hosting + /redact rewrite to function
├── .firebaserc            Firebase project (masker-ganit)
├── README.md              this file
├── ganit-logo.png         brand logo (theme colours sampled from it)
│
├── public/                ← Firebase Hosting (the website)
│   ├── index.html         UI: upload, dual preview, download, report
│   ├── styles.css         Ganit brand theme (#1A00D9 blue, #FE6E06 orange, Poppins)
│   ├── app.js             upload → call /redact → render results
│   └── ganit-logo.png
│
├── functions/             ← Cloud Function (the /redact API)
│   ├── index.js           detect (Gemini) + redact (canvas) + re-assemble
│   └── package.json       deps: @google/generative-ai, pdfjs-dist, canvas, pdf-lib
│
└── sample-data/           ← synthetic test documents (fake PII, safe to use)
    ├── generate-samples.js    regenerates the samples
    ├── test-redact.js         standalone end-to-end test (no Firebase needed)
    ├── discharge-summary.png  1-page medical image with fake PII
    ├── lab-report.pdf         2-page medical PDF with fake PII
    └── expected-pii.json      the fake PII the samples contain (for checking)
```

---

## The API

A single endpoint. It is a real, reusable API — any app can call it, not just this UI.

### `POST /redact`

| | |
|---|---|
| **Body** | `multipart/form-data`, field `file` = an image or PDF (max 25 MB) |
| **Returns** | the redacted file (`image/png` or `application/pdf`) as the body |
| **Header** `X-Masker-Report` | JSON summary: pages, count, and masked previews of what was redacted |
| **Header** `Content-Disposition` | suggested download filename (`redacted-<name>`) |

Example:

```bash
curl -X POST https://<your-host>/redact \
  -F "file=@discharge-summary.png" \
  -D headers.txt \
  -o redacted.png
# headers.txt contains the X-Masker-Report summary
```

The report never includes full PII — values are masked (e.g. `R*********a`).

---

## Running it

### Prerequisites

- Node.js 20+
- A **Gemini API key** — free from [Google AI Studio](https://aistudio.google.com/apikey)
- Firebase CLI (`npm i -g firebase-tools`) for deploy

### 1. Quick local test (no Firebase, no billing)

The fastest way to confirm the whole pipeline works end-to-end:

```powershell
cd functions
npm install
$env:GEMINI_API_KEY = "YOUR_KEY"
$env:SAMPLE_DIR = "..\sample-data"
node ..\sample-data\test-redact.js
```

This runs the **same detect→redact logic** as the Cloud Function against the
sample documents and writes `OUT-discharge-redacted.png` and
`OUT-lab-report-redacted.pdf` into `sample-data/` for you to inspect.

### 2. Run on Firebase emulator (full app, locally)

```powershell
# store the key as a secret the function can read
firebase functions:secrets:set GEMINI_API_KEY
firebase emulators:start --only functions,hosting
```

Then open the Hosting URL the emulator prints (usually http://localhost:5000).

### 3. Deploy to Firebase

```powershell
firebase functions:secrets:set GEMINI_API_KEY   # one time
firebase deploy
```

> **Note:** Outbound calls to the Gemini API require the Firebase **Blaze**
> (pay-as-you-go) plan. Blaze still includes the free-tier quotas, so for
> personal / low volume you typically pay $0 or pennies.

---

## Cost

| Component | Price | Per page |
|---|---|---|
| **Google Vision OCR** (`DOCUMENT_TEXT_DETECTION`) | $1.50 / 1,000 pages, **first 1,000/month free** | $0.0015 |
| **Gemini 2.5 Flash-Lite** (text only) | $0.10 / $0.40 per 1M tokens | ~$0.0003 |
| **Total** | | **~$0.0018 / page** |

| Pages | Approx. cost |
|------:|-------------|
| First 1,000 / month | **$0** (free OCR tier) + pennies |
| 1,000 | ~$1.80 |
| 10,000 | ~$18 |
| 100,000 | ~$180 |

Still tiny — under $2 per 1,000 pages, and the first 1,000 pages every month are
free. In exchange you get redaction that doesn't leak (pixel-accurate boxes).

---

## Testing & sample data

> **Never test with real patient data.** Use synthetic documents only.

This repo ships **synthetic** medical documents (all names, IDs, and addresses
are invented) so you can verify the tool safely and immediately:

- `sample-data/discharge-summary.png` — a 1-page discharge summary
- `sample-data/lab-report.pdf` — a 2-page lab report
- `sample-data/expected-pii.json` — the exact fake PII those files contain

Regenerate them anytime with `node sample-data/generate-samples.js`.

### Where to get more synthetic medical test data

If you want larger or more varied test sets (all synthetic / safe):

| Source | What it gives you |
|---|---|
| **[Synthea](https://github.com/synthetichealth/synthea)** | Open-source synthetic patient generator — realistic but entirely fake medical records, can render to PDF |
| **[Python Faker](https://faker.readthedocs.io/)** | Generate fake names, addresses, IDs, emails to build your own templated documents |
| **[Microsoft Presidio research data](https://github.com/microsoft/presidio-research)** | Synthetic PII datasets used for benchmarking detection |
| **[PII Tools examples](https://pii-tools.com/pii-examples/)** | Free downloadable files with labelled (fake) PII examples |
| **[Medical De-ID synthetic DICOM](https://arxiv.org/pdf/2508.01889)** | Synthetic DICOM imaging data for de-identification validation |

Avoid public "real" medical record images — using genuine PHI for testing is a
privacy and compliance risk.

---

## Tuning the redaction

- **Box coverage:** `redactPage()` in `functions/index.js` adds padding (`padX`,
  `padY`) around each detected box so ink fully covers the glyphs even when the
  model's box is slightly tight. Increase if you ever see characters peeking out.
- **PDF sharpness:** `PDF_RENDER_SCALE` (default `2.0`) controls render
  resolution. Higher = crisper output, slightly more cost/time.
- **Model:** swap `MODEL` to `gemini-3.1-flash-lite` for higher accuracy on
  tricky names (smarter, ~3× the still-tiny cost).
- **What counts as PII:** edit `PII_PROMPT` to add or remove categories.

---

## Security notes

- The Gemini API key is stored as a **Firebase secret** and only read inside the
  Cloud Function — it is never exposed to the browser.
- Uploaded files are processed in memory and not persisted by default.
- For real PHI workloads, review Google's data-handling terms and your own
  compliance requirements (HIPAA, etc.) before going to production.

---

## Built by

**Ganit — data speaks.** Theme colours and styling are taken directly from the
Ganit logo (`#1A00D9` blue, `#FE6E06` orange, Poppins typeface).
