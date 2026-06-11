/**
 * Generates synthetic medical documents with FAKE PII for testing Masker.
 * All names / IDs / addresses below are invented - no real patient data.
 *
 *   node generate-samples.js
 *
 * Produces:
 *   sample-data/discharge-summary.png   (single page image)
 *   sample-data/lab-report.pdf          (two-page PDF)
 */
const fs = require("fs");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const OUT = __dirname;
const BLUE = "#1A00D9";
const INK = "#16142b";
const GREY = "#535353";

// Fake PII used across the documents - keep a list so we can self-check later.
const PII = {
  patient: "Rohan Mehta",
  dob: "14/03/1987",
  mrn: "MRN-558213",
  aadhaar: "4729 8841 2096",
  phone: "+91 98201 55432",
  email: "rohan.mehta@example.com",
  address: "27 Marine Lines, Mumbai 400020",
  doctor: "Dr. Anita Kulkarni",
  policy: "INS-PL-7741209",
};

function drawDischargeImage() {
  const W = 1000, H = 1300;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);

  // header band
  ctx.fillStyle = BLUE; ctx.fillRect(0, 0, W, 90);
  ctx.fillStyle = "#fff"; ctx.font = "bold 34px Arial";
  ctx.fillText("City Care Hospital", 40, 58);
  ctx.font = "16px Arial"; ctx.fillText("Discharge Summary", 40, 80);

  ctx.fillStyle = INK; ctx.font = "20px Arial";
  let y = 150;
  const line = (label, val, isPII) => {
    ctx.fillStyle = GREY; ctx.font = "16px Arial";
    ctx.fillText(label, 40, y);
    ctx.fillStyle = isPII ? "#000" : INK; ctx.font = "20px Arial";
    ctx.fillText(val, 300, y);
    y += 46;
  };
  line("Patient Name:", PII.patient, true);
  line("Date of Birth:", PII.dob, true);
  line("Medical Record No:", PII.mrn, true);
  line("Aadhaar Number:", PII.aadhaar, true);
  line("Phone:", PII.phone, true);
  line("Email:", PII.email, true);
  line("Address:", PII.address, true);
  line("Attending Doctor:", PII.doctor, true);
  line("Insurance Policy:", PII.policy, true);

  y += 20;
  ctx.fillStyle = INK; ctx.font = "bold 20px Arial";
  ctx.fillText("Clinical Notes", 40, y); y += 36;
  ctx.font = "17px Arial"; ctx.fillStyle = GREY;
  const notes = [
    "Patient admitted with acute abdominal pain. Vitals stable on admission.",
    "Diagnosis: Acute appendicitis. Laparoscopic appendectomy performed.",
    "Recovery uneventful. Advised rest for 7 days and follow-up review.",
    "Medication: Amoxicillin 500mg, Paracetamol 650mg as needed.",
  ];
  notes.forEach((t) => { ctx.fillText(t, 40, y); y += 30; });

  y += 50;
  ctx.fillStyle = GREY; ctx.font = "16px Arial";
  ctx.fillText("Signature:", 40, y);
  ctx.fillStyle = "#000"; ctx.font = "italic 26px Arial";
  ctx.fillText(PII.doctor, 160, y + 4);

  fs.writeFileSync(path.join(OUT, "discharge-summary.png"), c.toBuffer("image/png"));
  console.log("Wrote discharge-summary.png");
}

async function drawLabReportPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.102, 0, 0.851);
  const ink = rgb(0.086, 0.078, 0.169);
  const grey = rgb(0.325, 0.325, 0.325);

  const mkPage = (title, rows, body) => {
    const page = doc.addPage([595, 842]); // A4
    page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: blue });
    page.drawText("MetroLab Diagnostics", { x: 40, y: 808, size: 22, font: bold, color: rgb(1, 1, 1) });
    page.drawText(title, { x: 40, y: 792, size: 11, font, color: rgb(1, 1, 1) });
    let yy = 740;
    rows.forEach(([label, val]) => {
      page.drawText(label, { x: 40, y: yy, size: 10, font, color: grey });
      page.drawText(val, { x: 200, y: yy, size: 12, font: bold, color: ink });
      yy -= 28;
    });
    yy -= 14;
    body.forEach((t) => { page.drawText(t, { x: 40, y: yy, size: 11, font, color: ink }); yy -= 22; });
  };

  mkPage("Laboratory Report - Page 1", [
    ["Patient Name:", PII.patient],
    ["Date of Birth:", PII.dob],
    ["Patient ID:", PII.mrn],
    ["Phone:", PII.phone],
    ["Email:", PII.email],
    ["Referring Doctor:", PII.doctor],
  ], [
    "Complete Blood Count (CBC)",
    "Hemoglobin: 13.8 g/dL   (Normal)",
    "WBC: 7,200 /uL          (Normal)",
    "Platelets: 250,000 /uL  (Normal)",
  ]);

  mkPage("Laboratory Report - Page 2", [
    ["Patient Name:", PII.patient],
    ["Aadhaar Number:", PII.aadhaar],
    ["Address:", PII.address],
    ["Insurance Policy:", PII.policy],
  ], [
    "Lipid Profile",
    "Total Cholesterol: 185 mg/dL   (Normal)",
    "LDL: 110 mg/dL                 (Borderline)",
    "Report verified by " + PII.doctor,
  ]);

  fs.writeFileSync(path.join(OUT, "lab-report.pdf"), await doc.save());
  console.log("Wrote lab-report.pdf");
}

(async () => {
  drawDischargeImage();
  await drawLabReportPdf();
  fs.writeFileSync(path.join(OUT, "expected-pii.json"), JSON.stringify(PII, null, 2));
  console.log("Wrote expected-pii.json (the fake PII these docs contain)");
})();
