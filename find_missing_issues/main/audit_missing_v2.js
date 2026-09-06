#!/usr/bin/env node
// Fresh DC->Cloud "missing issues" audit (June 2026).
//
// Differences vs find_missing_issues.js:
//   * Date cutoff: only DC issues created before MIGRATION_CUTOFF are checked
//     (issues created after the migration could never have been migrated).
//   * Lightweight diff: DC keys fetched with fields=*none @1000/page (no heavy
//     comment/attachment payloads during the diff phase).
//   * Remap verification: every key that looks missing is re-checked against
//     Cloud labels (DC issues re-created under a new key keep the old key as a
//     label, e.g. ENG-90021 -> ENG-96914). Those are NOT counted as missing.
//   * Cross-project concurrency to offset Cloud's 100/page hard cap.
//   * Enrichment: comment/attachment fields fetched only for the truly-missing set.
require("dotenv").config();
const path = require("path");
const fs = require("fs");

const JiraDcClient = require("../src/jiraDcClient");
const JiraCloudClient = require("../src/jiraCloudClient");
const { writeWorkbook } = require("../src/excelWriter");

const CUTOFF = process.env.MIGRATION_CUTOFF || "2026-05-11"; // created < this date
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 4);
const CHECKPOINT_FILE = "audit_v2_checkpoint.jsonl";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function ts() {
  return new Date().toISOString().substring(11, 19);
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function loadCheckpoint(outDir) {
  const file = path.join(outDir, CHECKPOINT_FILE);
  if (!fs.existsSync(file)) return { stats: [], doneKeys: new Set() };
  const stats = [];
  const doneKeys = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.projectKey && !doneKeys.has(entry.projectKey)) {
        stats.push(entry);
        doneKeys.add(entry.projectKey);
      }
    } catch (e) {
      console.warn(`  checkpoint: skip malformed line: ${e.message}`);
    }
  }
  return { stats, doneKeys };
}
function appendCheckpoint(outDir, entry) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, CHECKPOINT_FILE), JSON.stringify(entry) + "\n");
}

function buildDcClient() {
  const baseUrl = requireEnv("DC_BASE_URL");
  if (process.env.DC_PAT) return new JiraDcClient(baseUrl, { token: process.env.DC_PAT });
  return new JiraDcClient(baseUrl, {
    username: requireEnv("DC_USERNAME"),
    password: requireEnv("DC_PASSWORD"),
  });
}

function extractMissingRow(issue) {
  const f = issue.fields || {};
  const commentTotal = f.comment?.total ?? f.comment?.comments?.length ?? 0;
  const attachments = Array.isArray(f.attachment) ? f.attachment.length : 0;
  return {
    key: issue.key,
    summary: f.summary || "",
    type: f.issuetype?.name || "",
    status: f.status?.name || "",
    hasComments: commentTotal > 0,
    hasAttachments: attachments > 0,
  };
}

function classifyCloudError(err) {
  if (err.statusCode === 400 && /does not exist|no project could be found/i.test(err.responseBody || "")) {
    return "PROJECT_NOT_IN_CLOUD";
  }
  if (err.statusCode === 403) return "NO_PERMISSION_CLOUD";
  return null;
}

async function processProject(dc, cloud, projectKey) {
  // Cloud: full key set for the project (all keys, no date filter — we want to
  // know whether the DC key exists in Cloud at all).
  let cloudKeys;
  let cloudStatus = null;
  let note = "";
  try {
    cloudKeys = await cloud.getProjectIssueKeys(projectKey);
  } catch (err) {
    const classified = classifyCloudError(err);
    if (!classified) throw err;
    cloudKeys = new Set();
    cloudStatus = classified;
    note = (err.message || "").substring(0, 200);
  }

  // DC: lightweight key list, restricted to issues that existed at migration time.
  const { keys: dcKeys, total: dcCount } = await dc.getProjectKeys(projectKey, CUTOFF);

  // First-pass diff by key.
  const candidateMissing = [];
  for (const k of dcKeys) if (!cloudKeys.has(k)) candidateMissing.push(k);

  // Remap verification: drop any candidate that exists in Cloud under a new key
  // (original key preserved as a label). Skip if Cloud was unreachable for project.
  let remapped = new Map();
  if (candidateMissing.length && !cloudStatus) {
    try {
      remapped = await cloud.findRemappedKeys(candidateMissing);
    } catch (e) {
      note = (note ? note + " | " : "") + `remap-check failed: ${(e.message || "").substring(0, 120)}`;
    }
  }
  const trulyMissingKeys = candidateMissing.filter((k) => !remapped.has(k));

  // Enrich only the truly-missing set with display fields.
  let missing = [];
  if (trulyMissingKeys.length) {
    const issues = await dc.getIssuesByKeys(trulyMissingKeys);
    const byKey = new Map(issues.map((i) => [i.key, i]));
    missing = trulyMissingKeys.map((k) => {
      const i = byKey.get(k);
      return i ? extractMissingRow(i) : { key: k, summary: "(could not fetch from DC)", type: "", status: "", hasComments: false, hasAttachments: false };
    });
  }

  let status;
  if (cloudStatus) status = cloudStatus;
  else if (dcCount === 0 && cloudKeys.size === 0) status = "OK_EMPTY";
  else if (missing.length === 0) status = "OK";
  else status = "MISSING";

  const remapList = [...remapped.entries()].map(([dcKey, cloudKey]) => ({ dcKey, cloudKey }));
  if (remapList.length) {
    note = (note ? note + " | " : "") + `${remapList.length} migrated under new cloud key (label-verified)`;
  }

  return {
    projectKey,
    dcCount,
    cloudCount: cloudKeys.size,
    missing,
    status,
    note,
    remapped: remapList,
  };
}

async function runPool(items, concurrency, worker) {
  let idx = 0;
  const runNext = async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      await worker(items[myIdx], myIdx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
}

async function main() {
  const outDir = path.join(__dirname, "..", "reports");
  const { stats, doneKeys } = loadCheckpoint(outDir);
  if (doneKeys.size > 0) log(`Resuming: ${doneKeys.size} project(s) already in ${CHECKPOINT_FILE}.`);

  const dc = buildDcClient();
  const cloud = new JiraCloudClient(requireEnv("CLOUD_BASE_URL"), requireEnv("CLOUD_API_TOKEN"));

  log(`Cutoff: DC issues with created < "${CUTOFF}". Concurrency: ${CONCURRENCY}.`);
  log("Fetching project list from DC ...");
  const projects = await dc.getAllProjects();
  let keys = projects.map((p) => p.key).sort();
  if (process.env.AUDIT_PROJECTS) {
    const only = new Set(process.env.AUDIT_PROJECTS.split(",").map((s) => s.trim()).filter(Boolean));
    keys = keys.filter((k) => only.has(k));
    log(`AUDIT_PROJECTS filter active -> ${keys.length} project(s): ${keys.join(", ")}`);
  }
  log(`Found ${keys.length} projects.`);
  if (keys.length === 0) throw new Error("DC returned 0 projects — check permissions / base URL.");

  let completed = doneKeys.size;
  await runPool(keys, CONCURRENCY, async (key) => {
    if (doneKeys.has(key)) return;
    let result;
    try {
      result = await processProject(dc, cloud, key);
      completed++;
      log(`[${completed}/${keys.length}] ${key}: DC=${result.dcCount} Cloud=${result.cloudCount} missing=${result.missing.length}` +
        `${result.remapped.length ? ` remapped=${result.remapped.length}` : ""} [${result.status}]`);
    } catch (err) {
      completed++;
      console.error(`[${completed}/${keys.length}] ${key}: FAILED — ${err.message}`);
      result = { projectKey: key, dcCount: -1, cloudCount: -1, missing: [], status: "FAILED", note: (err.message || "").substring(0, 200), remapped: [] };
    }
    stats.push(result);
    appendCheckpoint(outDir, result);
  });

  // Persist remap details (small) separately so nothing is lost.
  const allRemapped = stats.flatMap((s) => (s.remapped || []).map((r) => ({ project: s.projectKey, ...r })));
  if (allRemapped.length) {
    const rf = path.join(outDir, `remapped_keys_${new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19)}.json`);
    fs.writeFileSync(rf, JSON.stringify(allRemapped, null, 2));
    log(`Wrote ${allRemapped.length} remapped-key records to ${path.basename(rf)}`);
  }

  // Order stats by project key for a stable report.
  stats.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  const outFile = await writeWorkbook(stats, outDir);
  log(`Report written: ${outFile}`);

  const totalMissing = stats.reduce((s, p) => s + p.missing.length, 0);
  const projectsWithMissing = stats.filter((p) => p.missing.length > 0).length;
  const failed = stats.filter((p) => p.status === "FAILED").length;
  log(`Total missing: ${totalMissing} across ${projectsWithMissing} project(s). Remapped(not counted): ${allRemapped.length}. Failed: ${failed}.`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
