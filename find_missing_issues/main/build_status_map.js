#!/usr/bin/env node
// Build reports/_status_map.json: per-project { lowercased DC status -> exact Cloud
// status name }, so generate_import_csvs.js can write the Status column in the precise
// spelling each project's workflow expects. The CSV importer matches status by exact
// name; DC uses Title Case ("Under Investigation") while Cloud often uses sentence case
// ("Under investigation"), which silently breaks the auto-map and fails the row.
//
// Read-only against Cloud. Flags any DC status with NO match in the project workflow
// (those genuinely need a human decision / new status — none as of 2026-06-22).
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const JiraCloudClient = require("../src/jiraCloudClient");

const outDir = path.join(__dirname, "..", "reports");
const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const { data } = JSON.parse(fs.readFileSync(path.join(outDir, "_missing_data.json"), "utf8"));

(async () => {
  const projects = [...new Set(Object.keys(data).map((k) => data[k].project))].sort();
  const byProject = {};
  for (const p of projects) {
    try {
      const r = await cloud.makeRequest(`/rest/api/3/project/${p}/statuses`);
      const m = {};
      for (const t of r) for (const s of t.statuses) m[s.name.toLowerCase()] = s.name; // union across issue types
      byProject[p] = m;
    } catch (e) {
      byProject[p] = null;
      console.log(`  ${p}: statuses ERR ${e.statusCode || e.message}`);
    }
  }

  // report what will change / what can't be matched
  const unmatched = {};
  let changed = 0, total = 0;
  for (const k of Object.keys(data)) {
    const d = data[k]; const m = byProject[d.project]; if (!m) continue; total++;
    const canon = m[(d.status || "").toLowerCase()];
    if (!canon) { const kk = `${d.project} :: ${d.status}`; unmatched[kk] = (unmatched[kk] || 0) + 1; continue; }
    if (canon !== d.status) changed++;
  }

  fs.writeFileSync(path.join(outDir, "_status_map.json"), JSON.stringify({ builtAt: new Date().toISOString(), base: process.env.CLOUD_BASE_URL, byProject }, null, 2));
  console.log(`Wrote _status_map.json for ${projects.length} project(s). Status cells to re-case on next generate: ${changed}/${total}.`);
  const u = Object.keys(unmatched).sort();
  if (u.length) {
    console.log(`!! ${u.length} DC status(es) have NO match in their project workflow — decide a target, then add it to the workflow or remap:`);
    for (const x of u) console.log(`   - ${x}  x${unmatched[x]}`);
    process.exit(1);
  }
  console.log("All DC statuses matched (case-normalised). No unresolved statuses.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
