#!/usr/bin/env node
// Auto-discover EVERY required field (incl. hidden validator/behaviour fields that
// createmeta reports as required:false) for each (project, issue type) in the missing
// set, by attempting a REST create and reading each "Field X is required" error, adding
// a synthesized value, and retrying until the create succeeds. The probe issue is then
// DELETED. Output: reports/_required_fields.json (project|type -> [field names we had to
// supply beyond Summary]). Read this to know which columns/defaults the CSV must carry.
//
// Targets projects in PROJECTS env (comma-sep) or defaults to the not-yet-imported set.
// Usage: node main/probe_required_fields.js [--apply]   (default = dry run, no writes)
require("dotenv").config({ path: __dirname + "/../.env" });
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const base = process.env.CLOUD_BASE_URL.replace(/\/$/, "");
const authHeader = "Basic " + process.env.CLOUD_API_TOKEN;
const { data } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reports", "_missing_data.json"), "utf8"));
let occupied = [];
try { occupied = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reports", "_occupied_keys.json"), "utf8")).occupied || []); } catch { occupied = new Set(); }
const TARGET = (process.env.PROJECTS ? process.env.PROJECTS.split(",") : ["BUILD", "DAN", "BAND", "CONTINT", "PLAT"]);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { Authorization: authHeader, Accept: "application/json", "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        let json; try { json = d ? JSON.parse(d) : {}; } catch { json = { raw: d }; }
        if (res.statusCode >= 400) { const e = new Error(res.statusCode); e.statusCode = res.statusCode; e.json = json; return reject(e); }
        resolve(json); }); });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

// our CSV-carried fields, keyed by Jira field NAME
const OUR = {
  "Summary": (d) => d.summary, "Description": (d) => d.description || "N/A",
  "Steps To Reproduce": (d) => d.stepsToReproduce || "N/A", "Actual Result": (d) => d.actualResult || "N/A",
  "Expected Result": (d) => d.expectedResult || "N/A", "Environment": (d) => d.environment,
  "Test Phase": (d) => d.testPhase, "Testing Resolution": (d) => d.testingResolution,
  "Department": (d) => d.businessArea || "Bet", "Resolution Category": (d) => d.fixType,
  "Capability Areas": (d) => d.functionalAreas, "Priority": (d) => d.priority,
};

function matchOption(fm, val) {
  const av = (fm.allowedValues || []).find((o) => String(o.value || o.name).toLowerCase() === String(val).toLowerCase());
  return av ? { id: av.id } : null;
}
// format one of OUR values per the field schema; null = skip
function fmt(fm, raw) {
  if (raw == null || raw === "" || (Array.isArray(raw) && !raw.length)) return null;
  const t = fm.schema && fm.schema.type, items = fm.schema && fm.schema.items;
  if (t === "string") return String(raw);
  if (t === "option") return matchOption(fm, raw);
  if (t === "priority") return { name: String(raw) };
  if (t === "array") {
    const arr = Array.isArray(raw) ? raw : [raw];
    if (items === "option") return arr.map((v) => matchOption(fm, v)).filter(Boolean);
    if (items === "string") return arr.map(String);
    return null;
  }
  return String(raw);
}
// synthesize a valid value for a REQUIRED field we have no data for
function synth(fm, apiUser) {
  const t = fm.schema && fm.schema.type, items = fm.schema && fm.schema.items;
  const av = fm.allowedValues || [];
  if (t === "string") return "N/A";
  if (t === "option" || t === "priority") return av[0] ? { id: av[0].id } : null;
  if (t === "user") return { accountId: apiUser };
  if (t === "number") return 1;
  if (t === "date") return "2024-01-01";
  if (t === "datetime") return "2024-01-01T12:00:00.000+0000";
  if (t === "option-with-child") return av[0] ? { id: av[0].id } : null;
  if (t === "array") {
    if (items === "option") return av[0] ? [{ id: av[0].id }] : [];
    if (items === "string") return ["N/A"];
    if (items === "user") return [{ accountId: apiUser }];
    if (av[0]) return [{ id: av[0].id }];
    return [];
  }
  return av[0] ? { id: av[0].id } : "N/A";
}

(async () => {
  const apiUser = (await req("GET", "/rest/api/3/myself")).accountId;
  console.log(APPLY ? "=== APPLY (creates + deletes probe issues) ===" : "=== DRY RUN (use --apply to actually probe) ===");
  // combos: project -> type -> sample remaining issue
  const combos = {};
  for (const k of Object.keys(data)) {
    const d = data[k]; if (!TARGET.includes(d.project) || occupied.has(k)) continue;
    (combos[d.project] = combos[d.project] || {});
    if (!combos[d.project][d.type]) combos[d.project][d.type] = { sample: k, subtask: d.subtask, count: 0 };
    combos[d.project][d.type].count++;
  }
  const report = {};
  for (const project of Object.keys(combos).sort()) {
    let proj;
    try { const meta = await req("GET", `/rest/api/3/issue/createmeta?projectKeys=${project}`); proj = meta.projects && meta.projects[0]; }
    catch (e) { console.log(`${project}: createmeta ERR ${e.statusCode}`); continue; }
    if (!proj) { console.log(`${project}: no createmeta`); continue; }
    for (const dcType of Object.keys(combos[project])) {
      const { sample, subtask } = combos[project][dcType];
      const d = data[sample];
      const cloudType = proj.issuetypes.find((t) => t.name.toLowerCase() === dcType.toLowerCase()) || (subtask && proj.issuetypes.find((t) => t.subtask));
      const label = `${project}|${dcType}`;
      if (!cloudType) { report[label] = { error: `no matching Cloud issue type (have: ${proj.issuetypes.map((t) => t.name).join(",")})` }; console.log(`${label}: NO TYPE`); continue; }
      // fields must be fetched PER issue type (the bulk createmeta returns empty fields)
      let fieldsById = {};
      try { const fmeta = await req("GET", `/rest/api/3/issue/createmeta?projectKeys=${project}&issuetypeNames=${encodeURIComponent(cloudType.name)}&expand=projects.issuetypes.fields`);
        const itf = ((fmeta.projects[0] || {}).issuetypes || []).find((t) => t.id === cloudType.id) || (fmeta.projects[0] || {}).issuetypes[0];
        fieldsById = (itf && itf.fields) || {}; }
      catch (e) { report[label] = { error: `fields fetch ERR ${e.statusCode}` }; console.log(`${label}: fields ERR`); continue; }
      const byName = {};
      for (const [fid, f] of Object.entries(fieldsById)) byName[f.name] = { ...f, id: fid }; // createmeta field id is the KEY, not f.id
      // base payload from OUR fields present on this screen
      const fields = { project: { id: proj.id }, issuetype: { id: cloudType.id }, summary: d.summary || "probe" };
      for (const [name, get] of Object.entries(OUR)) {
        if (name === "Summary" || !byName[name]) continue;
        const v = fmt(byName[name], get(d)); if (v != null) fields[byName[name].id] = v;
      }
      if (subtask) { const pk = d.parentKey || d.epicLink || d.parentLink; if (pk) fields.parent = { key: pk }; }
      if (!APPLY) { console.log(`${label}: would probe (sample ${sample}${subtask ? ", subtask parent " + (fields.parent && fields.parent.key) : ""})`); report[label] = { dryRun: true }; continue; }

      const added = [];
      let outcome = "?", createdKey = null, lastErr = null;
      for (let iter = 0; iter < 14; iter++) {
        try { const c = await req("POST", "/rest/api/2/issue", { fields }); createdKey = c.key; outcome = "OK"; break; }
        catch (e) {
          lastErr = e.json;
          if (e.statusCode !== 400 || !e.json) { outcome = "ERR " + e.statusCode; break; }
          let progressed = false;
          const errs = e.json.errors || {};
          for (const [fid, msg] of Object.entries(errs)) {
            const fm = fieldsById[fid];
            if (/required/i.test(msg) && !(fid in fields) && fm) { fields[fid] = synth(fm, apiUser); added.push(fm.name); progressed = true; }
            else if (!/required/i.test(msg) && fid in fields && fm) { fields[fid] = synth(fm, apiUser); progressed = true; } // bad value -> replace
            else if (!/required/i.test(msg) && fid in fields) { delete fields[fid]; progressed = true; }
          }
          for (const msg of e.json.errorMessages || []) {
            const m = msg.match(/Field (.+?) is required/i) || msg.match(/^(.+?) is required/i);
            if (m && byName[m[1]] && !(byName[m[1]].id in fields)) { fields[byName[m[1]].id] = synth(byName[m[1]], apiUser); added.push(m[1]); progressed = true; }
          }
          if (!progressed) { outcome = "STUCK: " + JSON.stringify({ errorMessages: e.json.errorMessages, errors: e.json.errors }).slice(0, 300); break; }
        }
      }
      if (outcome === "?") outcome = "UNRESOLVED: " + JSON.stringify(lastErr).slice(0, 300);
      if (createdKey) { try { await req("DELETE", `/rest/api/3/issue/${createdKey}`); } catch { /* leave for manual cleanup */ } }
      report[label] = { outcome, requiredBeyondOurColumns: [...new Set(added)], probe: createdKey };
      console.log(`${label.padEnd(20)} ${outcome === "OK" ? "OK" : outcome}  ${added.length ? "NEEDS: " + [...new Set(added)].join(", ") : ""}`);
    }
  }
  fs.writeFileSync(path.join(__dirname, "..", "reports", "_required_fields.json"), JSON.stringify(report, null, 2));
  console.log("\nWrote reports/_required_fields.json");
})().catch((e) => { console.error("FATAL", e.message, e.json || ""); process.exit(1); });
