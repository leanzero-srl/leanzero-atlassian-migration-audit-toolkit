#!/usr/bin/env node
require("dotenv").config();
const path = require("path");
const fs = require("fs");

const JiraDcClient = require("../src/jiraDcClient");
const JiraCloudClient = require("../src/jiraCloudClient");
const { writeWorkbook } = require("../src/excelWriter");

const CHECKPOINT_FILE = "checkpoint.jsonl";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  const file = path.join(outDir, CHECKPOINT_FILE);
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
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
  // Cloud first: it's just a Set of keys (small even for 200k-issue projects).
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

  // DC: stream so we never hold the full issue array in memory.
  let dcCount = 0;
  const missing = [];
  for await (const issue of dc.iterateProjectIssues(projectKey)) {
    dcCount++;
    if (issue.key && !cloudKeys.has(issue.key)) {
      missing.push(extractMissingRow(issue));
    }
  }

  let status;
  if (cloudStatus) status = cloudStatus;
  else if (dcCount === 0 && cloudKeys.size === 0) status = "OK_EMPTY";
  else if (missing.length === 0) status = "OK";
  else status = "MISSING";

  return { projectKey, dcCount, cloudCount: cloudKeys.size, missing, status, note };
}

async function main() {
  const outDir = path.join(__dirname, "..", "reports");
  const { stats, doneKeys } = loadCheckpoint(outDir);
  if (doneKeys.size > 0) {
    console.log(`Resuming from checkpoint: ${doneKeys.size} project(s) already processed.`);
  }

  const dc = buildDcClient();
  const cloud = new JiraCloudClient(requireEnv("CLOUD_BASE_URL"), requireEnv("CLOUD_API_TOKEN"));

  console.log("Fetching project list from DC ...");
  const projects = await dc.getAllProjects();
  const keys = projects.map((p) => p.key).sort();
  console.log(`Found ${keys.length} projects.`);
  if (keys.length === 0) throw new Error("DC returned 0 projects — check permissions / base URL.");

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (doneKeys.has(key)) {
      console.log(`[${i + 1}/${keys.length}] ${key} ... SKIP (checkpoint)`);
      continue;
    }
    console.log(`[${i + 1}/${keys.length}] ${key} ...`);
    let result;
    try {
      result = await processProject(dc, cloud, key);
      console.log(`  ${key}: DC=${result.dcCount} Cloud=${result.cloudCount} missing=${result.missing.length} [${result.status}]`);
    } catch (err) {
      console.error(`  ${key}: FAILED — ${err.message}`);
      result = {
        projectKey: key,
        dcCount: -1,
        cloudCount: -1,
        missing: [],
        status: "FAILED",
        note: (err.message || "").substring(0, 200),
      };
    }
    stats.push(result);
    appendCheckpoint(outDir, result);
  }

  const outFile = await writeWorkbook(stats, outDir);
  console.log(`\nReport written: ${outFile}`);

  const totalMissing = stats.reduce((s, p) => s + p.missing.length, 0);
  const projectsWithMissing = stats.filter((p) => p.missing.length > 0).length;
  console.log(`Total missing issues: ${totalMissing} across ${projectsWithMissing} project(s).`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
