#!/usr/bin/env node
/**
 * DC -> Cloud custom-field mapping report (audit which DC fields exist on Cloud).
 *
 * Matches DC custom fields to Cloud custom fields BY NAME and writes:
 *   - "DC to Cloud Field Map"  : every DC field that has a Cloud counterpart
 *   - "DC Fields NOT on Cloud"  : DC fields with no matching Cloud field (+ reason)
 *
 * IMPORTANT lesson baked in: the Cloud custom-field list MUST come from
 * GET /rest/api/3/field/search?type=custom (paginated). Plain GET /rest/api/3/field
 * is INCOMPLETE on some tenants (it omitted Vendor / Support Area / Support Category
 * on a sandbox tenant), which produces false "not on Cloud" rows.
 *
 * Output: an .xlsx if a sibling exceljs is resolvable, plus .csv files always
 * (so it works with zero install). Files land in ./out/.
 *
 * Env (.env or shell):
 *   DC_BASE_URL, DC_USERNAME, DC_PASSWORD   Data Center (Basic auth)
 *   CLOUD_BASE_URL                          e.g. https://site.atlassian.net
 *   CLOUD_API_TOKEN                         base64("email:api_token")
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
try {
  require("dotenv").config({ path: path.resolve(__dirname, ".env") });
} catch (_) {
  /* dotenv optional */
}
const E = process.env;

function req(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    lib
      .request(
        u,
        { method: "GET", headers: { Accept: "application/json", ...headers } },
        (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () => {
            if (res.statusCode >= 400)
              return reject(new Error(`HTTP ${res.statusCode} ${urlStr}: ${s.slice(0, 200)}`));
            try {
              resolve(JSON.parse(s));
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject)
      .end();
  });
}

function basic(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}
// CLOUD_API_TOKEN is already base64("email:token") → used directly as Basic.
function cloudAuth() {
  return "Basic " + E.CLOUD_API_TOKEN;
}

async function dcFields() {
  return req(`${E.DC_BASE_URL.replace(/\/$/, "")}/rest/api/2/field`, {
    Authorization: basic(E.DC_USERNAME, E.DC_PASSWORD),
  });
}
async function cloudCustomFields() {
  const base = E.CLOUD_BASE_URL.replace(/\/$/, "");
  const all = [];
  let startAt = 0;
  for (;;) {
    const j = await req(
      `${base}/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=100&expand=key`,
      { Authorization: cloudAuth() },
    );
    all.push(...(j.values || []));
    if (j.isLast || (j.values || []).length === 0) break;
    startAt += j.values.length;
  }
  return all;
}

const norm = (s) => String(s || "").trim().toLowerCase();
const stripMig = (s) => norm(s).replace(/\s*\(migrated\)\s*$/, "");
const fType = (f) =>
  (f.schema && (f.schema.custom || f.schema.type)) || (f.custom ? "custom" : "system");

function csv(rows, cols) {
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  return [cols.map((c) => esc(c.header)).join(",")]
    .concat(rows.map((r) => cols.map((c) => esc(r[c.key])).join(",")))
    .join("\n");
}

function resolveExcelJS() {
  const candidates = [
    "exceljs",
    "../migrate_jsu_rules_dc_to_cloud/node_modules/exceljs",
    "../find_missing_issues/node_modules/exceljs",
    "../../../confluence/responsibility-to-aura/node_modules/exceljs",
  ];
  for (const c of candidates) {
    try {
      return require(c.startsWith(".") ? path.resolve(__dirname, c) : c);
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

(async () => {
  for (const k of ["DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD", "CLOUD_BASE_URL", "CLOUD_API_TOKEN"])
    if (!E[k]) throw new Error(`Missing env ${k}`);

  console.log(`Fetching DC fields from ${E.DC_BASE_URL} ...`);
  const dc = (await dcFields()).filter((f) => f.custom);
  console.log(`  ${dc.length} DC custom fields`);
  console.log(`Fetching Cloud custom fields from ${E.CLOUD_BASE_URL} (/field/search) ...`);
  const cloud = await cloudCustomFields();
  console.log(`  ${cloud.length} Cloud custom fields`);

  const byName = new Map();
  for (const f of cloud) {
    const k = norm(f.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }

  const mapped = [];
  const unmapped = [];
  for (const d of dc) {
    let m = byName.get(norm(d.name));
    let how = "exact name";
    if (!m) {
      const t = stripMig(d.name);
      for (const [k, arr] of byName)
        if (stripMig(k) === t) {
          m = arr;
          how = "name (ignoring (migrated))";
          break;
        }
    }
    if (m && m.length)
      mapped.push({
        dcName: d.name, dcId: d.id, dcType: fType(d),
        cloudName: m[0].name, cloudId: m[0].id, cloudType: fType(m[0]),
        how, note: m.length > 1 ? `${m.length} cloud fields share this name` : "",
      });
    else unmapped.push({ dcName: d.name, dcId: d.id, dcType: fType(d), reason: "No Cloud custom field with a matching name" });
  }
  mapped.sort((a, b) => a.dcName.localeCompare(b.dcName));
  unmapped.sort((a, b) => a.dcName.localeCompare(b.dcName));

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = (E.STAMP || "report").replace(/[^a-z0-9_-]/gi, "_");

  const mappedCols = [
    { header: "DC Field Name", key: "dcName" }, { header: "DC Field ID", key: "dcId" },
    { header: "DC Type", key: "dcType" }, { header: "Cloud Field Name", key: "cloudName" },
    { header: "Cloud Field ID", key: "cloudId" }, { header: "Cloud Type", key: "cloudType" },
    { header: "Matched By", key: "how" }, { header: "Note", key: "note" },
  ];
  const unmappedCols = [
    { header: "DC Field Name", key: "dcName" }, { header: "DC Field ID", key: "dcId" },
    { header: "DC Type", key: "dcType" }, { header: "Reason", key: "reason" },
  ];

  fs.writeFileSync(path.join(outDir, `dc_to_cloud_field_map_${stamp}.csv`), csv(mapped, mappedCols));
  fs.writeFileSync(path.join(outDir, `dc_fields_not_on_cloud_${stamp}.csv`), csv(unmapped, unmappedCols));

  const ExcelJS = resolveExcelJS();
  if (ExcelJS) {
    const wb = new ExcelJS.Workbook();
    const sheet = (name, cols, rows) => {
      const ws = wb.addWorksheet(name);
      ws.columns = cols.map((c) => ({ ...c, width: Math.max(18, c.header.length + 4) }));
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
      rows.forEach((r) => ws.addRow(r));
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    };
    sheet("DC to Cloud Field Map", mappedCols, mapped);
    sheet("DC Fields NOT on Cloud", unmappedCols, unmapped);
    const xlsx = path.join(outDir, `dc_cloud_field_report_${stamp}.xlsx`);
    await wb.xlsx.writeFile(xlsx);
    console.log(`\nWrote ${xlsx}`);
  } else {
    console.log("\n(exceljs not found — wrote CSVs only)");
  }
  console.log(`  mapped=${mapped.length}  not-on-cloud=${unmapped.length}  -> ${outDir}/`);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
