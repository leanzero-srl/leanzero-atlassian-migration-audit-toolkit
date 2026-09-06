const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };

const STATUS_FILLS = {
  OK:                    { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } }, // emerald-100
  OK_EMPTY:              { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } }, // slate-100
  MISSING:               { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } }, // amber-100
  PROJECT_NOT_IN_CLOUD:  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } }, // red-200
  NO_PERMISSION_CLOUD:   { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } },
  FAILED:                { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCA5A5" } }, // red-300
};

// Excel forbids these in sheet names: : \ / ? * [ ]
function sanitizeSheetName(name) {
  return String(name).replace(/[:\\/\?\*\[\]]/g, "_").substring(0, 31);
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle" };
  });
}

function autosize(sheet, padding = 2) {
  sheet.columns.forEach((col) => {
    let max = col.header ? String(col.header).length : 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + padding, 80);
  });
}

// projectStats: [{ projectKey, dcCount, cloudCount, missing[], status, note }]
async function writeWorkbook(projectStats, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = "find_missing_issues";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Project", key: "project", width: 14 },
    { header: "DC count", key: "dc", width: 12 },
    { header: "Cloud count", key: "cloud", width: 14 },
    { header: "Missing", key: "missing", width: 12 },
    { header: "Status", key: "status", width: 22 },
    { header: "Notes", key: "note", width: 60 },
  ];
  styleHeader(summary.getRow(1));
  summary.views = [{ state: "frozen", ySplit: 1 }];
  summary.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  for (const p of projectStats) {
    const row = summary.addRow({
      project: p.projectKey,
      dc: p.dcCount,
      cloud: p.cloudCount,
      missing: p.missing.length,
      status: p.status || "",
      note: p.note || "",
    });
    const fill = STATUS_FILLS[p.status];
    if (fill) row.eachCell((cell) => (cell.fill = fill));
  }

  const usedSheetNames = new Set(["Summary"]);
  for (const p of projectStats) {
    if (p.missing.length === 0) continue;
    let name = sanitizeSheetName(p.projectKey);
    let suffix = 1;
    while (usedSheetNames.has(name)) {
      name = sanitizeSheetName(`${p.projectKey}_${++suffix}`);
    }
    usedSheetNames.add(name);

    const sheet = wb.addWorksheet(name);
    sheet.columns = [
      { header: "Work Item", key: "key", width: 16 },
      { header: "Summary", key: "summary", width: 60 },
      { header: "Work type", key: "type", width: 16 },
      { header: "Status", key: "status", width: 18 },
      { header: "Has Comments", key: "hasComments", width: 14 },
      { header: "Has Attachments", key: "hasAttachments", width: 16 },
    ];
    styleHeader(sheet.getRow(1));
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
    for (const row of p.missing) {
      sheet.addRow({
        key: row.key,
        summary: row.summary,
        type: row.type,
        status: row.status,
        hasComments: row.hasComments ? "Yes" : "No",
        hasAttachments: row.hasAttachments ? "Yes" : "No",
      });
    }
    autosize(sheet);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").substring(0, 19);
  const outFile = path.join(outDir, `missing_issues_${ts}.xlsx`);
  await wb.xlsx.writeFile(outFile);
  return outFile;
}

module.exports = { writeWorkbook };
