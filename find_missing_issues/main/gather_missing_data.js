#!/usr/bin/env node
// Pull full DC data for the missing issues so we can build import-ready CSVs.
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const JiraDcClient = require("../src/jiraDcClient");

// ── EDIT THESE FOR YOUR INSTANCE ────────────────────────────────────────────
// Data Center custom-field ids. Find yours with:
//   GET /rest/api/2/field  (match on the field name, read the `id`)
// The ids below are placeholders and WILL NOT match your tenant.
const EPIC_LINK = "customfield_10001";
const EPIC_NAME = "customfield_10002";
const PARENT_LINK = "customfield_10003";

const STEPS = "customfield_10004";       // Steps To Reproduce (textarea)
const ACTUAL = "customfield_10005";      // Actual Result (textarea)
const EXPECTED = "customfield_10006";    // Expected Result (textarea)
const FIX_TYPE = "customfield_10007";    // Resolution Category (multi-select)
const TEST_PHASE = "customfield_10008";  // Test Phase (single-select)
const TEST_RES = "customfield_10009";    // Testing Resolution (single-select)
const FUNC_AREAS = "customfield_10010";  // Capability Areas (multi-select)
const SPRINT = "customfield_10011";      // Sprint (gh-sprint)
// Validator-required on some Cloud create screens and hidden from createmeta —
// probe_required_fields.js is how you discover the equivalents on your instance.
const BUSINESS_AREA = "customfield_10012";
const APPLICABLE_CUSTOMERS = "customfield_10013";

const optVal = (o) => (o && o.value) || "";
const optArr = (a) => (Array.isArray(a) ? a.map((o) => o.value || o.name || String(o)).filter(Boolean) : []);
// DC v2 returns gh-sprint as opaque strings ("...Sprint@..[id=..,state=CLOSED,name=Foo,..]"); pull the name(s).
function sprintNames(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const s of arr) {
    if (s && typeof s === "object" && s.name) { out.push(s.name); continue; }
    const m = String(s).match(/name=([^,]*)/);
    if (m) out.push(m[1]);
  }
  return out;
}
const outDir = path.join(__dirname, "..", "reports");
const dc = new JiraDcClient(process.env.DC_BASE_URL, { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD });
const enc = encodeURIComponent;

function latestReport() {
  const f = fs.readdirSync(outDir).filter((x) => /^missing_issues_2026-06-17.*\.xlsx$/.test(x) && !x.startsWith("~$")).sort();
  return path.join(outDir, f[f.length - 1]);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(latestReport());
  const perProject = {};
  wb.eachSheet((ws) => {
    if (ws.name === "Summary") return;
    const keys = [];
    ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value) keys.push(String(row.getCell(1).value)); });
    if (keys.length) perProject[ws.name] = keys;
  });
  const allKeys = Object.values(perProject).flat();
  console.log(`Fetching DC data for ${allKeys.length} issues...`);

  const fields = ["summary", "issuetype", "status", "priority", "resolution", "created", "labels", "parent",
    "description", "environment", STEPS, ACTUAL, EXPECTED, FIX_TYPE, TEST_PHASE, TEST_RES, FUNC_AREAS, SPRINT, BUSINESS_AREA, APPLICABLE_CUSTOMERS,
    EPIC_LINK, EPIC_NAME, PARENT_LINK].join(",");
  const data = {};
  for (let i = 0; i < allKeys.length; i += 100) {
    const batch = allKeys.slice(i, i + 100);
    const jql = enc(`key in (${batch.map((k) => `"${k}"`).join(",")})`);
    const r = await dc.makeRequest(`/rest/api/2/search?jql=${jql}&fields=${fields}&maxResults=100`);
    for (const iss of (r.issues || [])) {
      const f = iss.fields || {};
      data[iss.key] = {
        key: iss.key,
        project: iss.key.split("-")[0],
        summary: f.summary || "",
        type: f.issuetype?.name || "",
        subtask: !!f.issuetype?.subtask,
        status: f.status?.name || "",
        priority: f.priority?.name || "",
        resolution: f.resolution?.name || "",
        created: f.created || "",
        labels: f.labels || [],
        description: f.description || "",
        environment: f.environment || "",
        stepsToReproduce: f[STEPS] || "",
        actualResult: f[ACTUAL] || "",
        expectedResult: f[EXPECTED] || "",
        testPhase: optVal(f[TEST_PHASE]),
        testingResolution: optVal(f[TEST_RES]),
        fixType: optArr(f[FIX_TYPE]),
        functionalAreas: optArr(f[FUNC_AREAS]),
        sprints: sprintNames(f[SPRINT]),
        businessArea: optVal(f[BUSINESS_AREA]),
        applicableCustomers: optArr(f[APPLICABLE_CUSTOMERS]),
        parentKey: f.parent?.key || "",
        epicLink: f[EPIC_LINK] || "",
        epicName: f[EPIC_NAME] || "",
        parentLink: f[PARENT_LINK] || "",
      };
    }
  }
  console.log(`Got ${Object.keys(data).length} issues.`);

  // hierarchy stats
  const missingSet = new Set(allKeys);
  const byType = {};
  let subtasks = 0, epics = 0, withEpicLink = 0, withParentLink = 0;
  let subParentMissing = 0, subParentInCloud = 0;
  let epicLinkMissing = 0, epicLinkInCloud = 0;
  for (const k of allKeys) {
    const d = data[k]; if (!d) continue;
    byType[d.type] = (byType[d.type] || 0) + 1;
    if (d.subtask) { subtasks++; if (missingSet.has(d.parentKey)) subParentMissing++; else subParentInCloud++; }
    if (/epic/i.test(d.type)) epics++;
    if (d.epicLink) { withEpicLink++; if (missingSet.has(d.epicLink)) epicLinkMissing++; else epicLinkInCloud++; }
    if (d.parentLink) withParentLink++;
  }
  console.log("\n=== Issue types among missing ===");
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(22)} ${n}`);
  console.log("\n=== Hierarchy ===");
  console.log(`  Sub-tasks: ${subtasks}  (parent also missing: ${subParentMissing}, parent in cloud: ${subParentInCloud})`);
  console.log(`  Epics: ${epics}`);
  console.log(`  With Epic Link: ${withEpicLink}  (epic also missing: ${epicLinkMissing}, epic in cloud: ${epicLinkInCloud})`);
  console.log(`  With Parent Link (portfolio): ${withParentLink}`);
  const noKey = allKeys.filter((k) => !data[k]);
  if (noKey.length) console.log(`  !! not fetched from DC: ${noKey.length} (${noKey.slice(0, 5).join(",")})`);

  fs.writeFileSync(path.join(outDir, "_missing_data.json"), JSON.stringify({ perProject, data }, null, 2));
  console.log("\nWrote _missing_data.json");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
