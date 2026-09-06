#!/usr/bin/env node
// False-negative guard: re-enumerate DC keys for every project and assert the
// number of DISTINCT keys retrieved equals the DC API's reported total for the
// same JQL. A mismatch would mean pagination skipped issues -> missing could be
// under-reported. Prints only mismatches + a final summary.
require("dotenv").config({ path: __dirname + "/../.env" });
const JiraDcClient = require("../src/jiraDcClient");
const dc = new JiraDcClient(process.env.DC_BASE_URL, { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD });
const enc = encodeURIComponent;
const CUTOFF = "2026-05-11";

async function enumerate(pk) {
  const jql = enc(`project = "${pk}" AND created < "${CUTOFF}" ORDER BY created ASC`);
  const keys = new Set();
  let startAt = 0, total = null;
  while (true) {
    const r = await dc.makeRequest(`/rest/api/2/search?jql=${jql}&fields=*none&startAt=${startAt}&maxResults=1000`);
    const issues = r?.issues || [];
    for (const i of issues) if (i.key) keys.add(i.key);
    if (typeof r?.total === "number") total = r.total;
    if (issues.length < 1000) break;
    if (total !== null && startAt + issues.length >= total) break;
    startAt += 1000;
  }
  return { size: keys.size, total: total ?? keys.size };
}

(async () => {
  const projects = (await dc.getAllProjects()).map((p) => p.key).sort();
  let ok = 0; const bad = [];
  for (let i = 0; i < projects.length; i++) {
    const pk = projects[i];
    const { size, total } = await enumerate(pk);
    if (size === total) ok++;
    else { bad.push({ pk, size, total }); console.log(`MISMATCH ${pk}: enumerated=${size} total=${total} (diff ${total - size})`); }
    if ((i + 1) % 25 === 0) console.log(`  ...checked ${i + 1}/${projects.length}`);
  }
  console.log(`\nDC completeness: ${ok}/${projects.length} projects fully enumerated (set size == API total).`);
  console.log(bad.length ? `MISMATCHES: ${bad.length} — DC enumeration may have skipped issues.` : `No mismatches — DC enumeration complete; no missing issues could have been overlooked.`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
