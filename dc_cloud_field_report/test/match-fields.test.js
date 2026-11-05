// Regression tests for the DC -> Cloud field matcher (run: npm test).
// Same flaw as the config comparator (2026-11-03): items were matched by name only,
// so same-named fields collided.
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchFields } = require("../field_report.js");

const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";
const TEXT = "com.atlassian.jira.plugin.system.customfieldtypes:textfield";
const f = (id, name, custom) => ({ id, name, custom: true, schema: { type: "string", custom } });

test("self-match: the same field list on both sides maps every field to itself", () => {
  const fields = [f("customfield_1", "Team", SELECT), f("customfield_2", "Team", TEXT), f("customfield_3", "Vendor", TEXT)];
  const { mapped, unmapped } = matchFields(fields, fields);
  assert.equal(unmapped.length, 0);
  assert.deepEqual(mapped.map((r) => [r.dcId, r.cloudId]).sort(), [
    ["customfield_1", "customfield_1"], ["customfield_2", "customfield_2"], ["customfield_3", "customfield_3"],
  ]);
  assert.ok(mapped.every((r) => !/field type differs/.test(r.note)));
});

test("positive control: a same-named DC field with no Cloud counterpart of its own is unmapped", () => {
  const dc = [f("customfield_1", "Team", SELECT), f("customfield_2", "Team", TEXT)];
  const cloud = [f("customfield_10100", "Team", TEXT)];
  const { mapped, unmapped } = matchFields(dc, cloud);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].dcId, "customfield_2"); // same type wins the only Cloud field
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].dcId, "customfield_1");
  assert.match(unmapped[0].reason, /already matched/);
});

test("positive control: a field missing on Cloud is still reported", () => {
  const { unmapped } = matchFields([f("customfield_9", "Severity", SELECT)], [f("customfield_1", "Team", SELECT)]);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].reason, "No Cloud custom field with a matching name");
});

test("(migrated) suffix fallback still matches, and a type change is flagged", () => {
  const { mapped } = matchFields([f("customfield_5", "Region", SELECT)], [f("customfield_77", "Region (migrated)", TEXT)]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].how, "name (ignoring (migrated))");
  assert.match(mapped[0].note, /field type differs/);
});

test("exact-name matches are not stolen by a (migrated) fallback", () => {
  const dc = [f("customfield_1", "Region (migrated)", SELECT), f("customfield_2", "Region", SELECT)];
  const cloud = [f("customfield_10", "Region", SELECT)];
  const { mapped, unmapped } = matchFields(dc, cloud);
  assert.deepEqual(mapped.map((r) => r.dcId), ["customfield_2"]);
  assert.deepEqual(unmapped.map((r) => r.dcId), ["customfield_1"]);
});
