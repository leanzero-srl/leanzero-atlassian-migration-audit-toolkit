#!/usr/bin/env node
// Validate the generated import CSVs for structural + hierarchy integrity, and
// re-confirm every external Parent key actually exists in Cloud.
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const JiraCloudClient = require("../src/jiraCloudClient");

const csvDir = path.join(__dirname, "..", "reports", "import_csvs");
const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const enc = encodeURIComponent;

// minimal RFC4180 CSV parser
function parseCsv(text) {
  const rows = []; let row = [], field = "", inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; } else field += c; }
    else if (c === '"') inq = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

(async () => {
  const files = fs.readdirSync(csvDir).filter((f) => f.endsWith(".csv")).sort();
  let totalRows = 0, problems = 0;
  const externalParentKeys = new Set();
  const allDcKeys = new Set();

  for (const file of files) {
    const text = fs.readFileSync(path.join(csvDir, file), "utf8");
    const rows = parseCsv(text);
    const header = rows[0];
    const body = rows.slice(1);
    totalRows += body.length;

    const idx = (name) => header.indexOf(name);
    const iId = idx("Issue ID"), iType = idx("Issue Type"), iSum = idx("Summary"), iParent = idx("Parent");
    const labelCols = header.map((h, j) => (h === "Labels" ? j : -1)).filter((j) => j >= 0);

    // column consistency
    const badWidth = body.filter((r) => r.length !== header.length);
    if (badWidth.length) { console.log(`!! ${file}: ${badWidth.length} rows with wrong column count (header=${header.length})`); problems += badWidth.length; }

    // unique Issue IDs
    const ids = new Set(); let dupId = 0;
    for (const r of body) { const v = r[iId]; if (ids.has(v)) dupId++; ids.add(v); }
    if (dupId) { console.log(`!! ${file}: ${dupId} duplicate Issue IDs`); problems += dupId; }

    // collect DC keys (first label) and validate
    for (const r of body) {
      const firstLabel = r[labelCols[0]];
      if (firstLabel) allDcKeys.add(firstLabel);
    }

    // parent integrity
    let subNoParent = 0, parentBadRef = 0;
    const subtaskTypes = /sub-?task/i;
    for (const r of body) {
      const type = r[iType]; const parent = r[iParent];
      const isSub = subtaskTypes.test(type);
      if (isSub && !parent) { subNoParent++; continue; }
      if (!parent) continue;
      if (/^\d+$/.test(parent)) {
        // in-file Issue ID reference -> must exist in this file
        if (!ids.has(parent)) { parentBadRef++; console.log(`   !! ${file}: row Issue ID ${r[iId]} Parent=${parent} not found in file`); }
      } else {
        externalParentKeys.add(parent); // Cloud key -> verify later
      }
    }
    if (subNoParent) { console.log(`!! ${file}: ${subNoParent} sub-tasks with NO Parent`); problems += subNoParent; }
    problems += parentBadRef;

    // header sanity
    if (iId < 0 || iType < 0 || iSum < 0 || iParent < 0 || labelCols.length === 0) { console.log(`!! ${file}: missing required header column`); problems++; }
  }

  console.log(`\nFiles: ${files.length}  Rows (excl headers): ${totalRows}  DC-key labels: ${allDcKeys.size}`);
  console.log(`Distinct external (Cloud-key) Parent references: ${externalParentKeys.size}`);

  // verify external parent keys exist in cloud
  const refs = [...externalParentKeys]; const missing = [];
  for (let i = 0; i < refs.length; i += 100) {
    const batch = refs.slice(i, i + 100);
    const r = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`key in (${batch.map((k) => `"${k}"`).join(",")})`)}&fields=summary&maxResults=100`);
    const found = new Set((r.issues || []).map((x) => x.key));
    // a moved parent would resolve to a different current key; re-query singly if shortfall
    for (const k of batch) if (!found.has(k)) {
      const r1 = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`key in ("${k}")`)}&fields=summary&maxResults=1`);
      if (!(r1.issues || []).length) missing.push(k);
    }
  }
  console.log(`External Parent keys confirmed in Cloud: ${refs.length - missing.length}/${refs.length}`);
  if (missing.length) { console.log(`!! Parent keys NOT in Cloud: ${missing.join(", ")}`); problems += missing.length; }

  console.log(`\n=== ${problems === 0 ? "ALL CSVs VALID — structure + hierarchy intact, every parent resolvable" : problems + " PROBLEM(S) FOUND"} ===`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
