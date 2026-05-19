const { DEFAULT_POLICY, SAMPLE_CONNECTORS, evaluateConnector, summarize } = require("./index");

const results = SAMPLE_CONNECTORS.map((connector) => evaluateConnector(connector, DEFAULT_POLICY));
const report = {
  generatedAt: DEFAULT_POLICY.referenceDate,
  module: "enterprise-connector-certification-gate",
  summary: summarize(results),
  certificationQueue: results.map((result) => ({
    connectorId: result.connectorId,
    name: result.name,
    institution: result.institution,
    status: result.status,
    riskTier: result.riskTier,
    score: result.score,
    blockers: result.blockers,
    warnings: result.warnings,
    nextActions: result.actions,
    dashboardFacts: result.dashboardFacts,
    eventSignature: result.governanceEvent.signature,
  })),
};

console.log(JSON.stringify(report, null, 2));
