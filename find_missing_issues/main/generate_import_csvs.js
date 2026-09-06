#!/usr/bin/env node
// Build import-ready CSVs (one per project) for the missing issues.
// - Hierarchy preserved via the unified `Parent` field:
//     * sub-task / epic-linked issue whose parent EXISTS in Cloud -> parent's Cloud key
//     * sub-task whose parent is ALSO missing (co-created) -> parent row's in-file Issue ID
// - Rows ordered: Epics -> standard issues -> sub-tasks (and any co-created parent
//   precedes its child, in the same file).
// - Original DC key PRESERVED via the "Issue Key" column. Jira Cloud's System-level
//   External System Import keeps the numeric part of a mapped "Issue Key" and applies
//   it to the destination project, so the recreated issue lands on its ORIGINAL key
//   (e.g. ENG-90021 -> ENG-90021) even when that number is below the project
//   counter -- as long as the key is still FREE in Cloud (these are the missing ones,
//   so they are; the audit excluded any DC key already re-created under another key).
//   Note: if a target key is ever already TAKEN, the importer EDITS that issue instead
//   of creating -- so re-confirm freedom right before importing (esp. keys near/above
//   the current counter, e.g. PLAT-170 which sits above PLAT's counter).
// - DC key ALSO kept as the first Label: redundant fallback if a single key import
//   falls back to a new key, and the lookup the REST follow-up scripts already use.
// - Excludes reporter/assignee/comments/links (done later via REST).
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");

const outRoot = path.join(__dirname, "..", "reports");
const csvDir = path.join(outRoot, "import_csvs");

const { data } = JSON.parse(fs.readFileSync(path.join(outRoot, "_missing_data.json"), "utf8"));
const { resolved, coCreated } = JSON.parse(fs.readFileSync(path.join(outRoot, "_parent_resolution.json"), "utf8"));

// Drop any key that `check_keys_free.js` found already present in Cloud. Removing it
// from `data` (and thus `missingSet`) is self-consistent: a child that pointed at it as
// a co-created parent now treats it as an EXISTING Cloud parent and references its key,
// which is correct because it now exists in Cloud under exactly that key.
const occPath = path.join(outRoot, "_occupied_keys.json");
if (fs.existsSync(occPath)) {
  const { occupied = [] } = JSON.parse(fs.readFileSync(occPath, "utf8"));
  const dropped = occupied.filter((k) => k in data);
  for (const k of dropped) delete data[k];
  if (dropped.length) console.log(`Excluded ${dropped.length} already-present key(s): ${dropped.join(", ")}`);
}
const missingSet = new Set(Object.keys(data));

// Optional status canonicalisation (from build_status_map.js): rewrite each DC status to
// the exact spelling its project's Cloud workflow uses, so the importer auto-maps it
// (e.g. "Under Investigation" -> "Under investigation"). Falls back to the raw DC status.
let statusByProject = {};
const smPath = path.join(outRoot, "_status_map.json");
if (fs.existsSync(smPath)) statusByProject = JSON.parse(fs.readFileSync(smPath, "utf8")).byProject || {};
function cloudStatus(d) {
  const m = statusByProject[d.project];
  return (m && m[(d.status || "").toLowerCase()]) || d.status;
}

function csvCell(v) {
  const s = (v === null || v === undefined) ? "" : String(v);
  // Keep embedded newlines (valid inside a quoted field) so multi-line Description /
  // Steps To Reproduce survive; only normalise CRLF and escape quotes.
  return '"' + s.replace(/"/g, '""').replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + '"';
}
const lastSprint = (d) => (d.sprints && d.sprints.length ? d.sprints[d.sprints.length - 1] : "");
// Some projects make Description / Steps To Reproduce / Actual Result / Expected Result
// REQUIRED on the create screen (e.g. PLAT Defect) — an empty cell then fails the
// import ("FixedKeyMutableIssue"). Fill the empties with a placeholder so the row imports.
const FREETEXT_DEFAULT = process.env.FREETEXT_DEFAULT || "N/A";
const orDefault = (v) => (v && String(v).trim() ? v : FREETEXT_DEFAULT);
const isBugType = (d) => /defect|bug|incident|problem/i.test(d.type || "");
function fmtDate(iso) {
  if (!iso) return "";
  // "2024-08-13T10:23:45.000+0100" -> "2024-08-13 10:23:45"
  return iso.substring(0, 19).replace("T", " ");
}

// group rows per project
const byProject = {};
for (const k of Object.keys(data)) {
  const d = data[k];
  (byProject[d.project] = byProject[d.project] || []).push(d);
}

// An orphaned sub-task (sub-task type but no parent of any kind in DC) cannot be
// imported as a sub-task. Re-type to Task (a valid standard type) so it imports
// standalone; mark it so it can be re-parented later via REST if needed.
function isOrphanSubtask(d) {
  return d.subtask && !d.parentKey && !d.epicLink && !d.parentLink;
}
const ORPHAN_TYPE = "Task";
const ORPHAN_LABEL = "dc-orphaned-subtask";
// Orphan sub-tasks carry a Sub-task status ("New") that doesn't exist in the Task
// workflow we re-type them into → import fails. Use the Task workflow's initial status.
const ORPHAN_STATUS = process.env.ORPHAN_STATUS || "RAW";

function effectiveType(d) {
  return isOrphanSubtask(d) ? ORPHAN_TYPE : d.type;
}

function hierRank(d) {
  if (/^epic$/i.test(d.type)) return 0;
  if (d.subtask && !isOrphanSubtask(d)) return 2;
  return 1;
}

// Parent value for a row, resolved against a given chunk's Issue-ID map.
// In-file references (co-created) must point at an Issue ID that lives in the SAME
// chunk; everything else is an existing Cloud key (works regardless of chunking).
function parentValue(d, idByKey) {
  if (isOrphanSubtask(d)) return "";
  if (d.subtask && d.parentKey) {
    if (missingSet.has(d.parentKey)) return String(idByKey.get(d.parentKey)); // co-created -> in-file Issue ID
    return resolved[d.parentKey] || d.parentKey;                              // existing cloud parent -> Cloud key
  }
  if (d.epicLink) {
    if (missingSet.has(d.epicLink)) return String(idByKey.get(d.epicLink));
    return resolved[d.epicLink] || d.epicLink;
  }
  if (d.parentLink) {
    if (missingSet.has(d.parentLink)) return String(idByKey.get(d.parentLink));
    return resolved[d.parentLink] || d.parentLink;
  }
  return "";
}

const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 500);
// Per-project override so a problem project can be split smaller, e.g.
// PROJECT_CHUNK_SIZE='{"PLAT":1}' -> one issue per file (parents/issues isolated).
const PROJECT_CHUNK = JSON.parse(process.env.PROJECT_CHUNK_SIZE || "{}");
// Blank specific field values for a project (column kept, value emptied) so a
// problematic field can't break the import — e.g. an existing-Epic Parent the importer
// can't resolve, or the name-based Sprint it rejects. Restore those via REST afterward.
// PROJECT_CHUNK_SIZE='{"PLAT":1}' BLANK_FIELDS_BY_PROJECT='{"PLAT":["parent","sprint"]}'
const BLANK_BY_PROJECT = JSON.parse(process.env.BLANK_FIELDS_BY_PROJECT || "{}");
// Department is validator-required on some create screens (PLAT) but empty in DC for
// many issues. Fill empties with a per-project default so the row passes the validator.
// BUSINESS_AREA_DEFAULT='{"PLAT":"Bet"}'  (real DC values are kept where present)
const BUSINESS_AREA_DEFAULT = JSON.parse(process.env.BUSINESS_AREA_DEFAULT || "{}");
// Applicable Accounts (multi-select) is validator-required on BUILD Incident/Problem
// (discovered via probe_required_fields.js). Carry the real DC value; where empty AND the
// (project,type) requires it, default to "N/A" (a real Cloud option).
const AC_REQUIRED = { BUILD: ["Incident", "Problem"] };
const AC_DEFAULT = process.env.APPLICABLE_CUSTOMERS_DEFAULT || "N/A";
function acFor(d) {
  const have = d.applicableCustomers || [];
  if (have.length) return have;
  if ((AC_REQUIRED[d.project] || []).includes(d.type)) return [AC_DEFAULT];
  return [];
}
const coCreatedSet = new Set(coCreated);

fs.mkdirSync(csvDir, { recursive: true });
const manifest = [];

for (const project of Object.keys(byProject).sort()) {
  const allRows = byProject[project];
  const blankFields = new Set(BLANK_BY_PROJECT[project] || []);

  // Build atomic units. A co-created parent + its missing children must stay in the
  // same file (they link by in-file Issue ID), so they form one indivisible unit.
  const consumed = new Set();
  const units = [];
  for (const d of allRows) {
    if (!coCreatedSet.has(d.key)) continue;
    const children = allRows.filter((c) => c.subtask && c.parentKey === d.key)
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const rows = [d, ...children];           // parent first, then its children
    rows.forEach((r) => consumed.add(r.key));
    units.push({ rows, rank: 1.5 });         // sits at the standard->sub-task boundary
  }
  for (const d of allRows) {
    if (consumed.has(d.key)) continue;
    units.push({ rows: [d], rank: hierRank(d) });
  }
  units.sort((a, b) => (a.rank - b.rank) || a.rows[0].key.localeCompare(b.rows[0].key, undefined, { numeric: true }));

  // Greedy pack units into ordered chunks, never splitting a unit.
  const chunkSize = PROJECT_CHUNK[project] || CHUNK_SIZE;
  const chunks = [];
  let cur = [];
  for (const u of units) {
    if (cur.length && cur.length + u.rows.length > chunkSize) { chunks.push(cur); cur = []; }
    cur.push(...u.rows);
  }
  if (cur.length) chunks.push(cur);

  chunks.forEach((rows, ci) => {
    const idByKey = new Map();
    // Issue Id = the original DC key NUMBER (unique + stable), NOT a per-file 1,2,3.
    // Jira's importer stores the mapped Issue Id as an external id and "only new items"
    // skips any row whose Issue Id it has seen before — so reused ids (every single-row
    // file had Issue Id 1) collide with the first issue ever imported under id 1. Using
    // the key number makes each row's id globally unique and re-imports idempotent.
    rows.forEach((d) => idByKey.set(d.key, Number(d.key.split("-").pop())));

    const labelLen = (d) => 1 + (isOrphanSubtask(d) ? 1 : 0) + d.labels.length;
    const labelColumns = rows.reduce((m, d) => Math.max(m, labelLen(d)), 1);
    const hasEpic = rows.some((d) => /^epic$/i.test(d.type));
    // multi-select fields -> repeated columns (like Labels), sized to this chunk's max
    const fixCols = rows.reduce((m, d) => Math.max(m, (d.fixType || []).length), 0);
    const funcCols = rows.reduce((m, d) => Math.max(m, (d.functionalAreas || []).length), 0);
    const acCols = rows.reduce((m, d) => Math.max(m, acFor(d).length), 0);

    const header = ["Project Key", "Issue Key", "Issue ID", "Issue Type", "Summary", "Status", "Priority", "Resolution", "Date Created", "Parent"];
    header.push("Description", "Environment", "Steps To Reproduce", "Actual Result", "Expected Result", "Test Phase", "Testing Resolution", "Department", "Sprint");
    for (let i = 0; i < fixCols; i++) header.push("Resolution Category");
    for (let i = 0; i < funcCols; i++) header.push("Capability Areas");
    for (let i = 0; i < acCols; i++) header.push("Applicable Accounts");
    if (hasEpic) header.push("Epic Name");
    for (let i = 0; i < labelColumns; i++) header.push("Labels");

    const lines = [header.map(csvCell).join(",")];
    let subtaskCount = 0, coCreatedInFile = 0, orphanCount = 0;
    for (const d of rows) {
      const orphan = isOrphanSubtask(d);
      if (d.subtask && !orphan) subtaskCount++;
      if (orphan) orphanCount++;
      if (coCreatedSet.has(d.key)) coCreatedInFile++;
      const labels = [d.key, ...(orphan ? [ORPHAN_LABEL] : []), ...d.labels];
      const cells = [
        project,
        d.key,                  // Issue Key -> preserves the original DC key on import
        idByKey.get(d.key),
        effectiveType(d),
        d.summary,
        isOrphanSubtask(d) ? ORPHAN_STATUS : cloudStatus(d),
        d.priority,
        d.resolution,
        fmtDate(d.created),
        blankFields.has("parent") ? "" : parentValue(d, idByKey),
        orDefault(d.description),
        d.environment || "",
        isBugType(d) ? orDefault(d.stepsToReproduce) : (d.stepsToReproduce || ""),
        isBugType(d) ? orDefault(d.actualResult) : (d.actualResult || ""),
        isBugType(d) ? orDefault(d.expectedResult) : (d.expectedResult || ""),
        d.testPhase || "",
        d.testingResolution || "",
        d.businessArea || BUSINESS_AREA_DEFAULT[project] || BUSINESS_AREA_DEFAULT["*"] || "",
        blankFields.has("sprint") ? "" : lastSprint(d),
      ];
      const fix = d.fixType || [];
      for (let i = 0; i < fixCols; i++) cells.push(fix[i] || "");
      const fa = d.functionalAreas || [];
      for (let i = 0; i < funcCols; i++) cells.push(fa[i] || "");
      const ac = acFor(d);
      for (let i = 0; i < acCols; i++) cells.push(ac[i] || "");
      if (hasEpic) cells.push(/^epic$/i.test(d.type) ? (d.epicName || d.summary) : "");
      for (let i = 0; i < labelColumns; i++) cells.push(labels[i] || "");
      lines.push(cells.map(csvCell).join(","));
    }

    // Name single-issue files by their key (unambiguous; no stale "GAMING_1" confusion);
    // multi-issue files keep <PROJECT>_<n>.
    const fileName = rows.length === 1 ? `${rows[0].key}.csv` : `${project}_${ci + 1}.csv`;
    fs.writeFileSync(path.join(csvDir, fileName), lines.join("\n") + "\n");
    manifest.push({ file: fileName, project, chunk: ci + 1, chunks: chunks.length, rows: rows.length, subtasks: subtaskCount, orphanSubtasksRetypedToTask: orphanCount, coCreatedParentsInFile: coCreatedInFile, hasEpic, labelColumns });
    console.log(`${fileName.padEnd(16)} rows=${String(rows.length).padStart(4)} subtasks=${String(subtaskCount).padStart(3)} ${hasEpic ? "EPIC " : ""}${coCreatedInFile ? "co-created=" + coCreatedInFile + " " : ""}${orphanCount ? "orphan->Task=" + orphanCount : ""}`);
  });
}

fs.writeFileSync(path.join(csvDir, "_manifest.json"), JSON.stringify(manifest, null, 2));
const totalRows = manifest.reduce((s, m) => s + m.rows, 0);
console.log(`\nCHUNK_SIZE=${CHUNK_SIZE} -> ${manifest.length} files, ${totalRows} rows total -> ${csvDir}`);
