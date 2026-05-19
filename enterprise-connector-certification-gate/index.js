const crypto = require("crypto");

const DEFAULT_REFERENCE_DATE = "2026-05-19T00:00:00.000Z";

const DEFAULT_POLICY = {
  referenceDate: DEFAULT_REFERENCE_DATE,
  allowedScopes: {
    dspace: ["project:read", "publication:read", "dataset:read", "deposit:write"],
    canvas: ["course:read", "assignment:read", "gradebook:write"],
    eln: ["experiment:read", "inventory:read", "review:write"],
    orcid: ["profile:read", "work:write"],
    journal: ["manuscript:write", "metadata:read", "status:read"],
    funder: ["grant:read", "report:write", "compliance:read"],
  },
  requiredWebhookEvents: {
    dspace: ["project.created", "publication.published", "dataset.updated"],
    canvas: ["project.created", "review.completed"],
    eln: ["project.created", "reproducibility.scored"],
    orcid: ["publication.published"],
    journal: ["publication.published", "review.completed"],
    funder: ["publication.published", "compliance.changed"],
  },
  requiredExportFormats: {
    dspace: ["repository-package", "datacite-json"],
    journal: ["jats", "docx"],
    funder: ["funder-report-json"],
  },
  maxSuccessfulSmokeAgeDays: 30,
  minSuccessfulSmokeRuns: 2,
  minApiVersion: "2025.10",
  deprecationWarningDays: 90,
  signingSecret: "synthetic-review-secret",
};

function daysBetween(leftIso, rightIso) {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  return Math.floor(Math.abs(right - left) / 86400000);
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  const max = Math.max(a.length, b.length);

  for (let index = 0; index < max; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex");
}

function includesAll(actual, required) {
  return required.every((item) => actual.includes(item));
}

function evaluateConnector(connector, policy = DEFAULT_POLICY) {
  const blockers = [];
  const warnings = [];
  const actions = [];
  let score = 100;

  const allowedScopes = policy.allowedScopes[connector.type] || [];
  const requestedScopes = connector.requestedScopes || [];
  const unexpectedScopes = requestedScopes.filter((scope) => !allowedScopes.includes(scope));

  if (unexpectedScopes.length > 0) {
    blockers.push(`Unexpected API scopes requested: ${unexpectedScopes.join(", ")}`);
    actions.push("Reduce requested scopes to approved least-privilege connector scopes.");
    score -= 24;
  }

  if (requestedScopes.includes("*") && connector.dataClasses.includes("restricted")) {
    blockers.push("Wildcard API scope is not allowed for restricted-data connectors.");
    actions.push("Replace wildcard access with explicit read/write scopes.");
    score -= 30;
  }

  const successfulRuns = connector.sandboxRuns.filter((run) => run.result === "success");
  const latestSuccess = successfulRuns
    .map((run) => run.finishedAt)
    .sort()
    .at(-1);

  if (successfulRuns.length < policy.minSuccessfulSmokeRuns) {
    blockers.push(`Only ${successfulRuns.length} successful sandbox smoke run(s) found.`);
    actions.push("Attach at least two successful sandbox smoke runs before enabling production.");
    score -= 20;
  } else if (daysBetween(latestSuccess, policy.referenceDate) > policy.maxSuccessfulSmokeAgeDays) {
    warnings.push(`Latest sandbox smoke run is older than ${policy.maxSuccessfulSmokeAgeDays} days.`);
    actions.push("Refresh sandbox smoke evidence before final production approval.");
    score -= 8;
  }

  if (compareVersions(connector.apiVersion, policy.minApiVersion) < 0) {
    blockers.push(`Connector API version ${connector.apiVersion} is below required ${policy.minApiVersion}.`);
    actions.push("Upgrade connector API contract before certification.");
    score -= 22;
  }

  if (connector.deprecatesAt) {
    const daysUntilDeprecation = daysBetween(connector.deprecatesAt, policy.referenceDate);
    if (new Date(connector.deprecatesAt) < new Date(policy.referenceDate)) {
      blockers.push("Connector API version is already past its deprecation date.");
      actions.push("Move traffic to a supported connector version.");
      score -= 24;
    } else if (daysUntilDeprecation <= policy.deprecationWarningDays) {
      warnings.push(`Connector API version deprecates in ${daysUntilDeprecation} days.`);
      actions.push("Schedule a migration before institutional launch.");
      score -= 8;
    }
  }

  const requiredEvents = policy.requiredWebhookEvents[connector.type] || [];
  const missingEvents = requiredEvents.filter((event) => !connector.webhookEvents.includes(event));

  if (missingEvents.length > 0) {
    blockers.push(`Missing required webhook events: ${missingEvents.join(", ")}`);
    actions.push("Add webhook coverage for required institutional events.");
    score -= 18;
  }

  const requiredFormats = policy.requiredExportFormats[connector.type] || [];
  const missingFormats = requiredFormats.filter((format) => !connector.exportFormats.includes(format));

  if (missingFormats.length > 0) {
    blockers.push(`Missing export formats: ${missingFormats.join(", ")}`);
    actions.push("Add target-specific export packaging before certification.");
    score -= 18;
  }

  if (connector.dataClasses.includes("restricted")) {
    if (!connector.controls.dpaSigned) {
      blockers.push("Restricted-data connector lacks data-processing agreement evidence.");
      actions.push("Attach DPA evidence before restricted-data enablement.");
      score -= 22;
    }

    if (!connector.controls.regionPinned) {
      blockers.push("Restricted-data connector is not pinned to an approved data region.");
      actions.push("Configure regional routing controls for restricted data.");
      score -= 16;
    }
  }

  if (connector.dataClasses.includes("human-subjects") && !connector.controls.irbReference) {
    blockers.push("Human-subjects connector lacks IRB/reference evidence.");
    actions.push("Attach IRB protocol or exemption reference.");
    score -= 16;
  }

  const missingOwners = ["technicalOwner", "businessOwner", "escalationChannel"].filter(
    (field) => !connector.owners[field],
  );

  if (missingOwners.length > 0) {
    blockers.push(`Missing owner coverage: ${missingOwners.join(", ")}`);
    actions.push("Assign technical, business, and escalation ownership.");
    score -= 14;
  }

  const missingRunbookItems = ["rollback", "retry", "deadLetter", "supportWindow"].filter(
    (item) => !connector.runbook[item],
  );

  if (missingRunbookItems.length > 0) {
    warnings.push(`Runbook is missing: ${missingRunbookItems.join(", ")}`);
    actions.push("Complete operational runbook before broad rollout.");
    score -= 8;
  }

  if (!includesAll(connector.metadataPreservation, ["doi", "orcid", "version-history"])) {
    warnings.push("Export metadata preservation is incomplete.");
    actions.push("Preserve DOI, ORCID, and version-history fields in export payloads.");
    score -= 8;
  }

  const riskTier = score >= 85 ? "low" : score >= 65 ? "medium" : "high";
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "conditional" : "certified";
  const evidence = {
    connectorId: connector.id,
    status,
    riskTier,
    score: Math.max(0, score),
    blockerCount: blockers.length,
    warningCount: warnings.length,
    latestSuccessfulSmokeRun: latestSuccess || null,
    digest: stableHash({
      id: connector.id,
      status,
      riskTier,
      score,
      blockers,
      warnings,
      actions,
    }),
  };

  return {
    connectorId: connector.id,
    name: connector.name,
    type: connector.type,
    institution: connector.institution,
    status,
    riskTier,
    score: Math.max(0, score),
    blockers,
    warnings,
    actions: [...new Set(actions)],
    dashboardFacts: {
      owner: connector.owners.businessOwner || connector.owners.technicalOwner || "unassigned",
      dataClasses: connector.dataClasses,
      requestedScopes,
      webhookCoverage: `${connector.webhookEvents.length}/${requiredEvents.length}`,
      exportFormats: connector.exportFormats,
    },
    governanceEvent: signGovernanceEvent(evidence, policy.signingSecret),
  };
}

function signGovernanceEvent(evidence, secret) {
  const body = {
    type: "enterprise.connector.certification",
    emittedAt: DEFAULT_REFERENCE_DATE,
    evidence,
  };

  return {
    ...body,
    signature: crypto.createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex"),
  };
}

function summarize(results) {
  return {
    total: results.length,
    certified: results.filter((result) => result.status === "certified").length,
    conditional: results.filter((result) => result.status === "conditional").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    highRisk: results.filter((result) => result.riskTier === "high").map((result) => result.connectorId),
    nextActions: results.flatMap((result) =>
      result.actions.map((action) => ({
        connectorId: result.connectorId,
        action,
      })),
    ),
  };
}

const SAMPLE_CONNECTORS = [
  {
    id: "dspace-repository-prod",
    name: "DSpace Repository Deposit",
    type: "dspace",
    institution: "Northbridge University",
    requestedScopes: ["project:read", "publication:read", "dataset:read", "deposit:write"],
    apiVersion: "2026.02",
    deprecatesAt: "2027-01-31T00:00:00.000Z",
    sandboxRuns: [
      { id: "smoke-101", result: "success", finishedAt: "2026-05-10T10:15:00.000Z" },
      { id: "smoke-102", result: "success", finishedAt: "2026-05-18T14:30:00.000Z" },
    ],
    webhookEvents: ["project.created", "publication.published", "dataset.updated"],
    exportFormats: ["repository-package", "datacite-json"],
    dataClasses: ["public", "controlled"],
    controls: {
      dpaSigned: true,
      regionPinned: true,
      irbReference: null,
    },
    owners: {
      technicalOwner: "repository-platform",
      businessOwner: "library-scholarly-communications",
      escalationChannel: "#institutional-repository-alerts",
    },
    runbook: {
      rollback: true,
      retry: true,
      deadLetter: true,
      supportWindow: true,
    },
    metadataPreservation: ["doi", "orcid", "version-history", "license"],
  },
  {
    id: "journal-export-beta",
    name: "Journal Submission Export",
    type: "journal",
    institution: "Helix Research Institute",
    requestedScopes: ["manuscript:write", "metadata:read", "status:read"],
    apiVersion: "2025.12",
    deprecatesAt: "2026-07-15T00:00:00.000Z",
    sandboxRuns: [
      { id: "journal-smoke-44", result: "success", finishedAt: "2026-05-01T08:00:00.000Z" },
      { id: "journal-smoke-45", result: "success", finishedAt: "2026-05-02T08:00:00.000Z" },
    ],
    webhookEvents: ["publication.published", "review.completed"],
    exportFormats: ["jats", "docx"],
    dataClasses: ["public"],
    controls: {
      dpaSigned: true,
      regionPinned: true,
      irbReference: null,
    },
    owners: {
      technicalOwner: "publication-integrations",
      businessOwner: "research-office",
      escalationChannel: "#journal-export-ops",
    },
    runbook: {
      rollback: true,
      retry: true,
      deadLetter: false,
      supportWindow: true,
    },
    metadataPreservation: ["doi", "orcid"],
  },
  {
    id: "eln-human-subjects-sync",
    name: "ELN Human Subjects Sync",
    type: "eln",
    institution: "Cedar Clinical Lab",
    requestedScopes: ["experiment:read", "inventory:read", "*"],
    apiVersion: "2025.05",
    deprecatesAt: "2026-04-01T00:00:00.000Z",
    sandboxRuns: [{ id: "eln-smoke-7", result: "success", finishedAt: "2026-04-10T09:00:00.000Z" }],
    webhookEvents: ["project.created"],
    exportFormats: [],
    dataClasses: ["restricted", "human-subjects"],
    controls: {
      dpaSigned: false,
      regionPinned: false,
      irbReference: null,
    },
    owners: {
      technicalOwner: "",
      businessOwner: "clinical-ops",
      escalationChannel: "",
    },
    runbook: {
      rollback: true,
      retry: false,
      deadLetter: false,
      supportWindow: false,
    },
    metadataPreservation: ["orcid"],
  },
];

module.exports = {
  DEFAULT_POLICY,
  SAMPLE_CONNECTORS,
  compareVersions,
  evaluateConnector,
  summarize,
};
