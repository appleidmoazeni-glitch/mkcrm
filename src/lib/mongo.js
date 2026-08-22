const { MongoClient } = require('mongodb');
const { config } = require('./config');
let client;
let db;

async function connectMongo() {
  if (db) return db;
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  await client.connect();
  db = client.db();
  return db;
}

async function closeMongo() {
  if (client) await client.close();
  client = null; db = null;
}

async function initMongo() {
  const database = await connectMongo();
  const collections = await database.listCollections().toArray();
  const existing = new Set(collections.map(c => c.name));
  const needed = ['settings','customers','leads','invoiceReservations','invoiceCounters','invoiceAuditLogs','saleIssueLocks','saleIssuanceFingerprintLocks','userShayganMappings','userAccountAccesses','proformas','itemCatalog','itemCatalogAll','itemCatalogReconciliationAudit','itemInventoryCatalog','purchaseHistoryDiscoveryQueue','inventoryDiscoveryVerificationQueue','accountCatalog','searchCache','appLogs','purchaseDrafts','customerInvoiceHistory','customerSyncRuns','users','roles','boardEvents','sellerPerformanceHistory','stockSleepSnapshots','stockSleepQueue','stockSleepItemLayers','stockSleepSupplierSummary','stockSleepHistory','supplierPurchaseInvoices','supplierPurchaseLayers','purchaseLayerDatasets','purchaseLayerDatasetState','purchaseLayerDiagnostics','manualCostResolutions','openingAccountingCostBasis','financialSourceReviews','financialSourceReviewActions','openingInventoryEvidence','accountingCostEvidence','purchaseReturnResolutions','saleReturnResolutions','accountingValidationSamples','accountingReadinessState','accountingEvidenceInvestigations','purchaseLayerRecoveryCandidates','accountingItemIdentityResolutions','accountingReturnReviewCases','manualCostEvidencePackages','accountingReviewBatches','accountingReviewSessions','accountingComparisonImports','accountingComparisonRows','accountingComparisonRuns','accountingComparisonDifferences','fatDefinitions','fatRuns','fatEvidence','fatDifferences','fatApprovals','fifoDatasets','fifoAllocations','fifoDiagnostics','fifoExceptions','fifoDatasetState','supplierInventoryAllocation','supplierSleepSummary','supplierSleepSnapshots','saleSnapshots','saleInvoiceHeaders','saleInvoiceLines','saleSnapshotDiagnostics','saleSnapshotState','appJobs'];
  for (const name of needed) if (!existing.has(name)) await database.createCollection(name);
  await database.collection('settings').createIndex({ key: 1 }, { unique: true });
  await database.collection('customers').createIndex({ mobile: 1 });
  await database.collection('customers').createIndex({ nationalCode: 1 });

  await database.collection('customers').createIndex({ searchText: 1 });
  await database.collection('customers').createIndex({ purchaseCount: -1, totalPurchaseAmount: -1 });
  await database.collection('customers').createIndex({ lastPurchaseDate: -1 });
  await database.collection('customerInvoiceHistory').createIndex({ customerKey: 1, invDate: -1 });
  await database.collection('customerInvoiceHistory').createIndex({ invNo: 1, invTyp: 1 });
  await database.collection('customerSyncRuns').createIndex({ startedAt: -1 });
  await database.collection('leads').createIndex({ leadId: 1 }, { unique: true, sparse: true });
  await database.collection('invoiceReservations').createIndex({ invType: 1, invoiceNumber: 1 }, { unique: true });
  await database.collection('invoiceCounters').createIndex({ invType: 1 }, { unique: true });
  await database.collection('userShayganMappings').createIndex({ username: 1 });
  await database.collection('userAccountAccesses').createIndex({ username: 1 });
  await database.collection('proformas').createIndex({ proformaNo: 1 }, { unique: true });
  await database.collection('itemCatalog').createIndex({ itemCode: 1 }, { unique: true });
  await database.collection('itemCatalog').createIndex({ itemDescription: 'text', itemCode: 'text' });
  await database.collection('itemInventoryCatalog').createIndex({ itemCode: 1, stockNumber: 1 }, { unique: true });
  await database.collection('itemInventoryCatalog').createIndex({ searchText: 1 });
  await database.collection('itemCatalogAll').createIndex({ itemCode: 1 }, { unique: true });
  await database.collection('itemCatalogAll').createIndex({ itemGuid: 1 });
  await database.collection('itemCatalogAll').createIndex({ searchText: 1 });
  await database.collection('itemCatalogAll').createIndex({ canonicalIdentity:1 });
  await database.collection('itemCatalogAll').createIndex({ normalizedItemCode:1 });
  await database.collection('itemCatalogAll').createIndex({ canonicalItemGuid:1 });
  await database.collection('itemCatalogAll').createIndex({ historyCompleteness:1, updatedAt:-1 });
  await database.collection('itemCatalogReconciliationAudit').createIndex({ reconciliationId:1 }, { unique:true });
  await database.collection('itemCatalogReconciliationAudit').createIndex({ planFingerprint:1, status:1 });
  await database.collection('purchaseHistoryDiscoveryQueue').createIndex({ queueId:1 }, { unique:true });
  await database.collection('purchaseHistoryDiscoveryQueue').createIndex({ canonicalIdentity:1 }, { unique:true });
  await database.collection('purchaseHistoryDiscoveryQueue').createIndex({ status:1, updatedAt:1 });
  await database.collection('inventoryDiscoveryVerificationQueue').createIndex({ queueId:1 }, { unique:true });
  await database.collection('inventoryDiscoveryVerificationQueue').createIndex({ canonicalIdentity:1 }, { unique:true });
  await database.collection('inventoryDiscoveryVerificationQueue').createIndex({ status:1, attempts:1, createdAt:1 });
  await database.collection('itemInventoryCatalog').createIndex({ stockNumber:1, quantity:1, stockSyncBatchId:1, lastLiveVerifiedAt:1 });
  await database.collection('itemInventoryCatalog').createIndex({ needsLiveVerify:1, quantity:1, lastLiveAttemptAt:1, lastLiveVerifiedAt:1, firstMissingInStockAt:1 });
  await database.collection('accountCatalog').createIndex({ accountNumber: 1 }, { unique: true });
  await database.collection('accountCatalog').createIndex({ searchText: 1 });
  await database.collection('searchCache').createIndex({ key: 1 }, { unique: true });
  await database.collection('searchCache').createIndex({ updatedAt: 1 });
  await database.collection('users').createIndex({ username: 1 }, { unique: true });
  await database.collection('roles').createIndex({ code: 1 }, { unique: true });
  await database.collection('boardEvents').createIndex({ status: 1, createdAt: -1 });
  await database.collection('boardEvents').createIndex({ eventKey: 1 }, { unique: true, sparse: true });
  await database.collection('boardEvents').createIndex({ itemCode: 1, status: 1 });
  await database.collection('sellerPerformanceHistory').createIndex({ type: 1, filterKey: 1 });
  await database.collection('sellerPerformanceHistory').createIndex({ type: 1, generatedAt: -1 });
  await database.collection('stockSleepSnapshots').createIndex({ snapshotId: 1 }, { unique: true });
  await database.collection('stockSleepSnapshots').createIndex({ status: 1, startedAt: -1 });
  await database.collection('stockSleepQueue').createIndex({ snapshotId: 1, status: 1, lockedAt: 1 });
  await database.collection('stockSleepQueue').createIndex({ snapshotId: 1, itemCode: 1, warehouseNo: 1 }, { unique: true });
  await database.collection('stockSleepItemLayers').createIndex({ snapshotId: 1, supplierAccountNo: 1 });
  await database.collection('stockSleepItemLayers').createIndex({ snapshotId: 1, itemCode: 1, warehouseNo: 1 });
  await database.collection('stockSleepItemLayers').createIndex({ layerId: 1 }, { unique: true });
  await database.collection('stockSleepSupplierSummary').createIndex({ snapshotId: 1, supplierAccountNo: 1 }, { unique: true });
  await database.collection('stockSleepSupplierSummary').createIndex({ snapshotId: 1, remainingValue: -1 });
  await database.collection('stockSleepHistory').createIndex({ snapshotId: 1, at: -1 });

  await database.collection('saleSnapshots').createIndex({ snapshotId: 1 }, { unique: true });
  await database.collection('saleSnapshots').createIndex({ createdAt: -1 });
  await database.collection('saleInvoiceHeaders').createIndex({ invTyp: 1, invNo: 1 }, { unique: true });
  await database.collection('saleInvoiceHeaders').createIndex({ snapshotId: 1, invDate: 1 });
  await database.collection('saleInvoiceLines').createIndex({ saleInvoiceType: 1, saleInvoiceNo: 1, row: 1 }, { unique: true });
  await database.collection('saleInvoiceLines').createIndex({ snapshotId: 1, itemCode: 1 });
  await database.collection('saleInvoiceLines').createIndex({ itemCode: 1, saleDate: 1 });
  await database.collection('saleSnapshotDiagnostics').createIndex({ snapshotId: 1, at: -1 });
  await database.collection('saleSnapshotState').createIndex({ scopeKey: 1 }, { unique: true });
  await database.collection('manualCostResolutions').createIndex({ resolutionId: 1 }, { unique: true });
  await database.collection('manualCostResolutions').createIndex({ itemGuid: 1, status: 1, effectiveFrom: 1, effectiveTo: 1 });
  await database.collection('manualCostResolutions').createIndex({ itemCode: 1, status: 1, effectiveFrom: 1, effectiveTo: 1 });
  await database.collection('manualCostResolutions').createIndex({ status: 1, updatedAt: -1 });
  await database.collection('openingAccountingCostBasis').createIndex({ evidenceId:1 }, { unique:true });
  await database.collection('openingAccountingCostBasis').createIndex({ itemGuid:1, effectiveOpeningDate:1, status:1 });
  await database.collection('openingAccountingCostBasis').createIndex({ itemCode:1, effectiveOpeningDate:1, status:1 });
  await database.collection('financialSourceReviews').createIndex({ entityType:1, entityId:1 }, { unique:true });
  await database.collection('financialSourceReviews').createIndex({ state:1, updatedAt:-1 });
  await database.collection('financialSourceReviewActions').createIndex({ actionId:1 }, { unique:true });
  await database.collection('financialSourceReviewActions').createIndex({ entityType:1, entityId:1, lineIdentity:1, createdAt:-1 });
  await database.collection('financialSourceReviewActions').createIndex({ action:1, createdAt:-1 });
  await database.collection('openingInventoryEvidence').createIndex({ evidenceId:1 }, { unique:true });
  await database.collection('openingInventoryEvidence').createIndex({ status:1, updatedAt:-1 });
  await database.collection('openingInventoryEvidence').createIndex({ itemGuid:1, openingDate:1, status:1 });
  await database.collection('openingInventoryEvidence').createIndex({ itemCode:1, openingDate:1, status:1 });
  await database.collection('accountingCostEvidence').createIndex({ evidenceId: 1 }, { unique:true });
  await database.collection('accountingCostEvidence').createIndex({ sourceDatasetId:1, itemKey:1 }, { unique:true });
  await database.collection('accountingCostEvidence').createIndex({ status:1, priority:1, affectedSaleValue:-1 });
  await database.collection('accountingCostEvidence').createIndex({ assignedTo:1, updatedAt:-1 });
  await database.collection('purchaseReturnResolutions').createIndex({ resolutionId:1 }, { unique:true });
  await database.collection('purchaseReturnResolutions').createIndex({ sourcePurchaseDatasetId:1, returnLineIdentity:1 }, { unique:true });
  await database.collection('purchaseReturnResolutions').createIndex({ status:1, returnDate:1 });
  await database.collection('saleReturnResolutions').createIndex({ resolutionId:1 }, { unique:true });
  await database.collection('saleReturnResolutions').createIndex({ sourceSaleSnapshotId:1, returnLineIdentity:1 }, { unique:true });
  await database.collection('saleReturnResolutions').createIndex({ status:1, returnDate:1 });
  await database.collection('accountingValidationSamples').createIndex({ sampleId:1 }, { unique:true });
  await database.collection('accountingValidationSamples').createIndex({ datasetId:1, sampleKey:1 }, { unique:true });
  await database.collection('accountingValidationSamples').createIndex({ datasetId:1, reviewStatus:1, category:1 });
  await database.collection('accountingReadinessState').createIndex({ scopeKey:1 }, { unique:true });
  await database.collection('accountingEvidenceInvestigations').createIndex({ investigationId:1 }, { unique:true });
  await database.collection('accountingEvidenceInvestigations').createIndex({ sourceFifoDatasetId:1, evidenceId:1 }, { unique:true });
  await database.collection('accountingEvidenceInvestigations').createIndex({ sourceFifoDatasetId:1, priority:1, affectedSaleValue:-1 });
  await database.collection('purchaseLayerRecoveryCandidates').createIndex({ candidateId:1 }, { unique:true });
  await database.collection('purchaseLayerRecoveryCandidates').createIndex({ sourceFifoDatasetId:1, purchaseLineIdentity:1 }, { unique:true });
  await database.collection('purchaseLayerRecoveryCandidates').createIndex({ sourceFifoDatasetId:1, confidence:-1, purchaseDate:1 });
  await database.collection('accountingItemIdentityResolutions').createIndex({ resolutionId:1 }, { unique:true });
  await database.collection('accountingItemIdentityResolutions').createIndex({ sourceFifoDatasetId:1, sourceItemCode:1, targetItemCode:1, targetItemGuid:1 }, { unique:true });
  await database.collection('accountingItemIdentityResolutions').createIndex({ sourceFifoDatasetId:1, confidence:-1, sourceItemCode:1 });
  await database.collection('accountingReturnReviewCases').createIndex({ caseId:1 }, { unique:true });
  await database.collection('accountingReturnReviewCases').createIndex({ kind:1, resolutionId:1 }, { unique:true });
  await database.collection('accountingReturnReviewCases').createIndex({ sourceFifoDatasetId:1, financialImpact:-1, confidence:-1 });
  await database.collection('accountingReturnReviewCases').createIndex({ sourceFifoDatasetId:1, kind:1, financialImpact:-1, confidence:-1 });
  await database.collection('manualCostEvidencePackages').createIndex({ packageId:1 }, { unique:true });
  await database.collection('manualCostEvidencePackages').createIndex({ sourceFifoDatasetId:1, evidenceId:1 }, { unique:true });
  await database.collection('manualCostEvidencePackages').createIndex({ sourceFifoDatasetId:1, status:1, projectedCoverageImprovement:-1 });
  await database.collection('accountingReviewBatches').createIndex({ batchId:1 }, { unique:true });
  await database.collection('accountingReviewBatches').createIndex({ sourceFifoDatasetId:1, batchKey:1 }, { unique:true });
  await database.collection('accountingReviewSessions').createIndex({ sessionId:1 }, { unique:true });
  const accountingSessionIndexes=await database.collection('accountingReviewSessions').indexes();
  const legacyAccountingSessionIndex=accountingSessionIndexes.find(index=>index.name==='reviewBatchId_1_frozen.fifoDatasetId_1');
  if(legacyAccountingSessionIndex?.unique)await database.collection('accountingReviewSessions').dropIndex(legacyAccountingSessionIndex.name);
  await database.collection('accountingReviewSessions').createIndex(
    { reviewBatchId:1, 'frozen.fifoDatasetId':1, 'frozen.gitSha':1 },
    { unique:true,name:'review_batch_fifo_git_unique_v2' }
  );
  await database.collection('accountingReviewSessions').createIndex({ status:1, updatedAt:-1 });
  await database.collection('accountingComparisonImports').createIndex({ importId:1 }, { unique:true });
  await database.collection('accountingComparisonImports').createIndex({ sourceFileHash:1, frozenSessionId:1 }, { unique:true });
  await database.collection('accountingComparisonImports').createIndex({ status:1, updatedAt:-1 });
  await database.collection('accountingComparisonRows').createIndex({ importId:1, sourceRowNumber:1 }, { unique:true });
  await database.collection('accountingComparisonRows').createIndex({ importId:1, identityHash:1 });
  await database.collection('accountingComparisonRows').createIndex({ importId:1, duplicateReferenceRow:1 });
  await database.collection('accountingComparisonRuns').createIndex({ comparisonRunId:1 }, { unique:true });
  await database.collection('accountingComparisonRuns').createIndex({ sessionId:1, importId:1, comparisonVersion:1 }, { unique:true });
  await database.collection('accountingComparisonDifferences').createIndex({ differenceId:1 }, { unique:true });
  await database.collection('accountingComparisonDifferences').createIndex({ comparisonRunId:1, classification:1, sourceRowNumber:1 });
  await database.collection('fatDefinitions').createIndex({ definitionId:1 }, { unique:true });
  await database.collection('fatDefinitions').createIndex({ fatVersion:1, scenarioCode:1 }, { unique:true });
  await database.collection('fatRuns').createIndex({ fatRunId:1 }, { unique:true });
  await database.collection('fatRuns').createIndex({ sessionId:1, fatVersion:1 }, { unique:true });
  await database.collection('fatEvidence').createIndex({ evidenceId:1 }, { unique:true });
  await database.collection('fatEvidence').createIndex({ fatRunId:1, scenarioCode:1, createdAt:1 });
  await database.collection('fatDifferences').createIndex({ differenceId:1 }, { unique:true });
  await database.collection('fatDifferences').createIndex({ fatRunId:1, scenarioCode:1, classification:1 });
  await database.collection('fatApprovals').createIndex({ approvalId:1 }, { unique:true });
  await database.collection('fatApprovals').createIndex({ fatRunId:1, scenarioCode:1, role:1, username:1 }, { unique:true });
  await database.collection('fifoDatasets').createIndex({ datasetId: 1 }, { unique: true });
  await database.collection('fifoDatasets').createIndex({ status: 1, completedAt: -1 });
  await database.collection('fifoDatasets').createIndex({ sourceSaleSnapshotId: 1, sourcePurchaseDatasetId: 1, algorithmVersion: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, allocationId: 1 }, { unique: true });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, saleLineId: 1, allocationSequence: 1 }, { unique: true });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, itemCode: 1, saleDate: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, itemGuid: 1, saleDate: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, sellerAccountNumber: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, sellerIdentity: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, officialProductCategoryGuid: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, productCategoryGuid: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, officialProductCategoryName: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, productCategory: 1, saleLineId: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, purchaseLineIdentity: 1 });
  await database.collection('fifoAllocations').createIndex({ datasetId: 1, manualResolutionId: 1 });
  await database.collection('fifoDiagnostics').createIndex({ datasetId: 1, at: 1 });
  await database.collection('fifoExceptions').createIndex({ datasetId: 1, exceptionKey: 1 }, { unique: true });
  await database.collection('fifoExceptions').createIndex({ datasetId: 1, status: 1, code: 1, itemCode: 1 });
  await database.collection('fifoDatasetState').createIndex({ scopeKey: 1 }, { unique: true });


  await database.collection('purchaseDrafts').createIndex({ purchaseDraftNo: 1 }, { unique: true });
  await database.collection('purchaseDrafts').createIndex({ createdBy: 1, createdAt: -1 });
  await database.collection('purchaseDrafts').createIndex({ createdBy: 1, status: 1, createdAt: -1 });
  await database.collection('purchaseDrafts').createIndex({ status: 1, updatedAt: -1 });
  await database.collection('invoiceReservations').createIndex({ invType: 1, status: 1, expiresAt: 1, invoiceNumber: -1 });
  await database.collection('invoiceReservations').createIndex({ draftId: 1, invType: 1 });
  await database.collection('appLogs').createIndex({ at: -1 });
  await database.collection('invoiceAuditLogs').createIndex({ purchaseDraftNo: 1, at: -1 });
  await database.collection('invoiceAuditLogs').createIndex({ issuanceAttemptId: 1, at: -1 });
  await database.collection('saleIssueLocks').createIndex({ status: 1, updatedAt: -1 });
  await database.collection('saleIssueLocks').createIndex({ invoiceNumber: 1, mappingUsername: 1 });
  await database.collection('saleIssueLocks').createIndex({ issuanceAttemptId: 1 }, { unique:true, sparse:true });
  await database.collection('saleIssueLocks').createIndex({ requestFingerprint:1, issuanceState:1, updatedAt:-1 });
  await database.collection('saleIssuanceFingerprintLocks').createIndex({ attemptId:1, updatedAt:-1 });

  const defaults = {
    'customer.requireNationalCode': false,
    'customer.requireMobile': true,
    'lead.enableLeadModule': true,
    'lead.requireLeadIdForSaleInvoice': false,
    'lead.writeLeadIdToShayganDescription': true,
    'invoice.warnBelowCostSale': true,
    'invoice.allowBelowCostSale': true,
    'invoice.reservationMinutes': 15,
    'invoice.reuseExpiredNumbers': false,
    'shaygan.connectionName': 'SampleConnection',
    'shaygan.activeFiscalYear': '1404'
  };
  const roles = [{code:'admin',title:'مدیر سیستم'},{code:'manager',title:'مدیر'},{code:'seller',title:'فروشنده'},{code:'accounting',title:'حسابداری'},{code:'warehouse',title:'انبار'},{code:'purchase',title:'بازرگانی'},{code:'seller_buyer',title:'فروشنده-خریدار'}];
  for (const r of roles) await database.collection('roles').updateOne({code:r.code}, {$setOnInsert:{...r, createdAt:new Date()}}, {upsert:true});
  await database.collection('users').updateOne({ username:'admin' }, { $setOnInsert: { username:'admin', password:'admin', fullName:'مدیر سیستم', role:'admin', isActive:true, createdAt:new Date() } }, { upsert:true });
  const sellerSeeds = [
    { username:'seller01', fullName:'دهنوی', cashboxAccountNumber:'11001001', employeeAccountNumber:'11701006', storeName:'دهنوی' },
    { username:'seller02', fullName:'امیر ممیزی', cashboxAccountNumber:'11001041', employeeAccountNumber:'11701030', storeName:'پالادیوم' },
    { username:'seller03', fullName:'کنسول', cashboxAccountNumber:'11001044', employeeAccountNumber:'11701037', storeName:'کنسول' },
    { username:'seller04', fullName:'مسعود ثانی', cashboxAccountNumber:'11001071', employeeAccountNumber:'11701060', storeName:'جانبی' },
    { username:'seller05', fullName:'محتشمی', cashboxAccountNumber:'11001015', employeeAccountNumber:'', storeName:'مشهد کالا' },
    { username:'seller06', fullName:'حسام کرامتی', cashboxAccountNumber:'11001072', employeeAccountNumber:'', storeName:'مشهد کالا' },
    { username:'seller07', fullName:'پالادیوم', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'پالادیوم' },
    { username:'seller08', fullName:'نوتبوک سنتر', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'نوتبوک سنتر' },
    { username:'seller09', fullName:'ایران کاوش', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'ایران کاوش' },
    { username:'seller10', fullName:'حقیر', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'حقیر' },
    { username:'seller11', fullName:'عادل مقدم', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'بازرگانی' },
    { username:'seller12', fullName:'پوستچی', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'بازرگانی' },
    { username:'seller13', fullName:'محسن خدمتی', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'حسابداری' },
    { username:'seller14', fullName:'جواد زیدی', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'حسابداری' },
    { username:'seller15', fullName:'شهمیری', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'حسابداری' },
    { username:'seller16', fullName:'پناهی', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'حسابداری' },
    { username:'seller17', fullName:'فروشنده 17', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'' },
    { username:'seller18', fullName:'فروشنده 18', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'' },
    { username:'seller19', fullName:'فروشنده 19', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'' },
    { username:'seller20', fullName:'فروشنده 20', cashboxAccountNumber:'', employeeAccountNumber:'', storeName:'' }
  ];
  for (const seed of sellerSeeds) {
    await database.collection('users').updateOne({ username:seed.username }, { $setOnInsert: { username:seed.username, password:'1234', fullName:seed.fullName, role:'seller', isActive:true, createdAt:new Date() } }, { upsert:true });
    await database.collection('userShayganMappings').updateOne({ username:seed.username }, { $setOnInsert: { username:seed.username, fullName:seed.fullName, role:'seller', storeName:seed.storeName || '', cashboxAccountNumber:seed.cashboxAccountNumber || '', employeeAccountNumber:seed.employeeAccountNumber || '', canCreateSaleInvoice:true, canViewInventory:true, canViewKardex:true, isActive:true, createdAt:new Date() } }, { upsert:true });
  }
  await database.collection('userShayganMappings').updateOne({ username:'admin' }, { $setOnInsert: { username:'admin', fullName:'مدیر سیستم', role:'admin', storeName:'مدیریت', cashboxAccountNumber:'11001001', employeeAccountNumber:'11701006', canCreateSaleInvoice:true, canViewInventory:true, canViewKardex:true, isActive:true, createdAt:new Date() } }, { upsert:true });

  for (const [key, value] of Object.entries(defaults)) {
    await database.collection('settings').updateOne({ key }, { $setOnInsert: { key, value, updatedAt: new Date(), updatedBy: 'system' } }, { upsert: true });
  }
  return { ok: true, collections: needed };
}

module.exports = { connectMongo, closeMongo, initMongo };
