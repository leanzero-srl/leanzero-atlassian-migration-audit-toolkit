#!/usr/bin/env node
// Post-process the audit checkpoint: for every candidate-missing key, do an EXACT
// cloud key resolution (`key = "OLD"`). Jira resolves an issue's pre-move key via
// its move-alias, so a key that resolves means the issue IS in Cloud (preserved,
// moved to another project, or otherwise re-keyed) and is NOT truly missing.
// Rewrites a corrected workbook and records the resolved (present-elsewhere) keys.
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const JiraCloudClient = require("../src/jiraCloudClient");
const { writeWorkbook } = require("../src/excelWriter");

const outDir = path.join(__dirname, "..", "reports");
const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const enc = encodeURIComponent;

function loadCheckpoint() {
  const file = path.join(outDir, "audit_v2_checkpoint.jsonl");
  const seen = new Set(); const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (!seen.has(o.projectKey)) { seen.add(o.projectKey); rows.push(o); }
  }
  return rows;
}

// Resolve one key. Returns the current cloud key if it exists, else null.
async function resolveKey(oldKey) {
  const r = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`key in ("${oldKey}")`)}&fields=summary&maxResults=1`);
  const issues = r?.issues || [];
  return issues.length ? issues[0].key : null;
}

async function runPool(items, concurrency, worker) {
  let idx = 0;
  const next = async () => { while (idx < items.length) { const i = idx++; await worker(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

(async () => {
  const stats = loadCheckpoint();
  const resolvedElsewhere = []; // { project, oldKey, cloudKey }
  let checked = 0;

  for (const p of stats) {
    if (!p.missing || p.missing.length === 0) continue;
    const keep = [];
    await runPool(p.missing, 6, async (row) => {
      let cur = null;
      try { cur = await resolveKey(row.key); } catch (e) { cur = null; /* treat unresolved/errored as absent; logged below */ }
      checked++;
      if (cur) resolvedElsewhere.push({ project: p.projectKey, oldKey: row.key, cloudKey: cur });
      else keep.push(row);
    });
    // preserve original ordering of kept rows
    const keepKeys = new Set(keep.map((r) => r.key));
    p.missing = p.missing.filter((r) => keepKeys.has(r.key));
    const dropped = resolvedElsewhere.filter((r) => r.project === p.projectKey).length;
    if (dropped) {
      p.note = (p.note ? p.note + " | " : "") + `${dropped} present in Cloud under a different key (moved/re-keyed, alias-resolved) — not counted`;
      if (p.missing.length === 0) p.status = "OK";
    }
    console.log(`${p.projectKey.padEnd(9)} missing-now=${String(p.missing.length).padStart(4)}  resolved-elsewhere=${dropped}`);
  }

  if (resolvedElsewhere.length) {
    fs.writeFileSync(path.join(outDir, "present_under_other_key.json"), JSON.stringify(resolvedElsewhere, null, 2));
  }

  stats.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  const outFile = await writeWorkbook(stats, outDir);

  const totalMissing = stats.reduce((s, p) => s + p.missing.length, 0);
  const projectsWithMissing = stats.filter((p) => p.missing.length > 0).length;
  console.log("-".repeat(60));
  console.log(`Checked ${checked} candidate keys. Resolved-elsewhere (removed): ${resolvedElsewhere.length}.`);
  console.log(`FINAL truly-missing: ${totalMissing} across ${projectsWithMissing} project(s).`);
  console.log(`Corrected report: ${outFile}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
