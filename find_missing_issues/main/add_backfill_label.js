#!/usr/bin/env node
// Tag every successfully-imported missing issue (preserved key) with a marker label so
// the sync_* scripts can scope to exactly this batch via `labels = "<LABEL>"`.
// (a creator-based JQL can match tens of thousands of unrelated issues, and key lists blow the JQL GET limit.)
// Adds the label WITHOUT touching other labels, notifyUsers=false (no emails).
// Usage: node main/add_backfill_label.js [--apply]   (default = test 1 issue only)
require("dotenv").config({ path: __dirname + "/../.env" });
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const LABEL = process.env.BACKFILL_LABEL || "cloud-backfill-2026-06";
const APPLY = process.argv.includes("--apply");
const base = process.env.CLOUD_BASE_URL.replace(/\/$/, "");
const authHeader = "Basic " + process.env.CLOUD_API_TOKEN;
const { data } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reports", "_missing_data.json"), "utf8"));
const keys = Object.keys(data);
const CONC = 8;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { Authorization: authHeader, Accept: "application/json", "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        if (res.statusCode >= 400) { const e = new Error(`${res.statusCode}: ${d.slice(0, 200)}`); e.statusCode = res.statusCode; return reject(e); }
        resolve(d ? JSON.parse(d) : {}); }); });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}
const addLabel = (k) => req("PUT", `/rest/api/3/issue/${encodeURIComponent(k)}?notifyUsers=false`, { update: { labels: [{ add: LABEL }] } });

(async () => {
  console.log(`Label: "${LABEL}"  Issues: ${keys.length}  Mode: ${APPLY ? "APPLY" : "TEST (1 issue)"}`);
  if (!APPLY) {
    try { await addLabel(keys[0]); console.log(`OK on ${keys[0]} (notifyUsers=false works). Re-run with --apply for all.`); }
    catch (e) { console.log(`FAILED on ${keys[0]}: ${e.message}`); }
    return;
  }
  let ok = 0, fail = [];
  for (let i = 0; i < keys.length; i += CONC) {
    const batch = keys.slice(i, i + CONC);
    const rs = await Promise.all(batch.map((k) => addLabel(k).then(() => ["ok", k]).catch((e) => ["fail", k, e.statusCode])));
    for (const r of rs) { if (r[0] === "ok") ok++; else fail.push(`${r[1]}(${r[2]})`); }
    if ((i + CONC) % 200 === 0 || i + CONC >= keys.length) process.stdout.write(`  ${Math.min(i + CONC, keys.length)}/${keys.length}\r`);
  }
  console.log(`\nLabeled ${ok}/${keys.length}.` + (fail.length ? ` Failed ${fail.length}: ${fail.slice(0, 20).join(", ")}` : ""));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
