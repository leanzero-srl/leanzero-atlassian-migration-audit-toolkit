#!/usr/bin/env node
// Resolve the CURRENT Cloud key for every parent / epic referenced by a missing
// issue (a parent may have been moved/re-keyed in Cloud). Flags any reference
// that does NOT exist in Cloud (would break the import). Identifies co-created
// parents (parent also missing -> must be linked within the same CSV).
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const JiraCloudClient = require("../src/jiraCloudClient");

const outDir = path.join(__dirname, "..", "reports");
const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const enc = encodeURIComponent;

async function resolveOne(oldKey) {
  const r = await cloud.makeRequest(`/rest/api/3/search/jql?jql=${enc(`key in ("${oldKey}")`)}&fields=summary&maxResults=1`);
  return (r?.issues || [])[0]?.key || null;
}
async function runPool(items, c, w) { let i = 0; const n = async () => { while (i < items.length) { const j = i++; await w(items[j], j); } }; await Promise.all(Array.from({ length: Math.min(c, items.length) }, n)); }

(async () => {
  const { data } = JSON.parse(fs.readFileSync(path.join(outDir, "_missing_data.json"), "utf8"));
  const missingSet = new Set(Object.keys(data));

  // Collect external references (parent in cloud, epic in cloud).
  const refs = new Set();
  const coCreatedParents = new Set(); // parent also missing
  for (const k of Object.keys(data)) {
    const d = data[k];
    if (d.subtask && d.parentKey) { (missingSet.has(d.parentKey) ? coCreatedParents : refs).add(d.parentKey); }
    if (d.epicLink) { (missingSet.has(d.epicLink) ? coCreatedParents : refs).add(d.epicLink); }
    if (d.parentLink) { (missingSet.has(d.parentLink) ? coCreatedParents : refs).add(d.parentLink); }
  }
  const refList = [...refs];
  console.log(`External parent/epic references to resolve in Cloud: ${refList.length}`);
  console.log(`Co-created parents (also missing, linked in-file): ${[...coCreatedParents].length} -> ${[...coCreatedParents].join(", ") || "(none)"}`);

  const resolved = {}; const unresolved = [];
  await runPool(refList, 6, async (key) => {
    let cur = null;
    try { cur = await resolveOne(key); } catch (e) { cur = null; }
    if (cur) resolved[key] = cur; else unresolved.push(key);
  });

  const moved = Object.entries(resolved).filter(([dc, cl]) => dc !== cl);
  console.log(`\nResolved: ${Object.keys(resolved).length}/${refList.length}`);
  console.log(`  preserved-key: ${Object.keys(resolved).length - moved.length}`);
  console.log(`  moved/re-keyed: ${moved.length}${moved.length ? " -> e.g. " + moved.slice(0, 8).map(([a, b]) => a + "=>" + b).join(", ") : ""}`);
  console.log(`UNRESOLVED (parent/epic NOT in Cloud — would break import): ${unresolved.length}${unresolved.length ? " -> " + unresolved.slice(0, 20).join(", ") : ""}`);

  fs.writeFileSync(path.join(outDir, "_parent_resolution.json"), JSON.stringify({ resolved, unresolved, coCreated: [...coCreatedParents] }, null, 2));
  console.log("\nWrote _parent_resolution.json");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
