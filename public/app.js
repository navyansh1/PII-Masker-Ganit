/* ===========================================================
   Masker by Ganit - frontend
   Uploads a file to the /redact Cloud Function, then shows the
   original and the redacted result side by side with a download.
   =========================================================== */

// When served by Firebase Hosting, the rewrite maps /redact to the function.
// For pure local testing against the emulator you can override this.
const REDACT_ENDPOINT = "/redact";

const els = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  browseBtn: document.getElementById("browseBtn"),
  redactBtn: document.getElementById("redactBtn"),
  fileName: document.getElementById("fileName"),
  statusCard: document.getElementById("statusCard"),
  statusText: document.getElementById("statusText"),
  results: document.getElementById("results"),
  summary: document.getElementById("summary"),
  downloadBtn: document.getElementById("downloadBtn"),
  originalViewer: document.getElementById("originalViewer"),
  redactedViewer: document.getElementById("redactedViewer"),
  reportCard: document.getElementById("reportCard"),
  reportList: document.getElementById("reportList"),
};

let selectedFile = null;
let downloadUrl = null;
let downloadName = "redacted";

/* ---------------- File selection ---------------- */
els.browseBtn.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("click", (e) => {
  if (e.target === els.browseBtn || e.target === els.redactBtn) return;
  els.fileInput.click();
});
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length) selectFile(els.fileInput.files[0]);
});

["dragenter", "dragover"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});

function selectFile(file) {
  selectedFile = file;
  els.fileName.textContent = file.name;
  els.redactBtn.classList.remove("hidden");
  els.results.classList.add("hidden");
}

/* ---------------- Redact ---------------- */
els.redactBtn.addEventListener("click", runRedaction);

async function runRedaction() {
  if (!selectedFile) return;

  els.redactBtn.disabled = true;
  els.statusCard.classList.remove("hidden");
  els.results.classList.add("hidden");
  els.statusText.textContent = "Finding personal information on every page…";

  // Show the original immediately while we wait.
  renderOriginal(selectedFile);

  try {
    const form = new FormData();
    form.append("file", selectedFile, selectedFile.name);

    const resp = await fetch(REDACT_ENDPOINT, { method: "POST", body: form });
    if (!resp.ok) {
      let msg = "Redaction failed.";
      try { msg = (await resp.json()).error || msg; } catch {}
      throw new Error(msg);
    }

    const report = safeParse(resp.headers.get("X-Masker-Report"));
    const blob = await resp.blob();

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    downloadName = filenameFromDisposition(resp.headers.get("Content-Disposition")) || "redacted-" + selectedFile.name;

    renderRedacted(blob);
    renderReport(report);

    els.statusCard.classList.add("hidden");
    els.results.classList.remove("hidden");
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    els.statusText.textContent = "⚠  " + err.message;
  } finally {
    els.redactBtn.disabled = false;
  }
}

/* ---------------- Rendering ---------------- */
function renderOriginal(file) {
  els.originalViewer.innerHTML = "";
  if (file.type === "application/pdf") {
    renderPdfInto(file, els.originalViewer);
  } else {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    els.originalViewer.appendChild(img);
  }
}

function renderRedacted(blob) {
  els.redactedViewer.innerHTML = "";
  if (blob.type === "application/pdf") {
    renderPdfInto(blob, els.redactedViewer);
  } else {
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    els.redactedViewer.appendChild(img);
  }
}

// Render a PDF (File or Blob) page-by-page into a container using pdf.js (CDN).
async function renderPdfInto(fileOrBlob, container) {
  const pdfjsLib = await loadPdfJs();
  const buf = await fileOrBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.3 });
    const label = document.createElement("p");
    label.className = "page-label";
    label.textContent = "Page " + i;
    container.appendChild(label);
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
}

let _pdfjs = null;
function loadPdfJs() {
  if (_pdfjs) return Promise.resolve(_pdfjs);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.min.mjs";
    s.type = "module";
    // pdf.js exposes itself as window.pdfjsLib for the non-module build; use the legacy UMD build instead.
    const umd = document.createElement("script");
    umd.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    umd.onload = () => {
      const lib = window["pdfjsLib"];
      lib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      _pdfjs = lib;
      resolve(lib);
    };
    umd.onerror = reject;
    document.head.appendChild(umd);
  });
}

function renderReport(report) {
  if (!report || !report.pages) {
    els.summary.innerHTML = "Done.";
    els.reportCard.classList.add("hidden");
    return;
  }
  const total = report.totalRedactions || 0;
  const pageCount = report.pages.length;
  els.summary.innerHTML =
    "<strong>" + total + "</strong> item" + (total === 1 ? "" : "s") +
    " redacted across <strong>" + pageCount + "</strong> page" + (pageCount === 1 ? "" : "s") + ".";

  els.reportList.innerHTML = "";
  let any = false;
  report.pages.forEach((pg) => {
    (pg.items || []).forEach((it) => {
      any = true;
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="type">' + escapeHtml(it.type) + "</span>" +
        '<span class="preview">' + escapeHtml(it.preview) + "</span>" +
        '<span class="where">Page ' + pg.page + "</span>";
      els.reportList.appendChild(li);
    });
  });
  els.reportCard.classList.toggle("hidden", !any);
}

/* ---------------- Download ---------------- */
els.downloadBtn.addEventListener("click", () => {
  if (!downloadUrl) return;
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = downloadName;
  a.click();
});

/* ---------------- helpers ---------------- */
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function filenameFromDisposition(d) {
  if (!d) return null;
  const m = /filename="?([^"]+)"?/.exec(d);
  return m ? m[1] : null;
}
