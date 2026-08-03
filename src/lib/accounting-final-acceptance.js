'use strict';

const crypto = require('crypto');
const decimal = require('./accounting-decimal');
const saleSnapshot = require('./sale-snapshot');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const readiness = require('./accounting-evidence-confidence');
const operational = require('./accounting-operational-review');
const profitLedger = require('./profit-commission-ledger');
const { normalizeJalaliDate } = require('./jalali-date');
const { APP_VERSION } = require('./app-version');

const SESSIONS = 'accountingReviewSessions';
const COMPARISON_IMPORTS = 'accountingComparisonImports';
const COMPARISON_ROWS = 'accountingComparisonRows';
const COMPARISON_RUNS = 'accountingComparisonRuns';
const COMPARISON_DIFFERENCES = 'accountingComparisonDifferences';
const FAT_DEFINITIONS = 'fatDefinitions';
const FAT_RUNS = 'fatRuns';
const FAT_EVIDENCE = 'fatEvidence';
const FAT_DIFFERENCES = 'fatDifferences';
const FAT_APPROVALS = 'fatApprovals';

const OWNED_COLLECTIONS = Object.freeze([
  SESSIONS,
  COMPARISON_IMPORTS,
  COMPARISON_ROWS,
  COMPARISON_RUNS,
  COMPARISON_DIFFERENCES,
  FAT_DEFINITIONS,
  FAT_RUNS,
  FAT_EVIDENCE,
  FAT_DIFFERENCES,
  FAT_APPROVALS
]);

const SCHEMA_VERSION = 1;
const MODULE_VERSION = 'accounting-final-acceptance-1.0.0';
const FAT_VERSION = 'fat-2.0.0';
const COMPARISON_VERSION = 'accounting-comparison-1.0.0';
const SESSION_STATUSES = Object.freeze([
  'prepared', 'in_progress', 'waiting_evidence',
  'ready_for_manager_review', 'completed', 'cancelled'
]);
const FAT_RUN_STATUSES = Object.freeze([
  'prepared', 'running', 'passed', 'passed_with_tolerance', 'failed',
  'blocked_missing_evidence', 'blocked_human_review', 'cancelled'
]);
const DIFFERENCE_TYPES = Object.freeze([
  'missing_in_crm', 'missing_in_reference', 'invoice_mapping_difference',
  'line_mapping_difference', 'quantity_difference', 'sale_amount_difference',
  'cost_difference', 'rounding_difference', 'return_linkage_difference',
  'date_normalization_difference', 'seller_mapping_difference',
  'duplicate_reference_row', 'duplicate_crm_row', 'unknown_cost',
  'unresolved_evidence', 'expected_scope_difference', 'unexplained_difference'
]);
const LOGICAL_FIELDS = Object.freeze([
  'sellerIdentity', 'invoiceType', 'invoiceNumber', 'invoiceDate', 'lineIdentity',
  'itemCode', 'quantity', 'saleAmount', 'purchaseCost', 'costOfGoodsSold',
  'grossProfit', 'saleReturnAmount', 'purchaseReturnImpact', 'commission'
]);
const DEFAULT_REQUIRED_MAPPING = Object.freeze([
  'invoiceType', 'invoiceNumber', 'invoiceDate', 'itemCode', 'quantity', 'saleAmount'
]);
const MONEY_FIELDS = new Set([
  'saleAmount', 'purchaseCost', 'costOfGoodsSold', 'grossProfit',
  'saleReturnAmount', 'purchaseReturnImpact', 'commission'
]);
const HUMAN_DECISIONS = new Set([
  'accounting_confirmed', 'accounting_disputed', 'needs_evidence',
  'confirmed_linked', 'confirmed_unmatched', 'deferred', 'rejected'
]);
const ALLOWED_ROLES = Object.freeze(['admin', 'accounting', 'manager']);
const MAX_SOURCE_BYTES = 3_000_000;
const MAX_ROW_BATCH = 1000;
const readinessSummaryInFlight = new Map();

function clean(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function finite(value) {
  const number = Number(String(value ?? '').replace(/[,،\s]/g, ''));
  return Number.isFinite(number) ? number : 0;
}
function round(value, scale = 2) {
  const factor = 10 ** scale;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
function percentage(part, total) {
  return total > 0 ? round(Number(part) * 100 / Number(total), 2) : 0;
}
function actor(value = {}) {
  return {
    username:clean(value.username || value.user || 'system', 100),
    role:clean(value.role || 'system', 50)
  };
}
function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function requireRole(value, allowed = ALLOWED_ROLES) {
  const current = actor(value);
  if (!allowed.includes(current.role)) {
    fail('ACCOUNTING_FAT_FORBIDDEN', 'دسترسی به پذیرش نهایی حسابداری مجاز نیست.', 403);
  }
  return current;
}
function deterministicId(prefix, material) {
  return `${prefix}-${crypto.createHash('sha256').update(String(material)).digest('hex').slice(0, 24)}`;
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function boundedObject(value, maxKeys = 60, maxValue = 3000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, maxKeys).map(([name, item]) => [
    clean(name, 100),
    clean(typeof item === 'object' ? stable(item) : item, maxValue)
  ]));
}
function audit(action, by, details = {}) {
  return {
    action:clean(action, 100),
    by:actor(by),
    details:boundedObject(details),
    at:new Date()
  };
}
async function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
function exact(value, scale) {
  return decimal.format(decimal.parse(value || 0, scale), scale);
}
function exactMoney(value) {
  return exact(value, decimal.MONEY_SCALE);
}
function exactQuantity(value) {
  return exact(value, decimal.QUANTITY_SCALE);
}
function environmentCommit(input = {}) {
  return clean(input.gitSha || process.env.GIT_COMMIT || process.env.COMMIT_SHA || '', 128);
}

const FAT_SCENARIOS = Object.freeze([
  {
    scenarioCode:'FAT-01', title:'Sale reconciliation', purpose:'Reconcile sale totals against an approved reference.',
    requiredInputs:['frozen-sale-snapshot', 'approved-accounting-reference'],
    expectedInvariants:['invoice-count-exact', 'line-count-exact', 'quantity-exact', 'gross-sale-exact', 'discount-exact', 'sale-return-exact', 'net-sale-exact'],
    tolerance:{ counts:'exact', quantities:'fixed-scale-exact', irr:'exact-integer' },
    blockingSeverity:'critical', approvalRequirements:['accounting', 'manager'], evidenceRequirements:['comparison-run', 'difference-review']
  },
  {
    scenarioCode:'FAT-02', title:'FIFO allocation reconciliation', purpose:'Reconcile every allocation and remaining layer.',
    requiredInputs:['frozen-fifo-dataset', 'approved-accounting-reference'],
    expectedInvariants:['purchase-source', 'allocated-quantity', 'unit-cost', 'allocation-cost', 'unknown-quantity', 'layer-remaining'],
    tolerance:{ counts:'exact', quantities:'fixed-scale-exact', irr:'exact', unitCost:'documented-source-precision-only' },
    blockingSeverity:'critical', approvalRequirements:['accounting', 'manager'], evidenceRequirements:['allocation-samples', 'comparison-run']
  },
  {
    scenarioCode:'FAT-03', title:'Seller Performance reconciliation', purpose:'Reconcile seller-level operational and financial totals.',
    requiredInputs:['frozen-sale-snapshot', 'approved-accounting-reference'],
    expectedInvariants:['seller-identity', 'invoice-count', 'line-count', 'quantity', 'gross-sales', 'returns', 'net-sales', 'cogs-when-enabled', 'gross-profit-when-enabled'],
    tolerance:{ counts:'exact', quantities:'fixed-scale-exact', irr:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting', 'manager'], evidenceRequirements:['seller-comparison']
  },
  {
    scenarioCode:'FAT-04', title:'Manual Cost', purpose:'Validate evidence, effective dates, priority and separation of duties.',
    requiredInputs:['manual-cost-workflow-if-present'],
    expectedInvariants:['documented-source', 'date-effective', 'creator-approver-separated', 'official-layer-priority', 'audit-complete'],
    tolerance:{ counts:'exact', irr:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting', 'manager'], evidenceRequirements:['manual-cost-audit']
  },
  {
    scenarioCode:'FAT-05', title:'Sale Return', purpose:'Validate original-sale and cost reversal treatment.',
    requiredInputs:['sale-return-review'],
    expectedInvariants:['original-link', 'quantity-reversal', 'cost-reversal', 'partial-return-bounded', 'unresolved-explicit'],
    tolerance:{ quantities:'fixed-scale-exact', irr:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting'], evidenceRequirements:['return-audit', 'allocation-comparison']
  },
  {
    scenarioCode:'FAT-06', title:'Purchase Return', purpose:'Validate layer reduction and unmatched treatment.',
    requiredInputs:['purchase-return-review'],
    expectedInvariants:['purchase-layer-link', 'quantity-reduction', 'no-negative-layer', 'unmatched-explicit'],
    tolerance:{ quantities:'fixed-scale-exact', irr:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting'], evidenceRequirements:['return-audit', 'layer-comparison']
  },
  {
    scenarioCode:'FAT-07', title:'Determinism', purpose:'Prove identical replay for identical frozen inputs.',
    requiredInputs:['two-completed-shadow-runs'],
    expectedInvariants:['source-fingerprint-identical', 'allocation-fingerprint-identical', 'totals-identical', 'exception-count-identical'],
    tolerance:{ fingerprints:'exact', counts:'exact', quantities:'exact', irr:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting'], evidenceRequirements:['deterministic-peer']
  },
  {
    scenarioCode:'FAT-08', title:'Recovery', purpose:'Validate bounded recovery from operational interruptions.',
    requiredInputs:['recovery-evidence'],
    expectedInvariants:['pm2-recovery', 'host-reboot-recovery', 'network-recovery', 'timeout-retry', 'candidate-resume'],
    tolerance:{ counts:'exact' },
    blockingSeverity:'high', approvalRequirements:['manager'], evidenceRequirements:['job-audit', 'runtime-evidence']
  },
  {
    scenarioCode:'FAT-09', title:'Atomic activation', purpose:'Prove failed candidates cannot displace the active dataset.',
    requiredInputs:['dataset-state'],
    expectedInvariants:['failed-inactive', 'completed-with-errors-inactive', 'previous-active-readable', 'success-atomic'],
    tolerance:{ counts:'exact' },
    blockingSeverity:'critical', approvalRequirements:['accounting'], evidenceRequirements:['dataset-state-audit']
  },
  {
    scenarioCode:'FAT-10', title:'Performance and stability', purpose:'Validate bounded production-like operation on staging.',
    requiredInputs:['runtime-telemetry'],
    expectedInvariants:['no-crash', 'no-uncontrolled-restart', 'no-memory-leak', 'bounded-event-loop', 'report-latency', 'no-duplicate-jobs'],
    tolerance:{ runtime:'scenario-specific-documented' },
    blockingSeverity:'high', approvalRequirements:['manager'], evidenceRequirements:['pm2-metrics', 'query-plans']
  },
  {
    scenarioCode:'FAT-11', title:'Backup and rollback', purpose:'Validate restoration and rollback evidence.',
    requiredInputs:['backup-evidence', 'source-sha', 'rollback-procedure'],
    expectedInvariants:['backup-exists', 'sha-recorded', 'mongo-restore-documented', 'pm2-rollback-documented', 'dataset-pointer-rollback-documented'],
    tolerance:{ counts:'exact' },
    blockingSeverity:'critical', approvalRequirements:['manager'], evidenceRequirements:['backup-manifest', 'rollback-runbook']
  },
  {
    scenarioCode:'FAT-12', title:'Security and authorization', purpose:'Validate accounting authorization boundaries.',
    requiredInputs:['authorization-tests', 'authenticated-role-validation'],
    expectedInvariants:['seller-denied', 'creator-approver-separated', 'unauthorized-rejected', 'reference-import-cannot-approve'],
    tolerance:{ authorization:'exact' },
    blockingSeverity:'critical', approvalRequirements:['manager'], evidenceRequirements:['http-audit', 'permission-tests']
  },
  {
    scenarioCode:'FAT-13', title:'Actual FIFO profit immutability', purpose:'Prove copied FIFO profit facts remain immutable and unknown cost is not zero.',
    requiredInputs:['validated-shadow-fifo', 'fifo-profit-facts'], expectedInvariants:['source-validated-shadow', 'fact-content-hash', 'no-manual-overwrite', 'unknown-cost-null'],
    tolerance:{ irr:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['fact-fingerprint','immutability-test']
  },
  {
    scenarioCode:'FAT-14', title:'Profit adjustment workflow', purpose:'Validate pending-only human edits and creator/approver separation.',
    requiredInputs:['profit-adjustment-workflow'], expectedInvariants:['draft-pending-approved', 'creator-approver-separated', 'revision-locked', 'no-physical-delete'],
    tolerance:{ status:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['adjustment-audit']
  },
  {
    scenarioCode:'FAT-15', title:'Saved-profit double-entry balance', purpose:'Reconcile append-only debit and credit entries to derived pool balances.',
    requiredInputs:['saved-profit-ledger'], expectedInvariants:['entry-balanced', 'balance-derived', 'append-only', 'historically-reproducible'],
    tolerance:{ irr:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['ledger-reconciliation']
  },
  {
    scenarioCode:'FAT-16', title:'Notebook/Component pool isolation', purpose:'Prove saved-profit reserves cannot cross pools.',
    requiredInputs:['saved-profit-ledger'], expectedInvariants:['notebook-isolated', 'component-isolated', 'cross-pool-rejected', 'no-negative-balance'],
    tolerance:{ irr:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['pool-isolation-test']
  },
  {
    scenarioCode:'FAT-17', title:'Versioned commission-rate resolution', purpose:'Validate historical, exceptional and missing rate handling.',
    requiredInputs:['commission-rate-versions'], expectedInvariants:['effective-period', 'no-approved-overlap', 'exception-supported', 'missing-unavailable'],
    tolerance:{ rate:'fixed-scale-exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['rate-resolution-report']
  },
  {
    scenarioCode:'FAT-18', title:'Invoice discount reconciliation', purpose:'Prove discounts originate from official invoice fields without guessed allocation.',
    requiredInputs:['invoice-discount-facts'], expectedInvariants:['official-source-field', 'immutable-fact', 'multi-category-unresolved', 'workbook-total-not-authoritative'],
    tolerance:{ irr:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['discount-reconciliation']
  },
  {
    scenarioCode:'FAT-19', title:'Editable Excel export/import integrity', purpose:'Validate immutable hashes and pending-only accounting edits.',
    requiredInputs:['excel-export-import-audit'], expectedInvariants:['batch-hash', 'row-hash', 'identity-protected', 'pending-only', 'formula-errors-rejected'],
    tolerance:{ hashes:'exact' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['excel-roundtrip-audit']
  },
  {
    scenarioCode:'FAT-20', title:'Tir 1405 commission reconstruction', purpose:'Reconcile workbook arithmetic, CRM facts and preliminary commission without treating file errors as rules.',
    requiredInputs:['tir-1405-reconstruction'], expectedInvariants:['four-transfer-errors-excluded', 'differences-drillable', 'draft-nonpayable', 'unresolved-explicit'],
    tolerance:{ irr:'exact-unless-human-approved-evidence' }, blockingSeverity:'critical', approvalRequirements:['accounting','manager'], evidenceRequirements:['tir-reconstruction-report']
  },
  {
    scenarioCode:'FAT-COMMISSION-FUTURE', title:'Commission reconciliation (disabled)', purpose:'Reserved definition for the future Commission phase.',
    requiredInputs:['commission-phase-enabled'], expectedInvariants:['not-applicable-before-commission-phase'],
    tolerance:{ status:'disabled' }, blockingSeverity:'future', approvalRequirements:['accounting', 'manager'], evidenceRequirements:['future-definition'], enabled:false
  }
]);

async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  for (const name of OWNED_COLLECTIONS) {
    if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  }
  await db.collection(SESSIONS).createIndex({ sessionId:1 }, { unique:true });
  const sessionIndexes = await db.collection(SESSIONS).indexes();
  const legacySessionIndex = sessionIndexes.find(index => index.name === 'reviewBatchId_1_frozen.fifoDatasetId_1');
  if (legacySessionIndex?.unique) await db.collection(SESSIONS).dropIndex(legacySessionIndex.name);
  await db.collection(SESSIONS).createIndex(
    { reviewBatchId:1, 'frozen.fifoDatasetId':1, 'frozen.gitSha':1 },
    { unique:true, name:'review_batch_fifo_git_unique_v2' }
  );
  await db.collection(SESSIONS).createIndex({ status:1, updatedAt:-1 });
  await db.collection(COMPARISON_IMPORTS).createIndex({ importId:1 }, { unique:true });
  await db.collection(COMPARISON_IMPORTS).createIndex({ sourceFileHash:1, frozenSessionId:1 }, { unique:true });
  await db.collection(COMPARISON_IMPORTS).createIndex({ status:1, updatedAt:-1 });
  await db.collection(COMPARISON_ROWS).createIndex({ importId:1, sourceRowNumber:1 }, { unique:true });
  await db.collection(COMPARISON_ROWS).createIndex({ importId:1, identityHash:1 });
  await db.collection(COMPARISON_ROWS).createIndex({ importId:1, duplicateReferenceRow:1 });
  await db.collection(COMPARISON_RUNS).createIndex({ comparisonRunId:1 }, { unique:true });
  await db.collection(COMPARISON_RUNS).createIndex({ sessionId:1, importId:1, comparisonVersion:1 }, { unique:true });
  await db.collection(COMPARISON_DIFFERENCES).createIndex({ differenceId:1 }, { unique:true });
  await db.collection(COMPARISON_DIFFERENCES).createIndex({ comparisonRunId:1, classification:1, sourceRowNumber:1 });
  await db.collection(FAT_DEFINITIONS).createIndex({ definitionId:1 }, { unique:true });
  await db.collection(FAT_DEFINITIONS).createIndex({ fatVersion:1, scenarioCode:1 }, { unique:true });
  await db.collection(FAT_RUNS).createIndex({ fatRunId:1 }, { unique:true });
  await db.collection(FAT_RUNS).createIndex({ sessionId:1, fatVersion:1 }, { unique:true });
  await db.collection(FAT_EVIDENCE).createIndex({ evidenceId:1 }, { unique:true });
  await db.collection(FAT_EVIDENCE).createIndex({ fatRunId:1, scenarioCode:1, createdAt:1 });
  await db.collection(FAT_DIFFERENCES).createIndex({ differenceId:1 }, { unique:true });
  await db.collection(FAT_DIFFERENCES).createIndex({ fatRunId:1, scenarioCode:1, classification:1 });
  await db.collection(FAT_APPROVALS).createIndex({ approvalId:1 }, { unique:true });
  await db.collection(FAT_APPROVALS).createIndex({ fatRunId:1, scenarioCode:1, role:1, username:1 }, { unique:true });
  return { ok:true, moduleVersion:MODULE_VERSION, collections:OWNED_COLLECTIONS };
}

async function activeContext(db) {
  const [sale, purchase, state] = await Promise.all([
    saleSnapshot._activeDataset(db),
    purchaseLayerDataset.activeDataset(db),
    db.collection('fifoDatasetState').findOne({ scopeKey:readiness.ALGORITHM_VERSION })
  ]);
  const fifo = state?.activeDatasetId
    ? await db.collection('fifoDatasets').findOne({ datasetId:state.activeDatasetId })
    : null;
  if (!sale?.snapshotId || !purchase?.datasetId || !fifo?.datasetId) {
    fail('ACCOUNTING_SESSION_SOURCE_MISSING', 'منابع فعال Sale، Purchase یا FIFO موجود نیست.', 409);
  }
  if (fifo.status !== 'completed' || fifo.activationStatus !== 'validated-shadow') {
    fail('ACCOUNTING_SESSION_FIFO_INVALID', 'FIFO فعال completed و validated-shadow نیست.', 409);
  }
  return { sale, purchase, fifo };
}

async function initializeFatDefinitions(db, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  await ensureIndexes(db);
  let created = 0;
  for (const definition of FAT_SCENARIOS) {
    const definitionId = deterministicId('FATDEF', `${FAT_VERSION}|${definition.scenarioCode}`);
    const row = {
      definitionId, schemaVersion:SCHEMA_VERSION, fatVersion:FAT_VERSION,
      ...definition, enabled:definition.enabled !== false,
      algorithmVersion:readiness.ALGORITHM_VERSION,
      applicationVersion:APP_VERSION,
      immutable:true,
      createdBy:current,
      createdAt:new Date(),
      auditLog:[audit('fat-definition-created', current, { scenarioCode:definition.scenarioCode })]
    };
    const result = await db.collection(FAT_DEFINITIONS).updateOne(
      { definitionId }, { $setOnInsert:row }, { upsert:true }
    );
    if (result.upsertedCount) created++;
  }
  return { ok:true, fatVersion:FAT_VERSION, total:FAT_SCENARIOS.length, created, automaticApproval:false };
}

async function validateSessionUsers(db, accountingUsername, managerUsername) {
  const accountingUser = await db.collection('users').findOne({
    username:accountingUsername, role:'accounting', isActive:{ $ne:false }
  }, { projection:{ _id:0, username:1, role:1, fullName:1 } });
  if (!accountingUser) fail('ACCOUNTING_SESSION_ACCOUNTING_USER_INVALID', 'کاربر فعال Accounting معتبر نیست.', 409);
  const managerUser = await db.collection('users').findOne({
    username:managerUsername, role:{ $in:['manager', 'admin'] }, isActive:{ $ne:false }
  }, { projection:{ _id:0, username:1, role:1, fullName:1 } });
  if (!managerUser) fail('ACCOUNTING_SESSION_MANAGER_USER_INVALID', 'کاربر فعال Manager/Admin معتبر نیست.', 409);
  if (accountingUsername === managerUsername) {
    fail('ACCOUNTING_SESSION_SEPARATION_REQUIRED', 'Accounting و Manager باید دو هویت متفاوت باشند.', 409);
  }
  return { accountingUser, managerUser };
}

async function priorityManifest(db, context) {
  const fifoId = context.fifo.datasetId;
  const [deterministic, p0, purchase, samples, high, remaining, impact] = await Promise.all([
    db.collection(operational.RETURN_CASES).find({ sourceFifoDatasetId:fifoId, kind:'sale', confidenceBand:'deterministic' }, { projection:{ _id:0, caseId:1, resolutionId:1, financialImpact:1, confidence:1 } }).sort({ financialImpact:-1 }).limit(1000).toArray(),
    db.collection(operational.INVESTIGATIONS).find({ sourceFifoDatasetId:fifoId, priority:'P0' }, { projection:{ _id:0, investigationId:1, evidenceId:1, affectedSaleValue:1, affectedQuantity:1 } }).sort({ affectedSaleValue:-1 }).limit(2000).toArray(),
    db.collection(operational.RETURN_CASES).find({ sourceFifoDatasetId:fifoId, kind:'purchase', confidenceBand:{ $ne:'no_candidate' } }, { projection:{ _id:0, caseId:1, resolutionId:1, financialImpact:1, confidence:1, confidenceBand:1 } }).sort({ confidence:-1, financialImpact:-1 }).limit(1000).toArray(),
    db.collection(readiness.SAMPLES).find({ datasetId:fifoId }, { projection:{ _id:0, sampleId:1, category:1, saleValueExact:1, sourceSnapshot:1, reviewStatus:1 } }).sort({ saleValueExact:-1 }).limit(500).toArray(),
    db.collection(operational.RETURN_CASES).find({ sourceFifoDatasetId:fifoId, kind:'sale', confidenceBand:'high_confidence' }, { projection:{ _id:0, caseId:1, resolutionId:1, financialImpact:1, confidence:1 } }).sort({ financialImpact:-1 }).limit(1000).toArray(),
    db.collection(operational.RETURN_CASES).find({ sourceFifoDatasetId:fifoId, confidenceBand:{ $in:['medium_confidence', 'low_confidence', 'no_candidate'] } }, { projection:{ _id:0, caseId:1, resolutionId:1, kind:1, financialImpact:1, confidence:1, confidenceBand:1 } }).sort({ financialImpact:-1 }).limit(2000).toArray(),
    operational.impactReport(db)
  ]);
  const sortedSamples = samples.sort((a, b) => finite(b.saleValueExact || b.sourceSnapshot?.saleValue) - finite(a.saleValueExact || a.sourceSnapshot?.saleValue));
  const manifest = {
    deterministicSaleReturnCaseIds:deterministic.map(row => row.caseId),
    p0InvestigationIds:p0.map(row => row.investigationId),
    purchaseReturnCaseIds:purchase.map(row => row.caseId),
    validationSampleIds:sortedSamples.map(row => row.sampleId),
    highConfidenceSaleReturnCaseIds:high.map(row => row.caseId),
    remainingReturnCaseIds:remaining.map(row => row.caseId)
  };
  const target = {
    validationSampleIds:manifest.validationSampleIds.slice(0, 30),
    deterministicSaleReturnCaseIds:manifest.deterministicSaleReturnCaseIds.slice(0, 20),
    p0InvestigationIds:manifest.p0InvestigationIds.slice(0, 10),
    purchaseReturnCaseIds:manifest.purchaseReturnCaseIds.slice(0, 5),
    manualPackageIds:[]
  };
  const effortMinutes = deterministic.length * 2 + p0.length * 5 + purchase.length * 4 + sortedSamples.length * 5 + high.length * 3 + remaining.length * 4;
  return {
    manifest,
    minimumTargets:target,
    summary:{
      totalRecords:Object.values(manifest).reduce((sum, rows) => sum + rows.length, 0),
      totalFinancialImpact:impact.projected.p0ValueUnderReview,
      actualApprovedImpact:0,
      projectedCoverageGain:round(impact.projected.saleValueCoverageAfterApprovedCandidateRecovery - impact.baseline.saleValueCostCoverage, 2),
      projectedUnknownValueReduction:impact.projected.recoverableUnknownValue,
      estimatedReviewMinutes:effortMinutes,
      unresolvedEvidenceRequirements:{
        purchaseNoCandidate:impact.returnConfidenceBands.no_candidate || 0,
        manualEvidencePackages:impact.projected.manualEvidencePackages,
        accountingReviewedSamples:impact.actualApproved.accountingReviewedSamples
      }
    }
  };
}

async function createSession(db, input = {}, by = {}, runtime = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  await ensureIndexes(db);
  const reviewBatchId = clean(input.reviewBatchId, 100);
  if (!reviewBatchId) fail('ACCOUNTING_SESSION_BATCH_REQUIRED', 'Review Batch الزامی است.');
  const batch = await db.collection(operational.BATCHES).findOne({ batchId:reviewBatchId });
  if (!batch) fail('ACCOUNTING_SESSION_BATCH_NOT_FOUND', 'Review Batch پیدا نشد.', 404);
  const context = await activeContext(db);
  if (clean(batch.sourceFifoDatasetId, 100) !== clean(context.fifo.datasetId, 100)) {
    fail('ACCOUNTING_SESSION_BATCH_SOURCE_MISMATCH', 'Batch به FIFO فعال فعلی تعلق ندارد.', 409);
  }
  const accountingUsername = clean(input.assignedAccountingUser, 100);
  const managerUsername = clean(input.assignedManagerUser, 100);
  const users = await validateSessionUsers(db, accountingUsername, managerUsername);
  const prioritized = await priorityManifest(db, context);
  const frozen = {
    saleSnapshotId:context.sale.snapshotId,
    purchaseDatasetId:context.purchase.datasetId,
    fifoDatasetId:context.fifo.datasetId,
    fifoAlgorithmVersion:clean(context.fifo.algorithmVersion, 100),
    reviewBatchId,
    reviewBatchRevision:Number(batch.revision || 0),
    applicationVersion:APP_VERSION,
    gitSha:environmentCommit(runtime),
    sourceFingerprint:clean(context.fifo.sourceFingerprint, 128),
    allocationFingerprint:clean(context.fifo.allocationFingerprint, 128)
  };
  if (!frozen.gitSha) fail('ACCOUNTING_SESSION_GIT_SHA_REQUIRED', 'Git SHA برای Freeze session الزامی است.', 409);
  const sessionId = deterministicId('ASESSION', `${reviewBatchId}|${frozen.fifoDatasetId}|${frozen.gitSha}|${MODULE_VERSION}`);
  if (await db.collection(SESSIONS).findOne({ sessionId })) {
    fail('ACCOUNTING_SESSION_DUPLICATE', 'برای این Batch و Dataset قبلاً session ساخته شده است.', 409);
  }
  const now = new Date();
  const session = {
    sessionId, schemaVersion:SCHEMA_VERSION, sessionVersion:MODULE_VERSION,
    title:clean(input.title || 'Phase 5.2.9 — Human Accounting Final Acceptance', 300),
    frozen:Object.freeze(frozen),
    reviewBatchId,
    createdBy:current,
    assignedAccountingUser:{ username:users.accountingUser.username, role:users.accountingUser.role, fullName:clean(users.accountingUser.fullName, 200) },
    assignedManagerUser:{ username:users.managerUser.username, role:users.managerUser.role, fullName:clean(users.managerUser.fullName, 200) },
    priorityManifest:prioritized.manifest,
    minimumTargets:prioritized.minimumTargets,
    preparationSummary:prioritized.summary,
    status:'prepared', startedAt:null, completedAt:null, cancelledAt:null,
    revision:1,
    auditLog:[audit('accounting-session-prepared', current, { frozen, minimumTargets:prioritized.minimumTargets })],
    immutableSourceReferences:true,
    sourceDatasetsCopied:false,
    accountingApproved:false,
    profitActivationAllowed:false,
    createdAt:now, updatedAt:now
  };
  await db.collection(SESSIONS).insertOne(session);
  return { ok:true, session, automaticApproval:false, sourceCollectionWrites:0 };
}

async function listSessions(db, filters = {}) {
  const query = {};
  if (filters.status) query.status = clean(filters.status, 50);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 25), 100));
  const total = await count(db.collection(SESSIONS), query);
  const list = await db.collection(SESSIONS).find(query).sort({ createdAt:-1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
  return { ok:true, total, page, pageSize, list, accountingApproved:false, profitActivationAllowed:false };
}

async function getSession(db, sessionId) {
  const session = await db.collection(SESSIONS).findOne({ sessionId:clean(sessionId, 100) });
  if (!session) fail('ACCOUNTING_SESSION_NOT_FOUND', 'Accounting session پیدا نشد.', 404);
  return session;
}

function sessionTransitions(status) {
  return {
    prepared:['in_progress', 'cancelled'],
    in_progress:['waiting_evidence', 'ready_for_manager_review', 'cancelled'],
    waiting_evidence:['in_progress', 'ready_for_manager_review', 'cancelled'],
    ready_for_manager_review:['waiting_evidence', 'completed', 'cancelled'],
    completed:[], cancelled:[]
  }[status] || [];
}

async function minimumTargetProgress(db, session) {
  const targets = session.minimumTargets || {};
  const reviewedSamples = await count(db.collection(readiness.SAMPLES), {
    datasetId:session.frozen.fifoDatasetId,
    sampleId:{ $in:targets.validationSampleIds || [] },
    reviewStatus:{ $in:['accounting_confirmed', 'accounting_disputed', 'needs_evidence'] }
  });
  const reviewedP0 = await count(db.collection(operational.INVESTIGATIONS), {
    sourceFifoDatasetId:session.frozen.fifoDatasetId,
    investigationId:{ $in:targets.p0InvestigationIds || [] },
    reviewStatus:{ $ne:'prepared' }
  });
  const reviewedSaleReturns = await count(db.collection(operational.RETURN_CASES), {
    sourceFifoDatasetId:session.frozen.fifoDatasetId,
    caseId:{ $in:targets.deterministicSaleReturnCaseIds || [] },
    reviewStatus:{ $ne:'prepared' }
  });
  const reviewedPurchaseReturns = await count(db.collection(operational.RETURN_CASES), {
    sourceFifoDatasetId:session.frozen.fifoDatasetId,
    caseId:{ $in:targets.purchaseReturnCaseIds || [] },
    reviewStatus:{ $ne:'prepared' }
  });
  const manualTotal = (targets.manualPackageIds || []).length;
  const reviewedManual = manualTotal ? await count(db.collection(operational.MANUAL_PACKAGES), {
    sourceFifoDatasetId:session.frozen.fifoDatasetId,
    packageId:{ $in:targets.manualPackageIds },
    status:{ $ne:'draft' }
  }) : 0;
  const required = { samples:30, deterministicSaleReturns:20, p0Evidence:10, purchaseReturns:5, manualPackages:manualTotal };
  const completed = { samples:reviewedSamples, deterministicSaleReturns:reviewedSaleReturns, p0Evidence:reviewedP0, purchaseReturns:reviewedPurchaseReturns, manualPackages:reviewedManual };
  return {
    required, completed,
    met:Object.keys(required).every(name => completed[name] >= required[name])
  };
}

async function transitionSession(db, sessionId, input = {}, by = {}) {
  const current = requireRole(by);
  const session = await getSession(db, sessionId);
  if (['completed', 'cancelled'].includes(session.status)) {
    fail('ACCOUNTING_SESSION_IMMUTABLE', 'Session نهایی immutable است.', 409);
  }
  if (Number(input.revision) !== Number(session.revision)) {
    fail('ACCOUNTING_SESSION_CONFLICT', 'Revision session منقضی است.', 409);
  }
  const status = clean(input.status, 50);
  if (!SESSION_STATUSES.includes(status) || !sessionTransitions(session.status).includes(status)) {
    fail('ACCOUNTING_SESSION_INVALID_TRANSITION', 'Transition این session مجاز نیست.', 409);
  }
  const managerReturningEvidence = session.status === 'ready_for_manager_review' && status === 'waiting_evidence';
  const isAccountingStep = ['in_progress', 'waiting_evidence', 'ready_for_manager_review'].includes(status) && !managerReturningEvidence;
  if (isAccountingStep) {
    if (current.role !== 'accounting' || current.username !== session.assignedAccountingUser.username) {
      fail('ACCOUNTING_SESSION_ACCOUNTING_ASSIGNEE_REQUIRED', 'این مرحله فقط توسط Accounting تعیین‌شده قابل انجام است.', 403);
    }
  }
  if (managerReturningEvidence && !['manager', 'admin'].includes(current.role)) {
    fail('ACCOUNTING_SESSION_MANAGER_REQUIRED', 'بازگرداندن session از Manager review فقط توسط Manager/Admin مجاز است.', 403);
  }
  let progress = await minimumTargetProgress(db, session);
  if (status === 'ready_for_manager_review' && !progress.met) {
    fail('ACCOUNTING_SESSION_MINIMUM_TARGET_NOT_MET', 'حداقل review target هنوز تکمیل نشده است.', 409);
  }
  if (status === 'completed') {
    if (!['manager', 'admin'].includes(current.role)) fail('ACCOUNTING_SESSION_MANAGER_REQUIRED', 'تکمیل session فقط توسط Manager/Admin مجاز است.', 403);
    if (current.username !== session.assignedManagerUser.username) {
      fail('ACCOUNTING_SESSION_ASSIGNED_MANAGER_REQUIRED', 'فقط Manager تعیین‌شده می‌تواند session را تکمیل کند.', 403);
    }
    if (current.role === 'admin' && clean(input.authorizedScope, 50) !== 'manager') {
      fail('ACCOUNTING_SESSION_ADMIN_MANAGER_SCOPE_REQUIRED', 'Admin باید manager scope را صریحاً اعلام کند.', 403);
    }
    if (current.username === session.assignedAccountingUser.username) {
      fail('ACCOUNTING_SESSION_SELF_APPROVAL', 'Accounting reviewer نمی‌تواند session خود را تأیید نهایی کند.', 409);
    }
    if (!progress.met) fail('ACCOUNTING_SESSION_MINIMUM_TARGET_NOT_MET', 'حداقل review target تکمیل نشده است.', 409);
    if (!clean(input.reason, 2000) || !clean(input.evidenceReference, 500)) {
      fail('ACCOUNTING_SESSION_MANAGER_EVIDENCE_REQUIRED', 'دلیل و Evidence برای تصمیم Manager الزامی است.');
    }
  }
  const now = new Date();
  const next = {
    status,
    startedAt:status === 'in_progress' ? (session.startedAt || now) : session.startedAt,
    completedAt:status === 'completed' ? now : session.completedAt,
    cancelledAt:status === 'cancelled' ? now : session.cancelledAt,
    managerDecision:status === 'completed' ? { by:current, reason:clean(input.reason, 2000), evidenceReference:clean(input.evidenceReference, 500), at:now } : session.managerDecision || null,
    revision:Number(session.revision) + 1,
    auditLog:[...(session.auditLog || []), audit('accounting-session-transition', current, { fromStatus:session.status, toStatus:status, reason:input.reason, evidenceReference:input.evidenceReference })].slice(-500),
    updatedAt:now
  };
  const result = await db.collection(SESSIONS).updateOne({ sessionId:session.sessionId, revision:session.revision }, { $set:next });
  if (!result.matchedCount) fail('ACCOUNTING_SESSION_CONFLICT', 'Session هم‌زمان تغییر کرده است.', 409);
  return { ok:true, session:{ ...session, ...next }, minimumTargetProgress:progress, frozenUnchanged:true, accountingApproved:status === 'completed' };
}

async function sessionReport(db, sessionId) {
  const session = await getSession(db, sessionId);
  const [progress, base, fatRuns, imports] = await Promise.all([
    minimumTargetProgress(db, session),
    lightweightReadinessSummary(db, session.frozen.fifoDatasetId),
    db.collection(FAT_RUNS).find({ sessionId:session.sessionId }).sort({ createdAt:-1 }).limit(20).toArray(),
    db.collection(COMPARISON_IMPORTS).find({ frozenSessionId:session.sessionId }).sort({ createdAt:-1 }).limit(20).toArray()
  ]);
  const reviewed = {
    confirmed:progress.completed.samples + progress.completed.deterministicSaleReturns + progress.completed.purchaseReturns,
    disputed:await count(db.collection(readiness.SAMPLES), { datasetId:session.frozen.fifoDatasetId, reviewStatus:'accounting_disputed' }),
    needsEvidence:await count(db.collection(operational.INVESTIGATIONS), { sourceFifoDatasetId:session.frozen.fifoDatasetId, reviewStatus:'needs_evidence' }),
    deferred:await count(db.collection(operational.RETURN_CASES), { sourceFifoDatasetId:session.frozen.fifoDatasetId, reviewStatus:'deferred' })
  };
  return {
    ok:true, session, progress, reviewed,
    coverage:{
      quantity:base.confidence.components.quantityCostCoverage,
      saleValue:base.confidence.components.saleValueCostCoverage,
      line:base.confidence.components.lineCoverage,
      returnLinkage:base.confidence.components.returnLinkageCoverage,
      confidence:base.confidence.index,
      unknownSaleValue:base.evidence.affectedSaleValue
    },
    fatRuns:fatRuns.map(row => ({ fatRunId:row.fatRunId, status:row.status, scenarioSummary:row.scenarioSummary })),
    comparisonImports:imports.map(row => ({ importId:row.importId, status:row.status, sourceFileName:row.sourceFileName, sourceFileHash:row.sourceFileHash })),
    profitActivationAllowed:false, commissionEnabled:false, accountingApproved:session.status === 'completed'
  };
}

async function buildLightweightReadinessSummary(db, datasetId) {
  const dataset = await db.collection('fifoDatasets').findOne({ datasetId:clean(datasetId, 100) });
  if (!dataset) fail('FIFO_DATASET_MISSING', 'FIFO Shadow Dataset برای گزارش سبک موجود نیست.', 404);
  const [allocations, evidence, purchaseReturns, saleReturns, samples] = await Promise.all([
    db.collection('fifoAllocations').find(
      { datasetId:dataset.datasetId },
      { projection:{ _id:0, saleInvoiceType:1, saleLineId:1, quantityExact:1, allocatedQty:1, unknownQty:1, allocatedSaleValueExact:1, allocatedSaleValue:1, sourceType:1 } }
    ).toArray(),
    db.collection(readiness.EVIDENCE).find(
      { sourceActive:{ $ne:false } },
      { projection:{ _id:0, status:1, priority:1, affectedSaleValue:1, affectedQuantity:1 } }
    ).toArray(),
    db.collection(readiness.PURCHASE_RETURNS).find({}, { projection:{ _id:0, status:1 } }).toArray(),
    db.collection(readiness.SALE_RETURNS).find({}, { projection:{ _id:0, status:1 } }).toArray(),
    db.collection(readiness.SAMPLES).find(
      { datasetId:dataset.datasetId },
      { projection:{ _id:0, reviewStatus:1 } }
    ).toArray()
  ]);
  const confidence = readiness._confidenceFromRows(dataset, allocations, evidence, purchaseReturns, saleReturns, samples);
  return {
    ok:true, available:true,
    dataset:{
      datasetId:dataset.datasetId, status:dataset.status, activationStatus:dataset.activationStatus,
      algorithmVersion:dataset.algorithmVersion, sourceSaleSnapshotId:dataset.sourceSaleSnapshotId,
      sourcePurchaseDatasetId:dataset.sourcePurchaseDatasetId, validation:dataset.validation
    },
    confidence,
    evidence:{
      total:evidence.length,
      affectedSaleValue:round(evidence.reduce((sum, row) => sum + finite(row.affectedSaleValue), 0), 2),
      affectedQuantity:round(evidence.reduce((sum, row) => sum + finite(row.affectedQuantity), 0), 6)
    },
    samples:{ total:samples.length, reviewed:samples.filter(row => row.reviewStatus !== 'not_reviewed').length },
    reportMode:'lightweight-projected-fields',
    comparisonLoaded:false,
    accountingApproved:false,
    profitActivationAllowed:false
  };
}

async function lightweightReadinessSummary(db, datasetId) {
  const key = clean(datasetId, 100);
  if (readinessSummaryInFlight.has(key)) return readinessSummaryInFlight.get(key);
  const promise = buildLightweightReadinessSummary(db, key);
  readinessSummaryInFlight.set(key, promise);
  try { return await promise; }
  finally { readinessSummaryInFlight.delete(key); }
}

function validateMapping(mapping = {}, requiredFields = DEFAULT_REQUIRED_MAPPING) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail('ACCOUNTING_COMPARISON_MAPPING_REQUIRED', 'Mapping صریح ستون‌ها الزامی است.');
  }
  const normalized = {};
  const sourceNames = new Set();
  for (const [logical, source] of Object.entries(mapping)) {
    if (!LOGICAL_FIELDS.includes(logical)) fail('ACCOUNTING_COMPARISON_MAPPING_UNKNOWN_FIELD', `فیلد منطقی ${clean(logical, 100)} پشتیبانی نمی‌شود.`);
    const sourceName = clean(source, 200);
    if (!sourceName) fail('ACCOUNTING_COMPARISON_MAPPING_EMPTY_SOURCE', `ستون منبع ${logical} خالی است.`);
    const key = sourceName.toLocaleLowerCase('fa').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ');
    if (sourceNames.has(key)) fail('ACCOUNTING_COMPARISON_MAPPING_AMBIGUOUS', 'یک ستون منبع به چند فیلد منطقی نگاشت شده است.');
    sourceNames.add(key);
    normalized[logical] = sourceName;
  }
  for (const logical of requiredFields) {
    if (!normalized[logical]) fail('ACCOUNTING_COMPARISON_MAPPING_MISSING_REQUIRED', `Mapping فیلد ${logical} الزامی است.`);
  }
  return normalized;
}

function sourceBufferFromInput(input = {}) {
  const base64 = clean(input.sourceFileBase64, 4_500_000);
  if (!base64) fail('ACCOUNTING_COMPARISON_SOURCE_FILE_REQUIRED', 'محتوای فایل منبع برای محاسبه hash الزامی است.');
  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); } catch { fail('ACCOUNTING_COMPARISON_SOURCE_FILE_INVALID', 'Base64 فایل معتبر نیست.'); }
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== base64.replace(/\s+/g, '').replace(/=+$/, '')) {
    fail('ACCOUNTING_COMPARISON_SOURCE_FILE_INVALID', 'Base64 فایل معتبر نیست.');
  }
  if (buffer.length > MAX_SOURCE_BYTES) fail('ACCOUNTING_COMPARISON_SOURCE_TOO_LARGE', `فایل از حد ${MAX_SOURCE_BYTES} بایت بزرگ‌تر است.`, 413);
  return buffer;
}

async function createComparisonImport(db, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  await ensureIndexes(db);
  const session = await getSession(db, input.sessionId);
  if (['completed', 'cancelled'].includes(session.status)) fail('ACCOUNTING_COMPARISON_SESSION_CLOSED', 'Session نهایی شده است.', 409);
  const requiredFields = Array.isArray(input.requiredLogicalFields) && input.requiredLogicalFields.length
    ? [...new Set(input.requiredLogicalFields.map(value => clean(value, 100)))]
    : [...DEFAULT_REQUIRED_MAPPING];
  if (requiredFields.some(field => !LOGICAL_FIELDS.includes(field))) fail('ACCOUNTING_COMPARISON_REQUIRED_FIELD_INVALID', 'Required field نامعتبر است.');
  const mapping = validateMapping(input.mapping, requiredFields);
  const buffer = sourceBufferFromInput(input);
  const sourceFileHash = sha256(buffer);
  const importId = deterministicId('ACIMPORT', `${session.sessionId}|${sourceFileHash}`);
  if (await db.collection(COMPARISON_IMPORTS).findOne({ importId })) fail('ACCOUNTING_COMPARISON_IMPORT_DUPLICATE', 'این فایل برای session قبلاً ثبت شده است.', 409);
  const now = new Date();
  const row = {
    importId, schemaVersion:SCHEMA_VERSION, comparisonVersion:COMPARISON_VERSION,
    frozenSessionId:session.sessionId,
    frozen:{ ...session.frozen },
    sourceFileName:clean(input.sourceFileName, 300),
    sourceMimeType:clean(input.sourceMimeType || 'application/octet-stream', 100),
    sourceFileHash, sourceFileSize:buffer.length,
    binaryStored:false,
    mapping, requiredLogicalFields:requiredFields,
    mappingLanguageSupport:['fa', 'en'],
    status:'mapping_validated',
    progress:{ rowsReceived:0, rowsAccepted:0, duplicateRows:0, invalidRows:0, nextRowNumber:1 },
    lock:null, revision:1,
    createdBy:current,
    auditLog:[audit('comparison-import-created', current, { sourceFileName:input.sourceFileName, sourceFileHash, sourceFileSize:buffer.length, mapping })],
    createdAt:now, updatedAt:now,
    sourceDatasetWrites:0, operationalDatasetWrites:0,
    accountingApproved:false
  };
  await db.collection(COMPARISON_IMPORTS).insertOne(row);
  return { ok:true, import:row, sourceFileStored:false, automaticApproval:false };
}

function mappedValue(sourceValues, sourceName) {
  if (Object.prototype.hasOwnProperty.call(sourceValues, sourceName)) return sourceValues[sourceName];
  const normalized = sourceName.toLocaleLowerCase('fa').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ');
  const match = Object.keys(sourceValues).find(name => clean(name, 200).toLocaleLowerCase('fa').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ') === normalized);
  return match == null ? undefined : sourceValues[match];
}

function normalizeComparisonRow(sourceValues, mapping) {
  const values = {};
  for (const [logical, sourceName] of Object.entries(mapping)) values[logical] = mappedValue(sourceValues, sourceName);
  const normalized = {
    sellerIdentity:clean(values.sellerIdentity, 200),
    invoiceType:Number(clean(values.invoiceType, 20)),
    invoiceNumber:clean(values.invoiceNumber, 100),
    invoiceDate:normalizeJalaliDate(values.invoiceDate, { field:'invoiceDate', required:true }),
    lineIdentity:clean(values.lineIdentity, 200),
    itemCode:clean(values.itemCode, 100),
    quantityExact:exactQuantity(values.quantity)
  };
  if (!Number.isFinite(normalized.invoiceType) || !normalized.invoiceNumber || !normalized.itemCode) {
    fail('ACCOUNTING_COMPARISON_ROW_IDENTITY_INVALID', 'هویت فاکتور یا کالا در ردیف مرجع معتبر نیست.');
  }
  for (const field of MONEY_FIELDS) {
    if (values[field] != null && clean(values[field]) !== '') normalized[`${field}Exact`] = exactMoney(values[field]);
  }
  normalized.identityHash = sha256(stable([
    normalized.invoiceType, normalized.invoiceNumber, normalized.lineIdentity,
    normalized.itemCode, normalized.invoiceDate
  ]));
  return normalized;
}

async function acquireImportLock(db, row, current) {
  const now = new Date();
  const active = row.lock?.expiresAt && new Date(row.lock.expiresAt).getTime() > now.getTime();
  if (active) fail('ACCOUNTING_COMPARISON_IMPORT_LOCKED', 'Import توسط job دیگری قفل است.', 409);
  const token = crypto.randomBytes(16).toString('hex');
  const lock = { token, owner:current, acquiredAt:now, expiresAt:new Date(now.getTime() + 5 * 60 * 1000) };
  const result = await db.collection(COMPARISON_IMPORTS).updateOne(
    { importId:row.importId, revision:row.revision },
    { $set:{ lock, status:'ingesting', updatedAt:now }, $inc:{ revision:1 } }
  );
  if (!result.matchedCount) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Import هم‌زمان تغییر کرده است.', 409);
  return lock;
}

async function ingestComparisonRows(db, importId, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const imported = await db.collection(COMPARISON_IMPORTS).findOne({ importId:clean(importId, 100) });
  if (!imported) fail('ACCOUNTING_COMPARISON_IMPORT_NOT_FOUND', 'Import پیدا نشد.', 404);
  if (['ready', 'cancelled'].includes(imported.status)) fail('ACCOUNTING_COMPARISON_IMPORT_CLOSED', 'Import بسته شده است.', 409);
  if (Number(input.revision) !== Number(imported.revision)) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Revision Import منقضی است.', 409);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length || rows.length > MAX_ROW_BATCH) fail('ACCOUNTING_COMPARISON_ROW_BATCH_INVALID', `Batch باید بین 1 و ${MAX_ROW_BATCH} ردیف باشد.`);
  const lock = await acquireImportLock(db, imported, current);
  let accepted = 0, duplicateRows = 0, invalidRows = 0, maximumRow = Number(imported.progress?.nextRowNumber || 1) - 1;
  const seen = new Set();
  try {
    for (const source of rows) {
      const sourceRowNumber = Number(source.sourceRowNumber);
      maximumRow = Math.max(maximumRow, sourceRowNumber || 0);
      if (!Number.isInteger(sourceRowNumber) || sourceRowNumber < 1 || !source.sourceValues || typeof source.sourceValues !== 'object') {
        invalidRows++;
        continue;
      }
      try {
        const normalized = normalizeComparisonRow(source.sourceValues, imported.mapping);
        const existing = await db.collection(COMPARISON_ROWS).findOne({ importId:imported.importId, identityHash:normalized.identityHash });
        const duplicateReferenceRow = Boolean(existing || seen.has(normalized.identityHash));
        seen.add(normalized.identityHash);
        const row = {
          importId:imported.importId, frozenSessionId:imported.frozenSessionId,
          sourceRowNumber, sourceValues:boundedObject(source.sourceValues, 80, 2000),
          normalized, identityHash:normalized.identityHash,
          duplicateReferenceRow,
          differenceClassification:duplicateReferenceRow ? 'duplicate_reference_row' : '',
          sourceFileHash:imported.sourceFileHash,
          createdAt:new Date(), createdBy:current
        };
        await db.collection(COMPARISON_ROWS).updateOne(
          { importId:imported.importId, sourceRowNumber }, { $setOnInsert:row }, { upsert:true }
        );
        if (duplicateReferenceRow) duplicateRows++;
        else accepted++;
      } catch (error) {
        if (error.code === 'ACCOUNTING_DECIMAL_INVALID' || error.code === 'INVALID_JALALI_DATE' || error.code === 'ACCOUNTING_COMPARISON_ROW_IDENTITY_INVALID') invalidRows++;
        else throw error;
      }
    }
    const final = input.final === true;
    const now = new Date();
    const previous = imported.progress || {};
    await db.collection(COMPARISON_IMPORTS).updateOne({ importId:imported.importId, 'lock.token':lock.token }, {
      $set:{
        status:final ? 'ready' : 'ingesting',
        progress:{
          rowsReceived:Number(previous.rowsReceived || 0) + rows.length,
          rowsAccepted:Number(previous.rowsAccepted || 0) + accepted,
          duplicateRows:Number(previous.duplicateRows || 0) + duplicateRows,
          invalidRows:Number(previous.invalidRows || 0) + invalidRows,
          nextRowNumber:maximumRow + 1
        },
        updatedAt:now,
        completedAt:final ? now : null
      },
      $unset:{ lock:'' }, $inc:{ revision:1 },
      $push:{ auditLog:{ $each:[audit('comparison-row-batch-ingested', current, { rows:rows.length, accepted, duplicateRows, invalidRows, final })], $slice:-500 } }
    });
    const saved = await db.collection(COMPARISON_IMPORTS).findOne({ importId:imported.importId });
    return { ok:true, import:saved, batch:{ received:rows.length, accepted, duplicateRows, invalidRows }, resumable:!final, automaticApproval:false };
  } catch (error) {
    await db.collection(COMPARISON_IMPORTS).updateOne({ importId:imported.importId, 'lock.token':lock.token }, {
      $set:{ status:'paused', lastError:clean(error.message, 1000), updatedAt:new Date() },
      $unset:{ lock:'' },
      $push:{ auditLog:{ $each:[audit('comparison-row-batch-interrupted', current, { error:error.message })], $slice:-500 } }
    }).catch(() => {});
    throw error;
  }
}

async function recoverComparisonImport(db, importId, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const row = await db.collection(COMPARISON_IMPORTS).findOne({ importId:clean(importId, 100) });
  if (!row) fail('ACCOUNTING_COMPARISON_IMPORT_NOT_FOUND', 'Import پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Revision Import منقضی است.', 409);
  if (row.lock?.expiresAt && new Date(row.lock.expiresAt).getTime() > Date.now()) fail('ACCOUNTING_COMPARISON_IMPORT_LOCKED', 'Lock هنوز معتبر است.', 409);
  const next = {
    status:'paused', lastError:'', updatedAt:new Date(), revision:Number(row.revision) + 1,
    auditLog:[...(row.auditLog || []), audit('comparison-import-recovered', current, { nextRowNumber:row.progress?.nextRowNumber })].slice(-500)
  };
  const result = await db.collection(COMPARISON_IMPORTS).updateOne({ importId:row.importId, revision:row.revision }, { $set:next, $unset:{ lock:'' } });
  if (!result.matchedCount) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Import هم‌زمان تغییر کرده است.', 409);
  return { ok:true, import:{ ...row, ...next, lock:null }, rowsPreserved:true };
}

async function cancelComparisonImport(db, importId, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const row = await db.collection(COMPARISON_IMPORTS).findOne({ importId:clean(importId, 100) });
  if (!row) fail('ACCOUNTING_COMPARISON_IMPORT_NOT_FOUND', 'Import پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Revision Import منقضی است.', 409);
  if (row.status === 'ready') fail('ACCOUNTING_COMPARISON_IMPORT_IMMUTABLE', 'Import کامل immutable است.', 409);
  const reason = clean(input.reason, 1000);
  if (!reason) fail('ACCOUNTING_COMPARISON_CANCEL_REASON_REQUIRED', 'دلیل لغو الزامی است.');
  const next = { status:'cancelled', cancelledAt:new Date(), cancelledBy:current, cancelReason:reason, revision:Number(row.revision) + 1, updatedAt:new Date(), auditLog:[...(row.auditLog || []), audit('comparison-import-cancelled', current, { reason })].slice(-500) };
  const result = await db.collection(COMPARISON_IMPORTS).updateOne({ importId:row.importId, revision:row.revision }, { $set:next, $unset:{ lock:'' } });
  if (!result.matchedCount) fail('ACCOUNTING_COMPARISON_IMPORT_CONFLICT', 'Import هم‌زمان تغییر کرده است.', 409);
  return { ok:true, import:{ ...row, ...next }, rowsDeleted:false, sourceDatasetWrites:0 };
}

function classifyDifference(field, crmValue, referenceValue, context = {}) {
  if (context.duplicateReferenceRow) return 'duplicate_reference_row';
  if (context.duplicateCrmRow) return 'duplicate_crm_row';
  if (context.missingInCrm) return 'missing_in_crm';
  if (context.missingInReference) return 'missing_in_reference';
  if (context.expectedScopeDifference) return 'expected_scope_difference';
  if (context.unresolvedEvidence) return 'unresolved_evidence';
  if (context.unknownCost) return 'unknown_cost';
  if (field === 'invoiceNumber' || field === 'invoiceType') return 'invoice_mapping_difference';
  if (field === 'lineIdentity' || field === 'itemCode') return 'line_mapping_difference';
  if (field === 'quantity') return 'quantity_difference';
  if (field === 'saleAmount' || field === 'grossProfit') return 'sale_amount_difference';
  if (['purchaseCost', 'costOfGoodsSold'].includes(field)) return 'cost_difference';
  if (field === 'invoiceDate') return 'date_normalization_difference';
  if (field === 'sellerIdentity') return 'seller_mapping_difference';
  if (field === 'saleReturnAmount' || field === 'purchaseReturnImpact') return 'return_linkage_difference';
  if (context.withinDocumentedPrecision && String(crmValue) !== String(referenceValue)) return 'rounding_difference';
  return 'unexplained_difference';
}

function compareExact(field, crmValue, referenceValue, tolerance = {}) {
  if (['count', 'invoiceCount', 'lineCount'].includes(field)) {
    const equal = Number(crmValue) === Number(referenceValue);
    return { equal, difference:Number(crmValue) - Number(referenceValue), toleranceUsed:false, policy:'exact-count' };
  }
  if (field === 'quantity') {
    const left = decimal.parse(crmValue || 0, decimal.QUANTITY_SCALE);
    const right = decimal.parse(referenceValue || 0, decimal.QUANTITY_SCALE);
    return { equal:left === right, differenceExact:decimal.format(left - right, decimal.QUANTITY_SCALE), toleranceUsed:false, policy:'fixed-scale-exact' };
  }
  if (MONEY_FIELDS.has(field) || ['saleAmount', 'cost'].includes(field)) {
    const left = decimal.parse(crmValue || 0, decimal.MONEY_SCALE);
    const right = decimal.parse(referenceValue || 0, decimal.MONEY_SCALE);
    return { equal:left === right, differenceExact:decimal.format(left - right, decimal.MONEY_SCALE), toleranceUsed:false, policy:'irr-exact' };
  }
  if (field === 'unitCost') {
    const left = decimal.parse(crmValue || 0, decimal.UNIT_COST_SCALE);
    const right = decimal.parse(referenceValue || 0, decimal.UNIT_COST_SCALE);
    const allowed = tolerance.approved === true ? decimal.parse(tolerance.amount || 0, decimal.UNIT_COST_SCALE) : 0n;
    const difference = left > right ? left - right : right - left;
    return { equal:difference <= allowed, differenceExact:decimal.format(left - right, decimal.UNIT_COST_SCALE), toleranceUsed:difference > 0n && difference <= allowed, policy:tolerance.approved ? 'approved-source-precision' : 'fixed-scale-exact' };
  }
  return { equal:clean(crmValue, 1000) === clean(referenceValue, 1000), toleranceUsed:false, policy:'exact-text' };
}

async function prepareComparisonRun(db, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const session = await getSession(db, input.sessionId);
  const imported = await db.collection(COMPARISON_IMPORTS).findOne({ importId:clean(input.importId, 100), frozenSessionId:session.sessionId });
  if (!imported || imported.status !== 'ready') fail('ACCOUNTING_COMPARISON_IMPORT_NOT_READY', 'Import کامل و متعلق به session نیست.', 409);
  const duplicateRows = await count(db.collection(COMPARISON_ROWS), { importId:imported.importId, duplicateReferenceRow:true });
  const comparisonRunId = deterministicId('ACRUN', `${session.sessionId}|${imported.importId}|${COMPARISON_VERSION}`);
  if (await db.collection(COMPARISON_RUNS).findOne({ comparisonRunId })) fail('ACCOUNTING_COMPARISON_RUN_DUPLICATE', 'Comparison run قبلاً ساخته شده است.', 409);
  const row = {
    comparisonRunId, schemaVersion:SCHEMA_VERSION, comparisonVersion:COMPARISON_VERSION,
    sessionId:session.sessionId, importId:imported.importId,
    frozen:{ ...session.frozen }, sourceFileHash:imported.sourceFileHash,
    status:duplicateRows ? 'blocked_missing_evidence' : 'prepared',
    progress:{ checkpointRowNumber:0, rowsCompared:0, differences:0 },
    duplicateReferenceRows:duplicateRows,
    referenceApproved:false,
    revision:1,
    createdBy:current,
    auditLog:[audit('comparison-run-prepared', current, { duplicateRows })],
    createdAt:new Date(), updatedAt:new Date(), accountingApproved:false
  };
  await db.collection(COMPARISON_RUNS).insertOne(row);
  return { ok:true, run:row, automaticPass:false, operationalDatasetWrites:0 };
}

async function acquireComparisonRunLock(db, run, current) {
  const now = new Date();
  if (run.lock?.expiresAt && new Date(run.lock.expiresAt).getTime() > now.getTime()) {
    fail('ACCOUNTING_COMPARISON_RUN_LOCKED', 'Comparison run توسط job دیگری قفل است.', 409);
  }
  const lock = { token:crypto.randomBytes(16).toString('hex'), owner:current, acquiredAt:now, expiresAt:new Date(now.getTime() + 5 * 60 * 1000) };
  const result = await db.collection(COMPARISON_RUNS).updateOne(
    { comparisonRunId:run.comparisonRunId, revision:run.revision },
    { $set:{ lock, status:'running', updatedAt:now }, $inc:{ revision:1 } }
  );
  if (!result.matchedCount) fail('ACCOUNTING_COMPARISON_RUN_CONFLICT', 'Comparison run هم‌زمان تغییر کرده است.', 409);
  return lock;
}

async function persistComparisonDifference(db, run, reference, field, crmValue, referenceValue, context = {}) {
  const classification = classifyDifference(field, crmValue, referenceValue, context);
  const comparison = context.comparison || { equal:false, toleranceUsed:false, policy:'not-applicable' };
  const differenceId = deterministicId('ACDIFF', `${run.comparisonRunId}|${reference.sourceRowNumber}|${field}|${classification}`);
  const row = {
    differenceId, comparisonRunId:run.comparisonRunId, importId:run.importId,
    sessionId:run.sessionId, sourceRowNumber:reference.sourceRowNumber,
    field:clean(field, 100), classification,
    crmValue:clean(crmValue, 1000), referenceValue:clean(referenceValue, 1000),
    differenceExact:clean(comparison.differenceExact ?? comparison.difference, 100),
    toleranceUsed:comparison.toleranceUsed === true,
    tolerancePolicy:clean(comparison.policy, 200),
    sourceFileHash:run.sourceFileHash,
    frozen:{ ...run.frozen }, status:'unreviewed', immutableSourceValues:true,
    createdAt:new Date()
  };
  await db.collection(COMPARISON_DIFFERENCES).updateOne({ differenceId }, { $setOnInsert:row }, { upsert:true });
  return row;
}

async function executeComparisonBatch(db, comparisonRunId, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const run = await db.collection(COMPARISON_RUNS).findOne({ comparisonRunId:clean(comparisonRunId, 100) });
  if (!run) fail('ACCOUNTING_COMPARISON_RUN_NOT_FOUND', 'Comparison run پیدا نشد.', 404);
  if (['cancelled', 'completed', 'blocked_human_review'].includes(run.status) && run.comparisonCompleted) {
    fail('ACCOUNTING_COMPARISON_RUN_IMMUTABLE', 'Comparison run کامل immutable است.', 409);
  }
  if (Number(input.revision) !== Number(run.revision)) fail('ACCOUNTING_COMPARISON_RUN_CONFLICT', 'Revision Comparison run منقضی است.', 409);
  const lock = await acquireComparisonRunLock(db, run, current);
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 100), 500));
  const checkpoint = Number(run.progress?.checkpointRowNumber || 0);
  const started = Date.now();
  let compared = 0, differences = 0, maximumRow = checkpoint;
  try {
    const references = await db.collection(COMPARISON_ROWS).find({
      importId:run.importId, sourceRowNumber:{ $gt:checkpoint }
    }).sort({ sourceRowNumber:1 }).limit(pageSize).toArray();
    for (const reference of references) {
      maximumRow = Math.max(maximumRow, Number(reference.sourceRowNumber || 0));
      const normalized = reference.normalized || {};
      const crmQuery = {
        snapshotId:run.frozen.saleSnapshotId,
        saleInvoiceType:Number(normalized.invoiceType),
        saleInvoiceNo:Number(normalized.invoiceNumber),
        itemCode:clean(normalized.itemCode, 100)
      };
      if (/^\d+$/.test(clean(normalized.lineIdentity, 20))) crmQuery.row = Number(normalized.lineIdentity);
      const crmRows = await db.collection('saleSnapshotDatasetLines').find(crmQuery).limit(2).toArray();
      compared++;
      if (!crmRows.length) {
        await persistComparisonDifference(db, run, reference, 'row', '', normalized.identityHash, { missingInCrm:true });
        differences++;
        continue;
      }
      if (crmRows.length > 1) {
        await persistComparisonDifference(db, run, reference, 'row', crmRows.length, 1, { duplicateCrmRow:true });
        differences++;
        continue;
      }
      const crm = crmRows[0];
      const comparisons = [
        ['invoiceDate', clean(crm.saleDate, 8), normalized.invoiceDate],
        ['sellerIdentity', clean(crm.sellerAccountNumber, 200), normalized.sellerIdentity],
        ['quantity', exactQuantity(crm.qty), normalized.quantityExact],
        ['saleAmount', exactMoney(crm.saleValue), normalized.saleAmountExact]
      ];
      for (const [field, left, right] of comparisons) {
        if (right == null || right === '') continue;
        const comparison = compareExact(field, left, right);
        if (comparison.equal) continue;
        await persistComparisonDifference(db, run, reference, field, left, right, { comparison });
        differences++;
      }
      await db.collection(COMPARISON_ROWS).updateOne(
        { importId:run.importId, sourceRowNumber:reference.sourceRowNumber },
        { $set:{ comparedAt:new Date(), comparisonRunId:run.comparisonRunId, crmMatchCount:crmRows.length } }
      );
    }
    const hasMore = references.length === pageSize && await count(db.collection(COMPARISON_ROWS), {
      importId:run.importId, sourceRowNumber:{ $gt:maximumRow }
    }) > 0;
    const now = new Date();
    const nextProgress = {
      checkpointRowNumber:maximumRow,
      rowsCompared:Number(run.progress?.rowsCompared || 0) + compared,
      differences:Number(run.progress?.differences || 0) + differences,
      durationMs:Number(run.progress?.durationMs || 0) + (Date.now() - started)
    };
    const nextStatus = hasMore ? 'running' : 'blocked_human_review';
    await db.collection(COMPARISON_RUNS).updateOne({ comparisonRunId:run.comparisonRunId, 'lock.token':lock.token }, {
      $set:{
        status:nextStatus, progress:nextProgress, comparisonCompleted:!hasMore,
        completedAt:hasMore ? null : now, updatedAt:now
      },
      $unset:{ lock:'' }, $inc:{ revision:1 },
      $push:{ auditLog:{ $each:[audit('comparison-batch-executed', current, { compared, differences, hasMore, checkpoint:maximumRow })], $slice:-500 } }
    });
    const saved = await db.collection(COMPARISON_RUNS).findOne({ comparisonRunId:run.comparisonRunId });
    return { ok:true, run:saved, batch:{ compared, differences, durationMs:Date.now() - started }, hasMore, accountingPass:false, automaticPass:false };
  } catch (error) {
    await db.collection(COMPARISON_RUNS).updateOne({ comparisonRunId:run.comparisonRunId, 'lock.token':lock.token }, {
      $set:{ status:'paused', lastError:clean(error.message, 1000), updatedAt:new Date() },
      $unset:{ lock:'' },
      $push:{ auditLog:{ $each:[audit('comparison-run-interrupted', current, { checkpoint:maximumRow, error:error.message })], $slice:-500 } }
    }).catch(() => {});
    throw error;
  }
}

async function recoverComparisonRun(db, comparisonRunId, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const run = await db.collection(COMPARISON_RUNS).findOne({ comparisonRunId:clean(comparisonRunId, 100) });
  if (!run) fail('ACCOUNTING_COMPARISON_RUN_NOT_FOUND', 'Comparison run پیدا نشد.', 404);
  if (Number(input.revision) !== Number(run.revision)) fail('ACCOUNTING_COMPARISON_RUN_CONFLICT', 'Revision Comparison run منقضی است.', 409);
  if (run.lock?.expiresAt && new Date(run.lock.expiresAt).getTime() > Date.now()) fail('ACCOUNTING_COMPARISON_RUN_LOCKED', 'Lock هنوز معتبر است.', 409);
  const next = {
    status:'prepared', lastError:'', revision:Number(run.revision) + 1,
    auditLog:[...(run.auditLog || []), audit('comparison-run-recovered', current, { checkpoint:run.progress?.checkpointRowNumber })].slice(-500),
    updatedAt:new Date()
  };
  const result = await db.collection(COMPARISON_RUNS).updateOne({ comparisonRunId:run.comparisonRunId, revision:run.revision }, { $set:next, $unset:{ lock:'' } });
  if (!result.matchedCount) fail('ACCOUNTING_COMPARISON_RUN_CONFLICT', 'Comparison run هم‌زمان تغییر کرده است.', 409);
  return { ok:true, run:{ ...run, ...next, lock:null }, checkpointPreserved:true, differencesPreserved:true };
}

async function listComparisonDifferences(db, filters = {}) {
  const query = {};
  if (filters.comparisonRunId) query.comparisonRunId = clean(filters.comparisonRunId, 100);
  if (filters.sessionId) query.sessionId = clean(filters.sessionId, 100);
  if (filters.classification) {
    const classification = clean(filters.classification, 100);
    if (!DIFFERENCE_TYPES.includes(classification)) fail('ACCOUNTING_COMPARISON_CLASSIFICATION_INVALID', 'Classification اختلاف معتبر نیست.');
    query.classification = classification;
  }
  if (filters.status) query.status = clean(filters.status, 50);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), 200));
  const total = await count(db.collection(COMPARISON_DIFFERENCES), query);
  const list = await db.collection(COMPARISON_DIFFERENCES).find(query)
    .sort({ sourceRowNumber:1, field:1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
  const classificationCounts = await db.collection(COMPARISON_DIFFERENCES).aggregate([
    { $match:query },
    { $group:{ _id:'$classification', count:{ $sum:1 } } },
    { $sort:{ count:-1, _id:1 } }
  ]).toArray();
  return {
    ok:true, total, page, pageSize, list,
    classificationCounts:Object.fromEntries(classificationCounts.map(row => [row._id, Number(row.count || 0)])),
    immutable:true, decisionImportAllowed:false
  };
}

async function prepareFatRun(db, input = {}, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  await ensureIndexes(db);
  const session = await getSession(db, input.sessionId);
  const definitions = await db.collection(FAT_DEFINITIONS).find({ fatVersion:FAT_VERSION, enabled:{ $ne:false } }).sort({ scenarioCode:1 }).toArray();
  if (definitions.length < 12) fail('FAT_DEFINITIONS_MISSING', 'تعریف‌های FAT ابتدا باید initialize شوند.', 409);
  const fatRunId = deterministicId('FATRUN', `${session.sessionId}|${FAT_VERSION}`);
  if (await db.collection(FAT_RUNS).findOne({ fatRunId })) fail('FAT_RUN_DUPLICATE', 'FAT run برای این session قبلاً ساخته شده است.', 409);
  const scenarios = definitions.map(definition => ({
    definitionId:definition.definitionId,
    scenarioCode:definition.scenarioCode,
    title:definition.title,
    blockingSeverity:definition.blockingSeverity,
    technicalStatus:'pending', accountingStatus:'blocked_human_review',
    operationalStatus:'pending', humanApprovalStatus:'pending',
    status:'prepared', differences:0, evidenceCount:0
  }));
  const row = {
    fatRunId, schemaVersion:SCHEMA_VERSION, fatVersion:FAT_VERSION,
    sessionId:session.sessionId, frozen:{ ...session.frozen },
    scenarios, status:'prepared',
    dimensions:{ technical:'pending', accounting:'blocked_human_review', operational:'pending', humanApproval:'pending' },
    backupEvidence:boundedObject(input.backupEvidence || {}),
    rollbackEvidence:boundedObject(input.rollbackEvidence || {}),
    scenarioSummary:{ prepared:scenarios.length, passed:0, blocked:0, failed:0 },
    revision:1, createdBy:current,
    auditLog:[audit('fat-run-prepared', current, { scenarioCount:scenarios.length, sessionId:session.sessionId })],
    createdAt:new Date(), updatedAt:new Date(),
    automaticPass:false, accountingApproved:false, profitActivationAllowed:false
  };
  await db.collection(FAT_RUNS).insertOne(row);
  return { ok:true, run:row, automaticPass:false, profitActivationAllowed:false };
}

async function executeTechnicalFat(db, fatRunId, by = {}) {
  const current = requireRole(by, ['admin', 'accounting']);
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  if (['passed', 'passed_with_tolerance', 'cancelled'].includes(run.status)) fail('FAT_RUN_IMMUTABLE', 'FAT run نهایی immutable است.', 409);
  const session = await getSession(db, run.sessionId);
  const fifo = await db.collection('fifoDatasets').findOne({ datasetId:session.frozen.fifoDatasetId });
  const [invalidFifo, duplicateAllocations, comparisonReady, humanProgress, profitFacts, savedEntries, rateVersions, discountFacts, excelExports, tirIssues] = await Promise.all([
    count(db.collection('fifoDatasets'), { datasetId:session.frozen.fifoDatasetId, $or:[{status:{$ne:'completed'}},{activationStatus:{$ne:'validated-shadow'}}] }),
    db.collection('fifoAllocations').aggregate([
      { $match:{ datasetId:session.frozen.fifoDatasetId } },
      { $group:{ _id:'$allocationId', count:{ $sum:1 } } },
      { $match:{ count:{ $gt:1 } } }, { $count:'count' }
    ]).toArray().then(rows => rows[0]?.count || 0),
    count(db.collection(COMPARISON_IMPORTS), { frozenSessionId:session.sessionId, status:'ready' }),
    minimumTargetProgress(db, session),
    count(db.collection(profitLedger.FIFO_FACTS), { fifoDatasetId:session.frozen.fifoDatasetId }),
    db.collection(profitLedger.SAVED_LEDGER).find({}).toArray(),
    db.collection(profitLedger.RATE_VERSIONS).find({ status:'approved' }).toArray(),
    count(db.collection(profitLedger.DISCOUNT_FACTS), { saleSnapshotId:session.frozen.saleSnapshotId }),
    count(db.collection(profitLedger.EXPORT_BATCHES), { fifoDatasetId:session.frozen.fifoDatasetId }),
    count(db.collection(profitLedger.TIR_RECONSTRUCTION), { period:'140504' })
  ]);
  const backupReady = Boolean(run.backupEvidence?.path && run.backupEvidence?.sourceSha);
  const deterministicReady = Boolean(fifo?.deterministicReplayVerified && fifo?.sourceFingerprint && fifo?.allocationFingerprint);
  const savedLedgerStructurallyValid = savedEntries.length > 0 && savedEntries.every(row =>
    ['NOTEBOOK','COMPONENT'].includes(row.pool) &&
    ((decimal.parse(row.debitAmountExact || 0, decimal.MONEY_SCALE) > 0n) !== (decimal.parse(row.creditAmountExact || 0, decimal.MONEY_SCALE) > 0n))
  );
  const normalizedRates = rateVersions.map(row => profitLedger._normalizedStoredRate(row));
  const approvedRateOverlap = normalizedRates.some((row,index) => normalizedRates.slice(index + 1).some(other =>
    row.sellerIdentity === other.sellerIdentity && row.rateScope === other.rateScope &&
    (row.rateScope === 'product_category'
      ? row.officialProductCategoryIdentity === other.officialProductCategoryIdentity
      : row.commissionRatePool === other.commissionRatePool) &&
    row.effectiveFrom <= (other.effectiveTo || '99999999') && other.effectiveFrom <= (row.effectiveTo || '99999999')
  ));
  const profitFactReady = profitFacts > 0;
  const scenarioEvidence = {
    'FAT-01':{ technicalStatus:comparisonReady ? 'ready' : 'blocked_missing_evidence', status:comparisonReady ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-02':{ technicalStatus:fifo?.validation?.valid ? 'technical_pass' : 'failed', status:'blocked_human_review' },
    'FAT-03':{ technicalStatus:comparisonReady ? 'ready' : 'blocked_missing_evidence', status:comparisonReady ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-04':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-05':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-06':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-07':{ technicalStatus:deterministicReady ? 'technical_pass' : 'blocked_missing_evidence', status:'blocked_human_review' },
    'FAT-08':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-09':{ technicalStatus:!invalidFifo && !duplicateAllocations ? 'technical_pass' : 'failed', status:'blocked_human_review' },
    'FAT-10':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-11':{ technicalStatus:backupReady ? 'technical_pass' : 'blocked_missing_evidence', status:backupReady ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-12':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-13':{ technicalStatus:profitFactReady ? 'technical_pass' : 'blocked_missing_evidence', status:profitFactReady ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-14':{ technicalStatus:'ready', status:'blocked_human_review' },
    'FAT-15':{ technicalStatus:savedLedgerStructurallyValid ? 'technical_pass' : (savedEntries.length ? 'failed' : 'blocked_missing_evidence'), status:savedLedgerStructurallyValid ? 'blocked_human_review' : (savedEntries.length ? 'failed' : 'blocked_missing_evidence') },
    'FAT-16':{ technicalStatus:savedLedgerStructurallyValid ? 'technical_pass' : (savedEntries.length ? 'failed' : 'blocked_missing_evidence'), status:savedLedgerStructurallyValid ? 'blocked_human_review' : (savedEntries.length ? 'failed' : 'blocked_missing_evidence') },
    'FAT-17':{ technicalStatus:approvedRateOverlap ? 'failed' : (rateVersions.length ? 'technical_pass' : 'blocked_missing_evidence'), status:approvedRateOverlap ? 'failed' : (rateVersions.length ? 'blocked_human_review' : 'blocked_missing_evidence') },
    'FAT-18':{ technicalStatus:discountFacts ? 'technical_pass' : 'blocked_missing_evidence', status:discountFacts ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-19':{ technicalStatus:excelExports ? 'technical_pass' : 'blocked_missing_evidence', status:excelExports ? 'blocked_human_review' : 'blocked_missing_evidence' },
    'FAT-20':{ technicalStatus:tirIssues >= 13 ? 'technical_pass' : 'blocked_missing_evidence', status:tirIssues >= 13 ? 'blocked_human_review' : 'blocked_missing_evidence' }
  };
  const scenarios = run.scenarios.map(row => ({ ...row, ...(scenarioEvidence[row.scenarioCode] || {}), accountingStatus:'blocked_human_review', humanApprovalStatus:'pending' }));
  const anyFailed = scenarios.some(row => row.technicalStatus === 'failed');
  const missing = scenarios.some(row => row.status === 'blocked_missing_evidence');
  const status = anyFailed ? 'failed' : (missing ? 'blocked_missing_evidence' : 'blocked_human_review');
  const now = new Date();
  const next = {
    scenarios, status,
    dimensions:{
      technical:anyFailed ? 'failed' : (missing ? 'partial' : 'technical_pass'),
      accounting:'blocked_human_review', operational:'pending', humanApproval:'pending'
    },
    scenarioSummary:{
      prepared:scenarios.filter(row => row.status === 'prepared').length,
      technicalPass:scenarios.filter(row => row.technicalStatus === 'technical_pass').length,
      blocked:scenarios.filter(row => row.status.startsWith('blocked_')).length,
      failed:scenarios.filter(row => row.technicalStatus === 'failed').length
    },
    technicalEvidence:{ invalidFifo, duplicateAllocations, comparisonReady, humanMinimumTargetsMet:humanProgress.met, deterministicReplayVerified:deterministicReady, backupReady, profitFacts, savedLedgerStructurallyValid, approvedRateOverlap, discountFacts, excelExports, tirIssues },
    revision:Number(run.revision) + 1,
    auditLog:[...(run.auditLog || []), audit('fat-technical-evaluation', current, { status, invalidFifo, duplicateAllocations, comparisonReady, deterministicReady, backupReady })].slice(-500),
    updatedAt:now
  };
  const result = await db.collection(FAT_RUNS).updateOne({ fatRunId:run.fatRunId, revision:run.revision }, { $set:next });
  if (!result.matchedCount) fail('FAT_RUN_CONFLICT', 'FAT run هم‌زمان تغییر کرده است.', 409);
  return { ok:true, run:{ ...run, ...next }, automatedTechnicalChecksOnly:true, accountingPass:false, automaticApproval:false };
}

function dimensionPassed(value) {
  return ['technical_pass', 'operational_pass', 'passed', 'passed_with_tolerance'].includes(clean(value, 50));
}

async function recalculateFatRun(db, fatRunId) {
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  const [definitions, approvals, evidence, differences] = await Promise.all([
    db.collection(FAT_DEFINITIONS).find({ fatVersion:run.fatVersion, enabled:{ $ne:false } }).toArray(),
    db.collection(FAT_APPROVALS).find({ fatRunId:run.fatRunId }).toArray(),
    db.collection(FAT_EVIDENCE).find({ fatRunId:run.fatRunId }).sort({ createdAt:1 }).toArray(),
    db.collection(FAT_DIFFERENCES).find({ fatRunId:run.fatRunId }).toArray()
  ]);
  const definitionByCode = new Map(definitions.map(row => [row.scenarioCode, row]));
  let toleranceUsed = false;
  const scenarios = run.scenarios.map(scenario => {
    const scenarioEvidence = evidence.filter(row => row.scenarioCode === scenario.scenarioCode && row.dimension && row.result);
    const latestTechnical = scenarioEvidence.filter(row => row.dimension === 'technical').at(-1);
    const latestOperational = scenarioEvidence.filter(row => row.dimension === 'operational').at(-1);
    const evidenceStatus = (row, dimension) => !row ? scenario[`${dimension}Status`]
      : row.result === 'passed' ? `${dimension}_pass` : row.result;
    const technicalStatus = evidenceStatus(latestTechnical, 'technical');
    const operationalStatus = evidenceStatus(latestOperational, 'operational');
    const definition = definitionByCode.get(scenario.scenarioCode) || {};
    const scenarioApprovals = approvals.filter(row => row.scenarioCode === scenario.scenarioCode);
    const rejected = scenarioApprovals.some(row => row.decision === 'rejected');
    const requiredRoles = definition.approvalRequirements || [];
    const approvedRoles = new Set(scenarioApprovals.filter(row => row.decision === 'approved').map(row => row.role));
    const approvalsComplete = requiredRoles.every(role => approvedRoles.has(role));
    const technicalComplete = dimensionPassed(technicalStatus);
    const operationalComplete = dimensionPassed(operationalStatus);
    const usedTolerance = [technicalStatus, operationalStatus].includes('passed_with_tolerance');
    toleranceUsed ||= usedTolerance;
    const missingEvidence = [technicalStatus, operationalStatus].includes('blocked_missing_evidence');
    const failed = rejected || [technicalStatus, operationalStatus].includes('failed');
    const status = failed ? 'failed'
      : missingEvidence ? 'blocked_missing_evidence'
        : !technicalComplete || !operationalComplete ? 'prepared'
          : !approvalsComplete ? 'blocked_human_review'
            : usedTolerance ? 'passed_with_tolerance' : 'passed';
    return {
      ...scenario,
      technicalStatus,
      accountingStatus:requiredRoles.includes('accounting') ? (approvedRoles.has('accounting') ? 'approved' : 'blocked_human_review') : 'not_required',
      operationalStatus,
      humanApprovalStatus:approvalsComplete ? 'approved' : 'pending',
      approvalRolesRequired:requiredRoles,
      approvalRolesCompleted:[...approvedRoles],
      evidenceCount:evidence.filter(row => row.scenarioCode === scenario.scenarioCode).length,
      differences:differences.filter(row => row.scenarioCode === scenario.scenarioCode).length,
      status
    };
  });
  const anyFailed = scenarios.some(row => row.status === 'failed');
  const missing = scenarios.some(row => row.status === 'blocked_missing_evidence' || row.status === 'prepared');
  const humanBlocked = scenarios.some(row => row.status === 'blocked_human_review');
  const allPassed = scenarios.length > 0 && scenarios.every(row => ['passed', 'passed_with_tolerance'].includes(row.status));
  const status = anyFailed ? 'failed'
    : missing ? 'blocked_missing_evidence'
      : humanBlocked ? 'blocked_human_review'
        : allPassed ? (toleranceUsed ? 'passed_with_tolerance' : 'passed')
          : 'prepared';
  const next = {
    scenarios, status,
    dimensions:{
      technical:scenarios.every(row => dimensionPassed(row.technicalStatus)) ? 'passed' : (anyFailed ? 'failed' : 'incomplete'),
      accounting:scenarios.every(row => row.accountingStatus === 'approved' || row.accountingStatus === 'not_required') ? 'passed' : 'blocked_human_review',
      operational:scenarios.every(row => dimensionPassed(row.operationalStatus)) ? 'passed' : 'incomplete',
      humanApproval:scenarios.every(row => row.humanApprovalStatus === 'approved') ? 'passed' : 'pending'
    },
    scenarioSummary:{
      prepared:scenarios.filter(row => row.status === 'prepared').length,
      passed:scenarios.filter(row => row.status === 'passed').length,
      passedWithTolerance:scenarios.filter(row => row.status === 'passed_with_tolerance').length,
      blocked:scenarios.filter(row => row.status.startsWith('blocked_')).length,
      failed:scenarios.filter(row => row.status === 'failed').length
    },
    accountingApproved:allPassed,
    profitActivationAllowed:false,
    updatedAt:new Date()
  };
  await db.collection(FAT_RUNS).updateOne({ fatRunId:run.fatRunId }, { $set:next, $inc:{ revision:1 } });
  return { ...run, ...next, revision:Number(run.revision || 0) + 1 };
}

async function recordFatDifference(db, fatRunId, input = {}, by = {}) {
  const current = requireRole(by);
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  if (['passed', 'passed_with_tolerance', 'cancelled'].includes(run.status)) fail('FAT_RUN_IMMUTABLE', 'FAT run نهایی immutable است.', 409);
  const scenarioCode = clean(input.scenarioCode, 50);
  if (!run.scenarios.some(row => row.scenarioCode === scenarioCode)) fail('FAT_SCENARIO_NOT_FOUND', 'Scenario در FAT run موجود نیست.', 404);
  const classification = clean(input.classification, 100);
  if (!DIFFERENCE_TYPES.includes(classification)) fail('FAT_DIFFERENCE_CLASSIFICATION_INVALID', 'Classification اختلاف FAT معتبر نیست.');
  const field = clean(input.field, 100);
  const evidenceReference = clean(input.evidenceReference, 1000);
  if (!field || !evidenceReference) fail('FAT_DIFFERENCE_EVIDENCE_REQUIRED', 'Field و Evidence reference برای اختلاف FAT الزامی است.');
  const crmValue = clean(input.crmValue, 2000);
  const referenceValue = clean(input.referenceValue, 2000);
  const differenceId = deterministicId('FATDIFF', stable([
    run.fatRunId, scenarioCode, classification, field, crmValue, referenceValue, evidenceReference
  ]));
  const row = {
    differenceId, fatRunId:run.fatRunId, sessionId:run.sessionId, scenarioCode,
    classification, field, crmValue, referenceValue,
    differenceExact:clean(input.differenceExact, 200),
    evidenceReference,
    notes:clean(input.notes, 2000),
    toleranceUsed:input.toleranceUsed === true,
    tolerancePolicy:clean(input.tolerancePolicy, 1000),
    frozen:{ ...run.frozen }, status:'unreviewed', immutable:true,
    recordedBy:current, createdAt:new Date(), accountingApproval:false
  };
  if (row.toleranceUsed && !row.tolerancePolicy) fail('FAT_DIFFERENCE_TOLERANCE_POLICY_REQUIRED', 'Tolerance اختلاف باید policy مستند داشته باشد.');
  const result = await db.collection(FAT_DIFFERENCES).updateOne({ differenceId }, { $setOnInsert:row }, { upsert:true });
  const updatedRun = await recalculateFatRun(db, run.fatRunId);
  return { ok:true, difference:row, duplicate:!result.upsertedCount, run:updatedRun, automaticApproval:false };
}

async function recordFatEvidence(db, fatRunId, input = {}, by = {}) {
  const current = requireRole(by);
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  const scenarioCode = clean(input.scenarioCode, 50);
  if (!run.scenarios.some(row => row.scenarioCode === scenarioCode)) fail('FAT_SCENARIO_NOT_FOUND', 'Scenario در FAT run موجود نیست.', 404);
  const evidenceType = clean(input.evidenceType, 100);
  const evidenceReference = clean(input.evidenceReference, 1000);
  if (!evidenceType || !evidenceReference) fail('FAT_EVIDENCE_REQUIRED', 'نوع و مرجع Evidence الزامی است.');
  const payload = boundedObject(input.payload || {}, 80, 4000);
  const dimension = clean(input.dimension, 30);
  const resultStatus = clean(input.result, 50);
  if (dimension && !['technical', 'operational'].includes(dimension)) fail('FAT_EVIDENCE_DIMENSION_INVALID', 'Dimension باید technical یا operational باشد.');
  if (resultStatus && !['passed', 'passed_with_tolerance', 'failed', 'blocked_missing_evidence'].includes(resultStatus)) fail('FAT_EVIDENCE_RESULT_INVALID', 'نتیجه Evidence معتبر نیست.');
  if (dimension === 'operational' && !['manager', 'admin'].includes(current.role)) fail('FAT_OPERATIONAL_EVIDENCE_MANAGER_REQUIRED', 'Operational result فقط توسط Manager/Admin مجاز است.', 403);
  if (dimension === 'technical' && !['admin', 'accounting'].includes(current.role)) fail('FAT_TECHNICAL_EVIDENCE_ROLE_REQUIRED', 'Technical result فقط توسط Admin/Accounting مجاز است.', 403);
  if (resultStatus === 'passed_with_tolerance' && (!clean(input.tolerancePolicy, 1000) || !clean(input.toleranceApprovalReference, 1000))) {
    fail('FAT_TOLERANCE_EVIDENCE_REQUIRED', 'Tolerance غیرصفر باید policy و approval reference داشته باشد.');
  }
  const evidenceHash = sha256(stable({ scenarioCode, evidenceType, evidenceReference, payload, dimension, resultStatus, tolerancePolicy:input.tolerancePolicy, toleranceApprovalReference:input.toleranceApprovalReference }));
  const evidenceId = deterministicId('FATEVID', `${run.fatRunId}|${evidenceHash}`);
  const row = {
    evidenceId, fatRunId:run.fatRunId, sessionId:run.sessionId, scenarioCode,
    evidenceType, evidenceReference, payload, evidenceHash,
    dimension, result:resultStatus,
    tolerancePolicy:clean(input.tolerancePolicy, 1000),
    toleranceApprovalReference:clean(input.toleranceApprovalReference, 1000),
    sourceDatasetIds:{ ...run.frozen }, immutable:true,
    recordedBy:current, createdAt:new Date(),
    accountingApproval:false
  };
  const result = await db.collection(FAT_EVIDENCE).updateOne({ evidenceId }, { $setOnInsert:row }, { upsert:true });
  const updatedRun = await recalculateFatRun(db, run.fatRunId);
  return { ok:true, evidence:row, duplicate:!result.upsertedCount, run:updatedRun, approvalImplied:false };
}

async function approveFatScenario(db, fatRunId, input = {}, by = {}) {
  const current = requireRole(by, ['accounting', 'manager', 'admin']);
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  const session = await getSession(db, run.sessionId);
  const scenarioCode = clean(input.scenarioCode, 50);
  if (!run.scenarios.some(row => row.scenarioCode === scenarioCode)) fail('FAT_SCENARIO_NOT_FOUND', 'Scenario در FAT run موجود نیست.', 404);
  if (current.role === 'accounting' && current.username !== session.assignedAccountingUser.username) fail('FAT_ACCOUNTING_ASSIGNEE_REQUIRED', 'فقط Accounting تعیین‌شده مجاز است.', 403);
  if (['manager', 'admin'].includes(current.role) && current.username !== session.assignedManagerUser.username) fail('FAT_MANAGER_ASSIGNEE_REQUIRED', 'فقط Manager/Admin تعیین‌شده مجاز است.', 403);
  if (current.role === 'admin' && clean(input.authorizedScope, 50) !== 'manager') fail('FAT_ADMIN_MANAGER_SCOPE_REQUIRED', 'Admin باید manager scope را صریحاً اعلام کند.', 403);
  if (current.username === actor(run.createdBy).username) fail('FAT_SELF_APPROVAL_FORBIDDEN', 'Creator نمی‌تواند FAT خود را approve کند.', 409);
  const decision = clean(input.decision, 30);
  if (!['approved', 'rejected'].includes(decision)) fail('FAT_APPROVAL_DECISION_INVALID', 'Decision باید approved یا rejected باشد.');
  const reason = clean(input.reason, 2000), evidenceReference = clean(input.evidenceReference, 1000);
  if (!reason || !evidenceReference) fail('FAT_APPROVAL_EVIDENCE_REQUIRED', 'دلیل و Evidence الزامی است.');
  const approvalRole = current.role === 'admin' ? 'manager' : current.role;
  const approvalId = deterministicId('FATAPP', `${run.fatRunId}|${scenarioCode}|${approvalRole}|${current.username}`);
  const row = { approvalId, fatRunId:run.fatRunId, sessionId:run.sessionId, scenarioCode, decision, reason, evidenceReference, username:current.username, role:approvalRole, actualRole:current.role, authorizedScope:current.role === 'admin' ? 'manager' : current.role, approvedBy:current, createdAt:new Date(), immutable:true };
  if (await db.collection(FAT_APPROVALS).findOne({ approvalId })) fail('FAT_APPROVAL_DUPLICATE', 'Approval قبلاً ثبت شده است.', 409);
  await db.collection(FAT_APPROVALS).insertOne(row);
  const updatedRun = await recalculateFatRun(db, run.fatRunId);
  return { ok:true, approval:row, run:updatedRun, runAutomaticallyPassed:false, profitActivationAllowed:false };
}

async function listFatDefinitions(db) {
  const list = await db.collection(FAT_DEFINITIONS).find({ fatVersion:FAT_VERSION }).sort({ scenarioCode:1 }).toArray();
  return { ok:true, fatVersion:FAT_VERSION, total:list.length, list };
}
async function listFatRuns(db, filters = {}) {
  const query = {};
  if (filters.sessionId) query.sessionId = clean(filters.sessionId, 100);
  if (filters.status) query.status = clean(filters.status, 50);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 25), 100));
  const total = await count(db.collection(FAT_RUNS), query);
  const list = await db.collection(FAT_RUNS).find(query).sort({ createdAt:-1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
  return { ok:true, total, page, pageSize, list };
}

async function fatRunReport(db, fatRunId, filters = {}) {
  const run = await db.collection(FAT_RUNS).findOne({ fatRunId:clean(fatRunId, 100) });
  if (!run) fail('FAT_RUN_NOT_FOUND', 'FAT run پیدا نشد.', 404);
  const scenarioCode = clean(filters.scenarioCode, 50);
  if (scenarioCode && !run.scenarios.some(row => row.scenarioCode === scenarioCode)) {
    fail('FAT_SCENARIO_NOT_FOUND', 'Scenario در FAT run موجود نیست.', 404);
  }
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), 200));
  const evidenceQuery = { fatRunId:run.fatRunId };
  const approvalQuery = { fatRunId:run.fatRunId };
  const differenceQuery = { fatRunId:run.fatRunId };
  if (scenarioCode) {
    evidenceQuery.scenarioCode = scenarioCode;
    approvalQuery.scenarioCode = scenarioCode;
    differenceQuery.scenarioCode = scenarioCode;
  }
  const [evidenceTotal, approvalTotal, differenceTotal, evidence, approvals, differences] = await Promise.all([
    count(db.collection(FAT_EVIDENCE), evidenceQuery),
    count(db.collection(FAT_APPROVALS), approvalQuery),
    count(db.collection(FAT_DIFFERENCES), differenceQuery),
    db.collection(FAT_EVIDENCE).find(evidenceQuery).sort({ createdAt:1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    db.collection(FAT_APPROVALS).find(approvalQuery).sort({ createdAt:1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    db.collection(FAT_DIFFERENCES).find(differenceQuery).sort({ createdAt:1 }).skip((page - 1) * pageSize).limit(pageSize).toArray()
  ]);
  return {
    ok:true, run, page, pageSize,
    totals:{ evidence:evidenceTotal, approvals:approvalTotal, differences:differenceTotal },
    evidence, approvals, differences,
    immutableEvidence:true,
    automaticApproval:false,
    profitActivationAllowed:false
  };
}

async function coverageSimulator(db, sessionId, input = {}) {
  const session = await getSession(db, sessionId);
  const base = await lightweightReadinessSummary(db, session.frozen.fifoDatasetId);
  const proposals = Array.isArray(input.decisions) ? input.decisions.slice(0, 1000) : [];
  const returnIds = proposals.filter(row => row.type === 'return' && ['confirmed_linked', 'confirmed_unmatched'].includes(row.decision)).map(row => clean(row.id, 100));
  const sampleIds = proposals.filter(row => row.type === 'sample' && HUMAN_DECISIONS.has(row.decision)).map(row => clean(row.id, 100));
  const evidenceIds = proposals.filter(row => row.type === 'investigation' && HUMAN_DECISIONS.has(row.decision)).map(row => clean(row.id, 100));
  const [returnCases, samples, investigations] = await Promise.all([
    db.collection(operational.RETURN_CASES).find({ sourceFifoDatasetId:session.frozen.fifoDatasetId, caseId:{ $in:returnIds } }).toArray(),
    db.collection(readiness.SAMPLES).find({ datasetId:session.frozen.fifoDatasetId, sampleId:{ $in:sampleIds } }).toArray(),
    db.collection(operational.INVESTIGATIONS).find({ sourceFifoDatasetId:session.frozen.fifoDatasetId, investigationId:{ $in:evidenceIds } }).toArray()
  ]);
  const current = base.confidence.components;
  const returnTotal = Number(base.confidence.totals.purchaseReturns || 0) + Number(base.confidence.totals.saleReturns || 0);
  const currentLinked = Math.round(returnTotal * finite(current.returnLinkageCoverage) / 100);
  const projectedReturn = percentage(Math.min(returnTotal, currentLinked + returnCases.length), returnTotal);
  const reviewTotal = Number(base.evidence.total || 0) + Number(base.samples.total || 0);
  const currentReviewed = Number(base.confidence.totals.reviewedEvidence || 0) + Number(base.confidence.totals.reviewedSamples || 0);
  const projectedReview = percentage(Math.min(reviewTotal, currentReviewed + samples.length + investigations.length), reviewTotal);
  const components = { ...current, returnLinkageCoverage:projectedReturn, accountingReviewCoverage:projectedReview };
  const projectedConfidence = round(Object.entries(base.confidence.weights).reduce((sum, [name, weight]) => sum + finite(components[name]) * finite(weight), 0), 2);
  return {
    ok:true, sessionId:session.sessionId, mode:'PROJECTED_READ_ONLY',
    actual:{
      quantityCoverage:current.quantityCostCoverage,
      saleValueCoverage:current.saleValueCostCoverage,
      lineCoverage:current.lineCoverage,
      returnLinkageCoverage:current.returnLinkageCoverage,
      accountingConfidenceIndex:base.confidence.index,
      unknownSaleValue:base.evidence.affectedSaleValue,
      unknownQuantity:base.evidence.affectedQuantity
    },
    projected:{
      quantityCoverage:current.quantityCostCoverage,
      saleValueCoverage:current.saleValueCostCoverage,
      lineCoverage:current.lineCoverage,
      returnLinkageCoverage:projectedReturn,
      accountingConfidenceIndex:projectedConfidence,
      unknownSaleValue:base.evidence.affectedSaleValue,
      unknownQuantity:base.evidence.affectedQuantity
    },
    acceptedProposalCounts:{ returnLinks:returnCases.length, samples:samples.length, investigations:investigations.length },
    limitations:[
      'Return review can project linkage and review coverage only; it does not invent purchase cost.',
      'Unknown value and cost coverage remain unchanged until an isolated FIFO rerun proves the effect.',
      'Projected values are not approved accounting values.'
    ],
    workflowWrites:0, sourceDatasetWrites:0, accountingApproved:false, profitActivationAllowed:false
  };
}

async function fifoRerunGate(db, sessionId) {
  const session = await getSession(db, sessionId);
  const since = session.startedAt || session.createdAt;
  const [manuals, purchaseReturns, saleReturns, recoveries, identities] = await Promise.all([
    db.collection('manualCostResolutions').find({ status:'approved', approvedAt:{ $gte:since } }, { projection:{ _id:0, resolutionId:1 } }).limit(1000).toArray(),
    db.collection(readiness.PURCHASE_RETURNS).find({ sourcePurchaseDatasetId:session.frozen.purchaseDatasetId, status:{ $in:['confirmed_linked', 'confirmed_unmatched'] }, approvedAt:{ $gte:since } }, { projection:{ _id:0, resolutionId:1 } }).limit(1000).toArray(),
    db.collection(readiness.SALE_RETURNS).find({ sourceSaleSnapshotId:session.frozen.saleSnapshotId, status:{ $in:['confirmed_linked', 'confirmed_unmatched'] }, approvedAt:{ $gte:since } }, { projection:{ _id:0, resolutionId:1 } }).limit(1000).toArray(),
    db.collection(operational.RECOVERY).find({ sourceFifoDatasetId:session.frozen.fifoDatasetId, status:'approved_for_dataset_rebuild', approvedAt:{ $gte:since } }, { projection:{ _id:0, candidateId:1 } }).limit(1000).toArray(),
    db.collection(operational.IDENTITIES).find({ sourceFifoDatasetId:session.frozen.fifoDatasetId, status:'approved', approvedAt:{ $gte:since } }, { projection:{ _id:0, resolutionId:1 } }).limit(1000).toArray()
  ]);
  const approvedDecisionIds = [
    ...manuals.map(row => row.resolutionId), ...purchaseReturns.map(row => row.resolutionId),
    ...saleReturns.map(row => row.resolutionId), ...recoveries.map(row => row.candidateId),
    ...identities.map(row => row.resolutionId)
  ].filter(Boolean);
  return {
    ok:true, sessionId:session.sessionId,
    allowed:approvedDecisionIds.length > 0,
    approvedDecisionIds,
    priorFifoDatasetId:session.frozen.fifoDatasetId,
    sourceSaleSnapshotId:session.frozen.saleSnapshotId,
    sourcePurchaseDatasetId:session.frozen.purchaseDatasetId,
    algorithmVersion:session.frozen.fifoAlgorithmVersion,
    expectedProjectedImpact:session.preparationSummary?.projectedUnknownValueReduction || 0,
    shadowOnly:true, accountingApproved:false, profitActivationAllowed:false,
    reason:approvedDecisionIds.length ? 'authorized-accounting-decision-present' : 'no-authorized-accounting-decision'
  };
}

async function exportSession(db, sessionId) {
  const report = await sessionReport(db, sessionId);
  const session = report.session;
  const rows = [];
  for (const [category, ids] of Object.entries(session.priorityManifest || {})) {
    for (const id of ids) rows.push({ sessionId:session.sessionId, category, recordId:id, frozenFifoDatasetId:session.frozen.fifoDatasetId, status:session.status, revision:session.revision });
  }
  return { ok:true, exportedAt:new Date().toISOString(), immutableColumns:['sessionId', 'category', 'recordId', 'frozenFifoDatasetId', 'revision'], rows, decisionImportAllowed:false };
}

module.exports = {
  SESSIONS, COMPARISON_IMPORTS, COMPARISON_ROWS, COMPARISON_RUNS,
  COMPARISON_DIFFERENCES, FAT_DEFINITIONS, FAT_RUNS, FAT_EVIDENCE,
  FAT_DIFFERENCES, FAT_APPROVALS, OWNED_COLLECTIONS,
  SCHEMA_VERSION, MODULE_VERSION, FAT_VERSION, COMPARISON_VERSION,
  SESSION_STATUSES, FAT_RUN_STATUSES, DIFFERENCE_TYPES, LOGICAL_FIELDS,
  FAT_SCENARIOS, ensureIndexes, initializeFatDefinitions,
  createSession, listSessions, getSession, transitionSession, sessionReport,
  minimumTargetProgress, createComparisonImport, ingestComparisonRows,
  recoverComparisonImport, cancelComparisonImport, prepareComparisonRun,
  executeComparisonBatch, recoverComparisonRun, listComparisonDifferences,
  validateMapping, normalizeComparisonRow, classifyDifference, compareExact,
  prepareFatRun, executeTechnicalFat, recordFatEvidence, recordFatDifference, approveFatScenario,
  listFatDefinitions, listFatRuns, fatRunReport, lightweightReadinessSummary,
  coverageSimulator, fifoRerunGate, exportSession
};
