#!/usr/bin/env node
// Pre-import safety check: re-confirm every target DC key is still FREE in Cloud.
//
// The System-level CSV importer only CREATES a row's issue on its original key when
// that key is unoccupied. If the key is already taken, the importer silently turns the
// row into an EDIT of the existing issue. These 1,242 keys were free at audit time, but
// keys at/above their project counter (e.g. PLAT-170) can be consumed by any normal
// issue created in Cloud since then. Run this right before importing.
//
// Read-only. Exits non-zero if any target key is occupied.
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const JiraCloudClient = require("../src/jiraCloudClient");

const cloud = new JiraCloudClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const { data } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reports", "_missing_data.json"), "utf8"));
const keys = Object.keys(data);
const CONCURRENCY = 8;

// 200 -> taken, 404 -> free. makeRequest rejects 4xx immediately (retries only 429/5xx).
async function status(key) {
  try {
    await cloud.makeRequest(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`);
    return "TAKEN";
  } catch (e) {
    if (e.statusCode === 404) return "FREE";
    return "ERR:" + (e.statusCode || e.message);
  }
}

(async () => {
  console.log(`Checking ${keys.length} target keys against ${process.env.CLOUD_BASE_URL} (concurrency ${CONCURRENCY}) ...`);
  const taken = [], errored = [];
  let done = 0;
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((k) => status(k).then((s) => [k, s])));
    for (const [k, s] of results) {
      if (s === "TAKEN") taken.push(k);
      else if (s.startsWith("ERR")) errored.push(`${k} (${s})`);
    }
    done += batch.length;
    if (done % 200 === 0 || done === keys.length) process.stdout.write(`  ${done}/${keys.length}\r`);
  }
  console.log("");
  // Always write the exclusion file so `generate_import_csvs.js` can drop occupied keys.
  const outFile = path.join(__dirname, "..", "reports", "_occupied_keys.json");
  fs.writeFileSync(outFile, JSON.stringify({ checkedAt: new Date().toISOString(), base: process.env.CLOUD_BASE_URL, occupied: taken, errored }, null, 2));

  console.log(`FREE (safe to create): ${keys.length - taken.length - errored.length}/${keys.length}`);
  if (errored.length) console.log(`!! Could not check ${errored.length}: ${errored.join(", ")}`);
  if (taken.length) {
    console.log(`!! ${taken.length} target key(s) are now OCCUPIED — these rows would EDIT an existing issue, not create:`);
    for (const k of taken) console.log(`   - ${k}`);
    console.log(`   Wrote ${outFile}. Re-run \`node main/generate_import_csvs.js\` to drop them, then re-validate.`);
    process.exit(1);
  }
  console.log(`Wrote ${outFile} (0 occupied).`);
  console.log("=== All target keys are free — the importer will CREATE each on its original key. ===");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
