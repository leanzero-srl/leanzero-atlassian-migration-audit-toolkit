#!/usr/bin/env node
// Independent validation of the corrected missing-issues report.
// Reads the report's per-project tabs (the actual deliverable) and proves each
// listed key is genuinely a pre-migration DC issue that is absent from Cloud.
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const JiraCloudClient = require("../src/jiraCloudClient");
const JiraDcClient = require("../src/jiraDcClient");

const CUTOFF = "2026-05-11";
const outDir = path.join(__dirname, "..", "reports");
const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const dc = new JiraDcClient(process.env.DC_BASE_URL, { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD });
const enc = encodeURIComponent;

function latestReport() {
  const f = fs.readdirSync(outDir).filter((x) => /^missing_issues_2026-06-17.*\.xlsx$/.test(x) && !x.startsWith("~$")).sort();
  return path.join(outDir, f[f.length - 1]);
}

async function cloudKeysIn(keys) {
  // exact key resolution (alias-aware). returns set of OLD keys that resolve.
  const present = new Set();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const inList = batch.map((k) => `"${k}"`).join(",");
    let token = null;
    const resolvedCurrent = [];
    while (true) {
      let p = `/rest/api/3/search/jql?jql=${enc(`key in (${inList})`)}&fields=summary&maxResults=100`;
      if (token) p += `&nextPageToken=${enc(token)}`;
      const r = await cloud.makeRequest(p);
      for (const x of (r.issues || [])) resolvedCurrent.push(x.key);
      if (r.isLast === true || !r.nextPageToken || (r.issues || []).length === 0) break;
      token = r.nextPageToken;
    }
    // preserved keys map 1:1; movers won't equal an old key. We only need a count + preserved set.
    for (const ck of resolvedCurrent) if (batch.includes(ck)) present.add(ck);
    // record count of movers via single re-query for any shortfall
    const moversCount = resolvedCurrent.length - resolvedCurrent.filter((ck) => batch.includes(ck)).length;
    if (moversCount > 0) {
      for (const k of batch) {
        if (present.has(k)) continue;
        const r = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`key in ("${k}")`)}&fields=summary&maxResults=1`);
        if ((r.issues || []).length) present.add(k);
      }
    }
  }
  return present;
}

async function cloudLabelsIn(keys) {
  const present = new Set();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const inList = batch.map((k) => `"${k}"`).join(",");
    const r = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`labels in (${inList})`)}&fields=labels&maxResults=100`);
    for (const iss of (r.issues || [])) for (const lb of (iss.fields?.labels || [])) if (batch.includes(lb)) present.add(lb);
  }
  return present;
}

async function dcExists(keys) {
  // returns Map<key, createdDate> for keys present in DC
  const m = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const inList = batch.map((k) => `"${k}"`).join(",");
    const r = await dc.makeRequest(`/rest/api/2/search?jql=${enc(`key in (${inList})`)}&fields=created&maxResults=100`);
    for (const iss of (r.issues || [])) m.set(iss.key, (iss.fields.created || "").slice(0, 10));
  }
  return m;
}

(async () => {
  const reportPath = latestReport();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(reportPath);
  console.log(`Validating report: ${path.basename(reportPath)}\n`);

  // Gather missing keys per project from the per-project tabs.
  const perProject = {};
  wb.eachSheet((ws) => {
    if (ws.name === "Summary") return;
    const keys = [];
    ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value) keys.push(String(row.getCell(1).value)); });
    if (keys.length) perProject[ws.name] = keys;
  });
  const allKeys = Object.values(perProject).flat();
  console.log(`Report lists ${allKeys.length} missing keys across ${Object.keys(perProject).length} project tabs.`);
  const dupes = allKeys.length - new Set(allKeys).size;
  console.log(`Duplicate keys in report: ${dupes}\n`);

  // (A) DC existence + created < cutoff
  const dcMap = await dcExists(allKeys);
  const dcMissingFromDc = allKeys.filter((k) => !dcMap.has(k));
  const afterCutoff = [...dcMap.entries()].filter(([, d]) => d >= CUTOFF).map(([k]) => k);
  const dates = [...dcMap.values()].sort();
  console.log(`(A) DC existence: ${dcMap.size}/${allKeys.length} exist in DC. Not-in-DC: ${dcMissingFromDc.length}. Created after cutoff: ${afterCutoff.length}.`);
  console.log(`    DC created range: ${dates[0]} .. ${dates[dates.length - 1]}`);
  if (dcMissingFromDc.length) console.log(`    !! keys not found in DC: ${dcMissingFromDc.slice(0, 10).join(", ")}`);
  if (afterCutoff.length) console.log(`    !! keys created after cutoff: ${afterCutoff.slice(0, 10).join(", ")}`);

  // (B) Cloud exact key resolution — expect ZERO resolve
  const cloudPresent = await cloudKeysIn(allKeys);
  console.log(`\n(B) Cloud exact key resolution: ${cloudPresent.size}/${allKeys.length} resolve in Cloud (expect 0).`);
  if (cloudPresent.size) console.log(`    !! resolve in cloud: ${[...cloudPresent].slice(0, 15).join(", ")}`);

  // (C) Cloud label backfill — expect ZERO
  const labelPresent = await cloudLabelsIn(allKeys);
  console.log(`\n(C) Cloud label-backfill: ${labelPresent.size}/${allKeys.length} present as labels (expect 0).`);
  if (labelPresent.size) console.log(`    !! present as label: ${[...labelPresent].slice(0, 15).join(", ")}`);

  // (D) Re-confirm the removed-as-present keys actually resolve
  const removedFile = path.join(outDir, "present_under_other_key.json");
  if (fs.existsSync(removedFile)) {
    const removed = JSON.parse(fs.readFileSync(removedFile, "utf8"));
    const removedKeys = removed.map((r) => r.oldKey);
    const reResolve = await cloudKeysIn(removedKeys);
    console.log(`\n(D) Re-confirm ${removedKeys.length} removed (moved/re-keyed) keys resolve in Cloud: ${reResolve.size}/${removedKeys.length} (expect all).`);
    const notResolved = removedKeys.filter((k) => !reResolve.has(k));
    if (notResolved.length) console.log(`    !! removed but did NOT resolve: ${notResolved.join(", ")}`);
  }

  const valid = dcMissingFromDc.length === 0 && afterCutoff.length === 0 && cloudPresent.size === 0 && labelPresent.size === 0 && dupes === 0;
  console.log(`\n=== VERDICT: ${valid ? "VALID — every listed key is a pre-migration DC issue absent from Cloud" : "DISCREPANCIES FOUND (see !! above)"} ===`);
  console.log(`FINAL TRULY-MISSING: ${allKeys.length}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
