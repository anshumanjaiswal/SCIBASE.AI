const assert = require("assert");
const {
  DEFAULT_POLICY,
  SAMPLE_CONNECTORS,
  compareVersions,
  evaluateConnector,
  summarize,
} = require("./index");

function runTests() {
  assert.strictEqual(compareVersions("2026.02", "2025.10") > 0, true);
  assert.strictEqual(compareVersions("2025.10", "2025.10"), 0);
  assert.strictEqual(compareVersions("2025.05", "2025.10") < 0, true);

  const results = SAMPLE_CONNECTORS.map((connector) => evaluateConnector(connector, DEFAULT_POLICY));
  const byId = Object.fromEntries(results.map((result) => [result.connectorId, result]));

  assert.strictEqual(byId["dspace-repository-prod"].status, "certified");
  assert.strictEqual(byId["dspace-repository-prod"].blockers.length, 0);
  assert.match(byId["dspace-repository-prod"].governanceEvent.signature, /^[a-f0-9]{64}$/);

  assert.strictEqual(byId["journal-export-beta"].status, "conditional");
  assert.ok(byId["journal-export-beta"].warnings.some((warning) => warning.includes("Runbook")));
  assert.ok(byId["journal-export-beta"].warnings.some((warning) => warning.includes("metadata")));

  assert.strictEqual(byId["eln-human-subjects-sync"].status, "blocked");
  assert.ok(byId["eln-human-subjects-sync"].blockers.some((blocker) => blocker.includes("Wildcard")));
  assert.ok(byId["eln-human-subjects-sync"].blockers.some((blocker) => blocker.includes("data-processing")));
  assert.ok(byId["eln-human-subjects-sync"].blockers.some((blocker) => blocker.includes("IRB")));

  const summary = summarize(results);
  assert.deepStrictEqual(
    {
      total: summary.total,
      certified: summary.certified,
      conditional: summary.conditional,
      blocked: summary.blocked,
    },
    {
      total: 3,
      certified: 1,
      conditional: 1,
      blocked: 1,
    },
  );
  assert.deepStrictEqual(summary.highRisk, ["eln-human-subjects-sync"]);

  console.log("enterprise-connector-certification-gate tests passed");
}

runTests();
