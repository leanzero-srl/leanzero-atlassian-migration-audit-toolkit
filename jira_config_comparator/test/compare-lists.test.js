// Regression tests for the config comparator, run against the SHIPPED class
// (jira-config-comparator.js exports it; the CLI only runs when executed directly).
//
// Bug found 2026-11-03: comparing a site with ITSELF reported differences. Jira Cloud
// sites with team-managed projects carry many items that share a name (12 "Bug"
// issue types, 12 "In Review"/"In review" statuses, each scoped to one project).
// compareLists grouped items by lowercased name and then compared EVERY source item
// with EVERY target item in the group, so any two same-named items that differ in
// description, hierarchy level or name casing were reported as a difference, even
// when both sides were the identical snapshot.
//
// Run: npm test   (node --test)

const test = require("node:test");
const assert = require("node:assert/strict");
const { JIRAConfigComparator } = require("../jira-config-comparator.js");

const SRC = "https://source.example.atlassian.net";
const TGT = "https://target.example.atlassian.net";

function makeComparator(options = {}) {
  return new JIRAConfigComparator(SRC, TGT, "user@example.com", "token", options);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Shapes copied from GET /rest/api/3/issuetype and /rest/api/3/status on a real
// Cloud site with company-managed and team-managed projects.
function issueTypesSnapshot(base = SRC) {
  const avatar = (n) => `${base}/rest/api/2/universal_avatar/view/type/issuetype/avatar/${n}?size=medium`;
  const tm = (id, projectId, description, extra = {}) => ({
    self: `${base}/rest/api/3/issuetype/${id}`,
    id: String(id),
    description,
    iconUrl: avatar(10303),
    name: "Bug",
    untranslatedName: "Bug",
    subtask: false,
    avatarId: 10303,
    hierarchyLevel: 0,
    scope: { type: "PROJECT", project: { id: String(projectId) } },
    ...extra,
  });
  return [
    {
      self: `${base}/rest/api/3/issuetype/1`,
      id: "1",
      description: "A problem which impairs or prevents the functions of the product.",
      iconUrl: avatar(10303),
      name: "Bug",
      untranslatedName: "Bug",
      subtask: false,
      avatarId: 10303,
      hierarchyLevel: 0,
    },
    tm(10601, 11801, "Bugs track problems or errors."),
    tm(10602, 11802, "Problems that stop the team shipping."),
    tm(10603, 11803, "Subtasks track small pieces of work.", {
      name: "Subtask",
      untranslatedName: "Subtask",
      subtask: true,
      hierarchyLevel: -1,
    }),
    tm(10604, 11804, "Subtasks track small pieces of work that are part of a larger task.", {
      name: "Subtask",
      untranslatedName: "Subtask",
      subtask: true,
      hierarchyLevel: -1,
    }),
    tm(10605, 11805, "A collection of related bugs, stories, and tasks.", {
      name: "Epic",
      untranslatedName: "Epic",
      hierarchyLevel: 1,
    }),
  ];
}

function statusesSnapshot(base = SRC) {
  const cat = {
    self: `${base}/rest/api/3/statuscategory/4`,
    id: 4,
    key: "indeterminate",
    colorName: "yellow",
    name: "In Progress",
  };
  const st = (id, name, projectId) => ({
    self: `${base}/rest/api/3/status/${id}`,
    description: "",
    iconUrl: `${base}/images/icons/statuses/generic.png`,
    name,
    untranslatedName: name,
    id: String(id),
    statusCategory: { ...cat },
    ...(projectId ? { scope: { type: "PROJECT", project: { id: String(projectId) } } } : {}),
  });
  return [
    st(10010, "In Review"),
    st(10229, "In review", 11801),
    st(10230, "In Review", 11802),
    st(10231, "In review", 11803),
  ];
}

const isClean = (r) =>
  r.missingInTarget.length === 0 && r.extraInTarget.length === 0 && r.differences.length === 0;

test("self-compare: identical snapshot with same-named items yields zero differences", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot();
  const r = c.compareLists(types, clone(types), "name", "name", "issueType");
  assert.deepEqual(
    { missing: r.missingInTarget.length, extra: r.extraInTarget.length, diffs: r.differences.length },
    { missing: 0, extra: 0, diffs: 0 },
  );
  assert.equal(r.sourceCount, types.length);
  assert.equal(r.targetCount, types.length);
});

test("self-compare: statuses differing only in name casing yield zero differences", () => {
  const c = makeComparator();
  const statuses = statusesSnapshot();
  const r = c.compareLists(statuses, clone(statuses), "name", "name", "status");
  assert.ok(isClean(r), JSON.stringify(r.differences.map((d) => d.reason)));
});

test("self-compare: target listed in a different order still yields zero differences", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot();
  const r = c.compareLists(types, clone(types).reverse(), "name", "name", "issueType");
  assert.ok(isClean(r), JSON.stringify(r.differences.map((d) => d.reason)));
});

test("positive control: a one-field change on one of several same-named items is reported once", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot();
  const target = clone(types);
  const changed = target.find((t) => t.id === "10602");
  changed.description = "Changed after migration";
  const r = c.compareLists(types, target, "name", "name", "issueType");
  assert.equal(r.missingInTarget.length, 0);
  assert.equal(r.extraInTarget.length, 0);
  assert.equal(r.differences.length, 1, JSON.stringify(r.differences.map((d) => d.reason)));
  const d = r.differences[0];
  assert.equal(d.source.description, "Problems that stop the team shipping.");
  assert.equal(d.target.description, "Changed after migration");
  assert.match(d.reason, /^description: /);
});

test("positive control: a one-field change on a uniquely named item is reported", () => {
  const c = makeComparator();
  const src = [{ id: "1", name: "Highest", description: "Top", statusColor: "#d04437" }];
  const tgt = [{ id: "9", name: "Highest", description: "Top", statusColor: "#ff0000" }];
  const r = c.compareLists(src, tgt, "name", "name", "priority");
  assert.equal(r.differences.length, 1);
  assert.match(r.differences[0].reason, /statusColor/);
});

test("positive control: one of several same-named items missing on target is reported as missing", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot();
  const target = clone(types).filter((t) => t.id !== "10602");
  const r = c.compareLists(types, target, "name", "name", "issueType");
  assert.equal(r.missingInTarget.length, 1);
  assert.equal(r.missingInTarget[0].description, "Problems that stop the team shipping.");
  assert.equal(r.extraInTarget.length, 0);
  assert.equal(r.differences.length, 0);
});

test("positive control: an extra same-named item on target is reported as extra", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot();
  const target = clone(types);
  target.push({ ...clone(types[1]), id: "20000", description: "Only on target" });
  const r = c.compareLists(types, target, "name", "name", "issueType");
  assert.equal(r.extraInTarget.length, 1);
  assert.equal(r.extraInTarget[0].description, "Only on target");
  assert.equal(r.missingInTarget.length, 0);
  assert.equal(r.differences.length, 0);
});

test("cross-site: same config with different ids, self URLs and host names yields zero differences", () => {
  const c = makeComparator();
  const src = issueTypesSnapshot(SRC);
  const tgt = issueTypesSnapshot(TGT).map((t, i) => ({ ...t, id: String(50000 + i) }));
  const r = c.compareLists(src, tgt, "name", "name", "issueType");
  assert.ok(isClean(r), JSON.stringify(r.differences.map((d) => d.reason)));
  // Nested objects carry a site-specific self URL (statusCategory.self).
  const rs = c.compareLists(statusesSnapshot(SRC), statusesSnapshot(TGT), "name", "name", "status");
  assert.ok(isClean(rs), JSON.stringify(rs.differences.map((d) => d.reason)));
});

test("cross-site: a real nested change (status category) is still reported", () => {
  const c = makeComparator();
  const src = statusesSnapshot(SRC);
  const tgt = statusesSnapshot(TGT);
  tgt[0].statusCategory = { ...tgt[0].statusCategory, id: 3, key: "done", name: "Done" };
  const r = c.compareLists(src, tgt, "name", "name", "status");
  assert.equal(r.differences.length, 1, JSON.stringify(r.differences.map((d) => d.reason)));
  assert.match(r.differences[0].reason, /statusCategory/);
});

test("key order of the API response does not create differences", () => {
  const c = makeComparator();
  const src = [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }];
  const tgt = [{ outward: "blocks", inward: "is blocked by", name: "Blocks", id: "7" }];
  const r = c.compareLists(src, tgt, "name", "name", "linkType");
  assert.ok(isClean(r));
});

test("original scenario: Subtask with different ids matches; a different description is flagged", () => {
  const c = makeComparator();
  const src = [
    { id: 10003, name: "Subtask", description: "A subtask of a larger issue", iconUrl: `${SRC}/i.png` },
    { id: 10004, name: "Story", description: "User story", iconUrl: `${SRC}/s.png` },
    { id: 10024, name: "New Feature", description: "New feature request", iconUrl: `${SRC}/f.png` },
  ];
  const tgt = [
    { id: 10130, name: "Subtask", description: "A subtask of a larger issue", iconUrl: `${TGT}/i.png` },
    { id: 10045, name: "Task", description: "A task", iconUrl: `${TGT}/t.png` },
    { id: 10007, name: "Subtask", description: "Another subtask", iconUrl: `${TGT}/s2.png` },
    { id: 10083, name: "Story", description: "User story", iconUrl: `${TGT}/s.png` },
  ];
  const r = c.compareLists(src, tgt, "name", "name", "issueType");
  assert.deepEqual(r.missingInTarget.map((i) => i.name), ["New Feature"]);
  // The source has one Subtask and it matches the identical target Subtask exactly;
  // the second target Subtask has no source counterpart, so it is extra.
  assert.deepEqual(r.extraInTarget.map((i) => i.name).sort(), ["Subtask", "Task"]);
  assert.equal(r.extraInTarget.find((i) => i.name === "Subtask").description, "Another subtask");
  assert.equal(r.differences.length, 0);
});

// ---- whole report: self-compare of a full config snapshot ----

function fullSnapshot() {
  return {
    issueTypes: issueTypesSnapshot(),
    issueTypeSchemes: [
      { id: "10000", name: "Default Issue Type Scheme", description: "", isDefault: true },
    ],
    issueLinkTypes: [
      { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks", self: `${SRC}/x` },
    ],
    prioritySchemes: [{ id: "1", name: "Default priority scheme", isDefault: true }],
    priorities: [{ id: "1", name: "Highest", statusColor: "#d04437", iconUrl: `${SRC}/p.svg` }],
    issueHierarchy: [
      { projectKey: "ABC", projectName: "Alpha", projectType: "software" },
      { projectKey: "DEF", projectName: "Delta", projectType: "business" },
    ],
    sprintConfig: [
      { boardId: 1, boardName: "ABC board", boardType: "scrum", sprintConfig: {} },
      { boardId: 2, boardName: "ABC board", boardType: "kanban", sprintConfig: {} },
    ],
    timeTrackingConfig: {
      configuration: { workingDaysPerWeek: 5, workingHoursPerDay: 8, timeTrackingEnabled: true },
      options: { defaultUnit: "minute", timeFormat: "pretty" },
      list: null,
    },
    workflows: [
      { id: { name: "Software Simplified Workflow for Project ABC" }, name: "Software Simplified Workflow for Project ABC", description: "" },
      { id: { name: "Approval flow" }, name: "Approval flow", description: "One" },
      { id: { name: "approval flow" }, name: "approval flow", description: "Two" },
    ],
    workflowSchemes: [{ id: 1, name: "Default", description: "" }],
    customFields: [
      { id: "customfield_10001", key: "customfield_10001", name: "Team", schema: { type: "team" } },
      { id: "customfield_10002", key: "customfield_10002", name: "Team", schema: { type: "string" } },
    ],
    fieldConfigurations: [{ id: 1, name: "Default Field Configuration", description: "" }],
    screenSchemes: [{ id: 1, name: "Default Screen Scheme", description: "" }],
    permissionSchemes: [{ id: 1, name: "Default Permission Scheme", description: "" }],
    notificationSchemes: [{ id: 1, name: "Default Notification Scheme", description: "" }],
    issueSecuritySchemes: [],
    projectCategories: [{ id: "1", name: "Ops", description: "" }],
    resolutions: [{ id: "1", name: "Done", description: "" }],
    statuses: statusesSnapshot(),
    projectDataStats: {
      issueCounts: { ABC: 10, DEF: 0 },
      commentCounts: { ABC: 3, DEF: 0 },
      attachmentCounts: { ABC: 0, DEF: 0 },
      issueLinkCounts: { ABC: 1, DEF: 0 },
    },
  };
}

function reportFor(source, target, options = { summary: true }) {
  const c = makeComparator(options);
  c.sourceConfig = source;
  c.targetConfig = target;
  return c.generateComparisonReport();
}

test("full report: a site compared with itself reports every section identical", () => {
  const snap = fullSnapshot();
  const report = reportFor(snap, clone(snap), {});
  assert.doesNotMatch(report, /DIFFERENCES \(/);
  assert.doesNotMatch(report, /MISSING IN TARGET \(/);
  assert.doesNotMatch(report, /Differences found/);
  assert.match(report, /Different configurations: 0/);
  assert.match(report, /No critical issues detected/);
  assert.doesNotMatch(report, /BOARDS MISSING/);
});

test("full report positive control: one changed field is reported and the summary agrees", () => {
  const snap = fullSnapshot();
  const target = clone(snap);
  target.issueTypes.find((t) => t.id === "10602").description = "Changed after migration";
  const report = reportFor(snap, target, {});
  assert.match(report, /Issue Types: Differences found/);
  assert.match(report, /Different configurations: 1/);
  // "Bug" is a critical issue type: the critical summary must not claim there is nothing critical.
  assert.match(report, /CRITICAL DIFFERENCES \(1 items\)/);
  assert.doesNotMatch(report, /No critical issues detected/);
  assert.match(report, /1 CRITICAL difference/);
});

test("sprint boards: a missing board that shares its name with another board is reported", () => {
  const snap = fullSnapshot();
  const target = clone(snap);
  target.sprintConfig = target.sprintConfig.slice(0, 1);
  const report = reportFor(snap, target, {});
  assert.match(report, /BOARDS MISSING IN TARGET/);
  assert.match(report, /ABC board \(kanban\)/);
});

test("sprint boards: same count but a renamed board is reported", () => {
  const snap = fullSnapshot();
  const target = clone(snap);
  target.sprintConfig[1].boardName = "XYZ board";
  const report = reportFor(snap, target, {});
  assert.match(report, /BOARDS MISSING IN TARGET/);
  assert.match(report, /EXTRA BOARDS IN TARGET/);
});

// ---- added after independent review ----

test("scope: a missing site-wide item is not hidden by pairing it with a team-managed one", () => {
  const c = makeComparator();
  const types = issueTypesSnapshot().filter((t) => t.name === "Bug"); // 1 global + 2 scoped
  const tgt = clone(types).filter((t) => t.scope);
  tgt.push({ ...clone(types[1]), id: "10699", scope: { type: "PROJECT", project: { id: "11899" } }, description: "Third team" });
  const r = c.compareLists(types, tgt, "name", "name", "issueType");
  assert.deepEqual(r.missingInTarget.map((i) => i.id), ["1"]);
  assert.deepEqual(r.extraInTarget.map((i) => i.id), ["10699"]);
  assert.equal(r.differences.length, 0);
});

test("nested key order of the API response does not create differences", () => {
  const c = makeComparator();
  const src = [{ id: "1", name: "Open", statusCategory: { id: 2, key: "new", colorName: "blue-gray" } }];
  const tgt = [{ id: "1", name: "Open", statusCategory: { colorName: "blue-gray", key: "new", id: 2 } }];
  assert.ok(isClean(c.compareLists(src, tgt, "name", "name", "status")));
  assert.equal(c.stableStringify({ b: 1, a: { d: 1, c: 2 } }), c.stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
});

test("--ignore-descriptions: a description-only change is not a difference, other fields still are", () => {
  const c = makeComparator({ ignoreDescriptions: true });
  const src = [{ id: "1", name: "Highest", description: "Top", statusColor: "#d04437" }];
  const descOnly = [{ id: "1", name: "Highest", description: "Changed", statusColor: "#d04437" }];
  assert.ok(isClean(c.compareLists(src, descOnly, "name", "name", "priority")));
  const colour = [{ id: "1", name: "Highest", description: "Changed", statusColor: "#ff0000" }];
  const r = c.compareLists(src, colour, "name", "name", "priority");
  assert.equal(r.differences.length, 1);
  assert.doesNotMatch(r.differences[0].reason, /description/);
});

// Real Cloud shapes (checked on a live site 2026-11-06)
const timeTracking = () => ({
  configuration: { key: "JIRA", name: "JIRA provided time tracking" },
  options: { workingHoursPerDay: 8.0, workingDaysPerWeek: 5.0, timeFormat: "pretty", defaultUnit: "hour" },
  list: [{ key: "JIRA", name: "JIRA provided time tracking" }],
});

test("time tracking: identical settings are identical; a real change is reported in section and summary", () => {
  const snap = fullSnapshot();
  snap.timeTrackingConfig = timeTracking();
  let report = reportFor(snap, clone(snap), {});
  assert.match(report, /Time tracking settings are identical/);
  assert.doesNotMatch(report, /Time Tracking Configuration: Differences found/);

  const target = clone(snap);
  target.timeTrackingConfig.options.workingHoursPerDay = 7.5;
  target.timeTrackingConfig.configuration = { key: "is.origo.jira.tempo-plugin__timetracking-provider", name: "Tempo" };
  report = reportFor(snap, target, {});
  assert.match(report, /workingHoursPerDay:\n\s+Source: 8\n\s+Target: 7.5/);
  assert.match(report, /selected provider:/);
  assert.match(report, /Time Tracking Configuration: Differences found/);
});

test("projects: target-only projects stop the 'identical' line", () => {
  const snap = fullSnapshot();
  const target = clone(snap);
  target.issueHierarchy.push({ projectKey: "XYZ", projectName: "Extra", projectType: "software" });
  const report = reportFor(snap, target, {});
  assert.doesNotMatch(report, /Project hierarchies are identical/);
  assert.match(reportFor(snap, clone(snap), {}), /Project hierarchies are identical/);
});

test("twins: a change on one of several identical items is attributed to the right id", () => {
  const c = makeComparator();
  const twin = (id, p) => ({ id, name: "Bug", description: "", scope: { type: "PROJECT", project: { id: p } } });
  const src = [twin("10652", "1"), twin("10700", "2"), twin("10701", "3")];
  const tgt = clone(src);
  tgt[0].description = "changed";
  const r = c.compareLists(src, tgt, "name", "name", "issueType");
  assert.equal(r.differences.length, 1);
  assert.equal(r.differences[0].sourceId, "10652");
  assert.equal(r.differences[0].targetId, "10652");
});
