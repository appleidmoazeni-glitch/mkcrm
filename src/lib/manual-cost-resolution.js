'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const saleSnapshot = require('./sale-snapshot');
const { APP_VERSION } = require('./app-version');
const { canonicalSaleDate, normalizeJalaliRange } = require('./jalali-date');
const accountingDecimal = require('./accounting-decimal');
const openingCostBasis = require('./opening-accounting-cost-basis');
const canonicalItemCatalog = require('./canonical-item-catalog');
const canonicalLayerContract = require('./canonical-purchase-layer-contract');

const COLLECTION = 'manualCostResolutions';
const SCHEMA_VERSION = 4;
const SOURCE_TYPES = Object.freeze([
  'manual',
  'opening_inventory',
  'historical_purchase',
  'opening_accounting_cost',
  'accounting_adjustment',
  'commercial_announced_cost',
  'legacy_cost'
]);
const STATUSES = Object.freeze(['draft', 'pending', 'approved', 'rejected', 'expired']);
const RESOLUTION_SCOPES = Object.freeze(['item', 'purchase_layer', 'opening_quantity', 'evidence_quantity', 'commercial_announced_quantity']);
const COMMERCIAL_SOURCE = 'commercial_announced_cost';
const COMMERCIAL_SCOPE = 'commercial_announced_quantity';
const LEGACY_UNBOUNDED_CLASS = 'LEGACY_UNBOUNDED_MANUAL_COST';
const ASSISTED_WORKFLOW = 'accounting-assisted-v1';
const ASSISTED_STATES = Object.freeze(['NEEDS_REVIEW','ACCOUNTING_REVIEW','APPROVED','DEFERRED','REJECTED']);
const MANAGEMENT_ROLES = Object.freeze(['admin','accounting','purchase']);
const EDIT_ROLES = MANAGEMENT_ROLES;
const APPROVE_ROLES = MANAGEMENT_ROLES;
const ASSISTED_FINALIZE_ROLES = MANAGEMENT_ROLES;
const SOURCE_CLASSES = Object.freeze(['EXACT_OFFICIAL_PURCHASE_LAYER','OPENING_ACCOUNTING_COST','HISTORICAL_PURCHASE_AVERAGE','SOURCE_HISTORY_INCOMPLETE','NO_VALID_COST_BASIS','CONFLICT_REQUIRES_REVIEW']);
let cachedGitMetadata;
const readinessCache = new WeakMap();
const READINESS_CACHE_TTL_MS = 30000;
function invalidateReadinessCache(db){readinessCache.delete(db);}

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function key(value) { return clean(value, 250).toLocaleLowerCase('en-US'); }
function finite(value) {
  if (value == null || clean(value) === '') return null;
  const number = Number(String(value).replace(/[,،\s]/g, ''));
  return Number.isFinite(number) && Number.isSafeInteger(Math.trunc(number)) ? number : null;
}
function exactUnitCost(value) {
  try {
    const parsed = accountingDecimal.parse(value, accountingDecimal.UNIT_COST_SCALE);
    if (parsed <= 0n) return null;
    return accountingDecimal.format(parsed, accountingDecimal.UNIT_COST_SCALE);
  } catch (_) {
    return null;
  }
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(field => `${JSON.stringify(field)}:${stable(value[field])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sanitizeAffectedSaleLinePopulation(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5000).map(row => ({
    saleLineId:clean(row?.saleLineId || row?.saleLineIdentity, 500),
    saleInvoiceNo:Number(row?.saleInvoiceNo || 0),
    saleRow:Number(row?.saleRow || 0),
    saleDate:clean(row?.saleDate, 8),
    quantityExact:clean(row?.quantityExact || row?.unresolvedQuantityExact, 100)
  })).filter(row => row.saleLineId && positiveQuantity(row.quantityExact));
}
function affectedPopulationFingerprint(value = []) {
  const rows=sanitizeAffectedSaleLinePopulation(value).map(row=>[
    row.saleLineId,row.saleInvoiceNo,row.saleRow,row.saleDate,row.quantityExact
  ]).sort((a,b)=>a[0].localeCompare(b[0],'en'));
  return crypto.createHash('sha256').update(stable(rows)).digest('hex');
}
function contentProjection(value = {}) {
  return {
    itemGuid:clean(value.itemGuid, 100), itemCode:clean(value.itemCode, 100),
    manualCostExact:clean(value.manualCostExact, 100), effectiveFrom:clean(value.effectiveFrom, 8),
    effectiveTo:clean(value.effectiveTo, 8), currency:clean(value.currency, 12),
    reason:clean(value.reason, 1000), sourceType:clean(value.sourceType, 100),
    resolutionScope:clean(value.resolutionScope||'item',50), purchaseDatasetId:clean(value.purchaseDatasetId,100),
    purchaseLineIdentity:clean(value.purchaseLineIdentity,500), targetQuantityExact:clean(value.targetQuantityExact,100),
    attachment:sanitizeAttachment(value.attachment), notes:clean(value.notes, 2000),
    supersedesResolutionId:clean(value.supersedesResolutionId,100),
    sourceClass:clean(value.sourceClass,100),evidenceClass:clean(value.evidenceClass,100),commercialReference:clean(value.commercialReference,500),saleValueExposure:Number(value.saleValueExposure||0),affectedLineCount:Number(value.affectedLineCount||0),affectedQuantityExact:clean(value.affectedQuantityExact,100),
    scopeDerivationFingerprint:clean(value.scopeDerivationFingerprint,64),openingDatasetId:clean(value.openingDatasetId,100),openingEvidenceId:clean(value.openingEvidenceId,100),openingCoveredQuantityExact:clean(value.openingCoveredQuantityExact,100),managementDecisionClass:clean(value.managementDecisionClass,100),
    affectedSaleLinePopulation:sanitizeAffectedSaleLinePopulation(value.affectedSaleLinePopulation),affectedSaleLinePopulationFingerprint:clean(value.affectedSaleLinePopulationFingerprint,64),activeFifoDatasetId:clean(value.activeFifoDatasetId,100)
  };
}
function contentHash(value) { return crypto.createHash('sha256').update(stable(contentProjection(value))).digest('hex'); }
function date8(value, field, optional = false) {
  if (optional && !clean(value)) return '';
  return canonicalSaleDate(value, { field });
}
function actor(input = {}) {
  return {
    username:clean(input.username || input.user || 'system', 100),
    role:clean(input.role || 'system', 50)
  };
}
function assertRole(value, allowed, code = 'MANUAL_COST_FORBIDDEN') {
  const role = clean(value);
  if (!allowed.includes(role)) {
    const error = new Error('دسترسی این نقش برای عملیات هزینه دستی مجاز نیست.');
    error.code = code;
    error.statusCode = 403;
    throw error;
  }
}
function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function newResolutionId() {
  return `MCOST-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
function localGitMetadata() {
  if (cachedGitMetadata) return cachedGitMetadata;
  function read(args) {
    try {
      return clean(execFileSync('git', args, {
        cwd:process.cwd(),
        encoding:'utf8',
        timeout:1000,
        windowsHide:true,
        stdio:['ignore','pipe','ignore']
      }), 128);
    } catch (_) {
      return '';
    }
  }
  cachedGitMetadata = {
    gitSha:read(['rev-parse','HEAD']),
    buildTime:read(['show','-s','--format=%cI','HEAD'])
  };
  return cachedGitMetadata;
}
function sanitizeAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attachment = {
    name:clean(value.name, 160),
    reference:clean(value.reference || value.url, 500),
    sha256:clean(value.sha256, 64),
    contentType:clean(value.contentType, 100)
  };
  return Object.values(attachment).some(Boolean) ? attachment : null;
}
function boundedAuditDetails(value = {}) {
  const allowed = ['fields', 'reason', 'fromStatus', 'toStatus', 'oldValue', 'newValue'];
  const output = {};
  for (const field of allowed) {
    if (value[field] == null) {
      if ((field === 'oldValue' || field === 'newValue') && Object.prototype.hasOwnProperty.call(value, field)) output[field] = null;
      continue;
    }
    if (field === 'oldValue' || field === 'newValue') {
      output[field] = auditValueSnapshot(value[field]);
      continue;
    }
    output[field] = Array.isArray(value[field])
      ? value[field].slice(0, 30).map(item => clean(item, 100))
      : clean(value[field], 500);
  }
  return output;
}
function auditValueSnapshot(value) {
  if (value == null) return null;
  const fields = ['itemGuid','itemCode','manualCost','manualCostExact','suggestedCostExact','finalCostExact','contentHash','resolutionScope','purchaseDatasetId','purchaseLineIdentity','targetQuantityExact','effectiveFrom','effectiveTo','currency','reason','sourceType','sourceClass','evidenceClass','commercialReference','attachment','notes','supersedesResolutionId','status','assistedStatus','workflowType','decisionType','saleValueExposure','affectedLineCount','affectedQuantityExact','scopeDerivationFingerprint','openingDatasetId','openingEvidenceId','openingCoveredQuantityExact','managementDecisionClass','affectedSaleLinePopulation','affectedSaleLinePopulationFingerprint','activeFifoDatasetId'];
  const output = {};
  for (const field of fields) {
    if (value[field] === undefined) continue;
    if (field === 'attachment') output[field] = sanitizeAttachment(value[field]);
    else if(field==='affectedSaleLinePopulation')output[field]=sanitizeAffectedSaleLinePopulation(value[field]);
    else if (typeof value[field] === 'number') output[field] = Number(value[field]);
    else output[field] = clean(value[field], field === 'notes' ? 2000 : 1000);
  }
  return output;
}
function auditEntry(action, by, details = {}) {
  return {
    action:clean(action, 80),
    by:actor(by),
    at:new Date(),
    details:boundedAuditDetails(details)
  };
}
function validateDraft(input = {}, options = {}) {
  const allowLegacy=options.allowLegacy===true;
  const itemGuid = clean(input.itemGuid, 100);
  const itemCode = clean(input.itemCode, 100);
  if ((!itemGuid || !itemCode)&&!allowLegacy) fail('MANUAL_COST_STABLE_IDENTITY_REQUIRED', 'ItemGuid و ItemCode هر دو برای شواهد هزینه جدید الزامی هستند.');
  if(!itemGuid&&!itemCode)fail('MANUAL_COST_ITEM_REQUIRED','حداقل یک هویت کالا برای رکورد Legacy الزامی است.');
  const manualCostInput = Object.prototype.hasOwnProperty.call(input, 'manualCost')
    ? input.manualCost
    : input.manualCostExact;
  const manualCost = finite(manualCostInput);
  const manualCostExact = exactUnitCost(manualCostInput);
  if (manualCost == null || manualCost <= 0 || !manualCostExact) fail('MANUAL_COST_INVALID_AMOUNT', 'هزینه دستی باید عدد محدود، امن و بزرگ‌تر از صفر باشد.');
  const sourceType = clean(input.sourceType || 'manual');
  if (!SOURCE_TYPES.includes(sourceType)) fail('MANUAL_COST_INVALID_SOURCE', 'نوع منبع هزینه دستی معتبر نیست.');
  const effectiveFrom = date8(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = date8(input.effectiveTo, 'effectiveTo', true);
  if (effectiveTo && effectiveTo < effectiveFrom) fail('MANUAL_COST_INVALID_RANGE', 'effectiveTo نمی‌تواند قبل از effectiveFrom باشد.');
  const currency = clean(input.currency || 'IRR', 12).toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) fail('MANUAL_COST_INVALID_CURRENCY', 'واحد پول معتبر نیست.');
  const resolutionScope=clean(input.resolutionScope||'item',50);
  if(!RESOLUTION_SCOPES.includes(resolutionScope))fail('MANUAL_COST_SCOPE_INVALID','Scope هزینه دستی معتبر نیست.');
  if(resolutionScope==='item'&&!allowLegacy)fail('MANUAL_COST_UNBOUNDED_SCOPE_FORBIDDEN','ایجاد Manual Cost با دامنه نامحدود Item مجاز نیست.',409);
  if(!allowLegacy&&(sourceType!==COMMERCIAL_SOURCE||resolutionScope!==COMMERCIAL_SCOPE))fail('MANUAL_COST_EVIDENCE_CLASS_REQUIRED','شواهد جدید هزینه باید از نوع قیمت اعلام بازرگانی و با ظرفیت محدود باشد.',409);
  const purchaseDatasetId=resolutionScope==='purchase_layer'?clean(input.purchaseDatasetId,100):'',purchaseLineIdentity=resolutionScope==='purchase_layer'?clean(input.purchaseLineIdentity,500):'';
  let targetQuantityExact='';
  if(['purchase_layer','opening_quantity','evidence_quantity',COMMERCIAL_SCOPE].includes(resolutionScope)){
    if(resolutionScope==='purchase_layer'&&(!purchaseDatasetId||!purchaseLineIdentity))fail('MANUAL_COST_PURCHASE_LAYER_REQUIRED','Dataset و Purchase Line برای Scope لایه خرید الزامی است.');
    try{const qty=accountingDecimal.parse(input.targetQuantityExact??input.targetQuantity,accountingDecimal.QUANTITY_SCALE);if(qty<=0n)throw new Error();targetQuantityExact=accountingDecimal.format(qty,accountingDecimal.QUANTITY_SCALE);}catch(_){fail('MANUAL_COST_TARGET_QUANTITY_INVALID','Quantity هدف باید دقیق و بزرگ‌تر از صفر باشد.');}
  }
  if(!allowLegacy&&!effectiveTo)fail('MANUAL_COST_EFFECTIVE_TO_REQUIRED','تاریخ پایان اثر برای هزینه جدید الزامی است.');
  const supersedesResolutionId=clean(input.supersedesResolutionId,100);
  const reason=clean(input.reason,1000);
  const commercialReference=clean(input.commercialReference||input.sourceReference,500);
  if(!allowLegacy&&!reason)fail('MANUAL_COST_REASON_REQUIRED','دلیل قیمت اعلام بازرگانی الزامی است.');
  if(!allowLegacy&&!commercialReference)fail('MANUAL_COST_COMMERCIAL_REFERENCE_REQUIRED','مرجع یا توضیح اعلام بازرگانی الزامی است.');
  if(supersedesResolutionId&&!reason)fail('MANUAL_COST_SUPERSESSION_REASON_REQUIRED','دلیل اصلاح Resolution قدیمی برای supersession الزامی است.');
  if(supersedesResolutionId&&!effectiveTo)fail('MANUAL_COST_SUPERSESSION_EFFECTIVE_TO_REQUIRED','تاریخ پایان صریح برای supersession هزینه دستی الزامی است.');
  const normalized = {
    itemGuid,
    itemCode,
    manualCost,
    manualCostExact,
    effectiveFrom,
    effectiveTo,
    currency,
    reason,
    sourceType,
    attachment:sanitizeAttachment(input.attachment),
    notes:clean(input.notes, 2000),resolutionScope,purchaseDatasetId,purchaseLineIdentity,targetQuantityExact,
    supersedesResolutionId,
    commercialReference,
    evidenceClass:sourceType===COMMERCIAL_SOURCE?'COMMERCIAL_ANNOUNCED_COST':'',
    scopeDerivationFingerprint:clean(input.scopeDerivationFingerprint,64),
    openingDatasetId:clean(input.openingDatasetId,100),
    openingEvidenceId:clean(input.openingEvidenceId,100),
    openingCoveredQuantityExact:clean(input.openingCoveredQuantityExact,100),
    managementDecisionClass:clean(input.managementDecisionClass,100),
    affectedSaleLinePopulation:sanitizeAffectedSaleLinePopulation(input.affectedSaleLinePopulation),
    affectedSaleLinePopulationFingerprint:clean(input.affectedSaleLinePopulationFingerprint,64),
    activeFifoDatasetId:clean(input.activeFifoDatasetId,100)
  };
  if(normalized.affectedSaleLinePopulation.length){
    const fingerprint=affectedPopulationFingerprint(normalized.affectedSaleLinePopulation);
    if(normalized.affectedSaleLinePopulationFingerprint&&normalized.affectedSaleLinePopulationFingerprint!==fingerprint)fail('MANUAL_COST_AFFECTED_POPULATION_FINGERPRINT_MISMATCH','Fingerprint جمعیت Sale Line با Scope ارسالی تطابق ندارد.',409);
    normalized.affectedSaleLinePopulationFingerprint=fingerprint;
  }
  return { ...normalized, contentHash:contentHash(normalized) };
}
function overlaps(aFrom, aTo, bFrom, bTo) {
  const startA = aFrom || '00000000';
  const startB = bFrom || '00000000';
  const endA = aTo || '99999999';
  const endB = bTo || '99999999';
  return startA <= endB && startB <= endA;
}
function sameIdentity(a, b) {
  const ag = key(a.itemGuid), bg = key(b.itemGuid);
  if (ag && bg) return ag === bg;
  return Boolean(key(a.itemCode)) && key(a.itemCode) === key(b.itemCode);
}
function sameResolutionTarget(a,b){
  const scopeA=clean(a.resolutionScope||'item',50),scopeB=clean(b.resolutionScope||'item',50);
  if(scopeA==='purchase_layer'&&scopeB==='purchase_layer')return clean(a.purchaseDatasetId,100)===clean(b.purchaseDatasetId,100)&&clean(a.purchaseLineIdentity,500)===clean(b.purchaseLineIdentity,500);
  if(scopeA!==scopeB)return sameIdentity(a,b);
  return sameIdentity(a,b);
}
async function allRows(collection, query = {}) {
  return collection.find(query).toArray();
}
async function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await allRows(collection, query)).length;
}
async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  if (!existing.has(COLLECTION)) await db.createCollection(COLLECTION).catch(() => {});
  if (!existing.has('fifoSourceInvalidations')) await db.createCollection('fifoSourceInvalidations').catch(() => {});
  const collection = db.collection(COLLECTION);
  await collection.createIndex({ resolutionId:1 }, { unique:true });
  await collection.createIndex({ itemGuid:1, status:1, effectiveFrom:1, effectiveTo:1 });
  await collection.createIndex({ itemCode:1, status:1, effectiveFrom:1, effectiveTo:1 });
  await collection.createIndex({ status:1, updatedAt:-1 });
  await collection.createIndex({ status:1, contentHash:1 });
  await collection.createIndex({ purchaseDatasetId:1, purchaseLineIdentity:1, status:1 });
  await collection.createIndex({ workflowType:1, assistedStatus:1, approvedAt:-1 });
  await db.collection('fifoSourceInvalidations').createIndex({ invalidationId:1 }, { unique:true });
  await db.collection('fifoSourceInvalidations').createIndex({ reason:1, createdAt:-1 });
  return { ok:true, collection:COLLECTION, schemaVersion:SCHEMA_VERSION };
}
async function validatePurchaseLayerScope(db, normalized) {
  if(normalized.resolutionScope!=='purchase_layer')return;
  const layer=await db.collection(purchaseLayerDataset.LAYERS).findOne(canonicalLayerContract.canonicalPurchaseQuery({datasetId:normalized.purchaseDatasetId,purchaseLineIdentity:normalized.purchaseLineIdentity}));
  if(!layer)fail('MANUAL_COST_PURCHASE_LAYER_NOT_FOUND','Purchase Layer هدف در Dataset تعیین‌شده پیدا نشد.',409);
  if(normalized.itemGuid&&layer.itemGuid&&key(normalized.itemGuid)!==key(layer.itemGuid))fail('MANUAL_COST_PURCHASE_LAYER_IDENTITY_MISMATCH','ItemGuid با Purchase Layer هدف تطابق ندارد.',409);
  if(normalized.itemCode&&layer.itemCode&&key(normalized.itemCode)!==key(layer.itemCode))fail('MANUAL_COST_PURCHASE_LAYER_IDENTITY_MISMATCH','ItemCode با Purchase Layer هدف تطابق ندارد.',409);
  const available=accountingDecimal.parse(layer.netPurchasedQuantity??layer.remainingQuantity??layer.originalQuantity??0,accountingDecimal.QUANTITY_SCALE);
  if(accountingDecimal.parse(normalized.targetQuantityExact,accountingDecimal.QUANTITY_SCALE)>available)fail('MANUAL_COST_TARGET_QUANTITY_EXCEEDS_LAYER','Quantity هزینه دستی از Quantity لایه خرید بیشتر است.',409);
}
async function validateSupersession(db, candidate, excludedResolutionId = '') {
  const supersedesResolutionId=clean(candidate.supersedesResolutionId,100);
  if(!supersedesResolutionId)return null;
  if(supersedesResolutionId===clean(excludedResolutionId,100))fail('MANUAL_COST_SUPERSESSION_SELF_REFERENCE','Resolution نمی‌تواند خودش را supersede کند.',409);
  const previous=await db.collection(COLLECTION).findOne({resolutionId:supersedesResolutionId});
  if(!previous)fail('MANUAL_COST_SUPERSEDED_NOT_FOUND','Resolution قبلی برای supersession پیدا نشد.',404);
  if(previous.status!=='approved'||previous.deleted===true)fail('MANUAL_COST_SUPERSEDED_NOT_APPROVED','فقط Resolution تأییدشده و حذف‌نشده قابل supersession است.',409);
  if(!sameResolutionTarget(previous,candidate))fail('MANUAL_COST_SUPERSESSION_TARGET_MISMATCH','Resolution جدید و قبلی باید Target حسابداری یکسان داشته باشند.',409);
  return previous;
}
async function assertStableItemIdentity(db,candidate){
  if(Number(candidate.schemaVersion||SCHEMA_VERSION)<SCHEMA_VERSION&&candidate.evidenceClass!=='COMMERCIAL_ANNOUNCED_COST')return;
  const item=canonicalItemCatalog._sourceItem(candidate);
  const guid=canonicalItemCatalog.canonicalItemGuid(item.itemGuid),code=canonicalItemCatalog.normalizedItemCode(item.itemCode);
  const rows=await db.collection(canonicalItemCatalog.CATALOG).find({$or:[{canonicalItemGuid:guid},{itemGuid:item.itemGuid},{normalizedItemCode:code},{itemCode:item.itemCode}]}).toArray();
  const guidRows=rows.filter(row=>canonicalItemCatalog.canonicalItemGuid(row.canonicalItemGuid||row.itemGuid)===guid);
  const codeRows=rows.filter(row=>canonicalItemCatalog.normalizedItemCode(row.normalizedItemCode||row.itemCode)===code);
  const resolved=canonicalItemCatalog._resolveExisting(item,guidRows,codeRows);
  if(resolved.conflict)fail('MANUAL_COST_ITEM_IDENTITY_CONFLICT','ItemGuid و ItemCode با هویت canonical کالا تطابق ندارند.',409);
}
async function approvedOpeningCollision(db,candidate){
  let authority;
  try{authority=await openingCostBasis.resolveOpeningAuthority(db,{});}catch(error){
    if(clean(error.code,100)==='OPENING_AUTHORITY_NOT_FOUND')return null;
    throw error;
  }
  const rows=await db.collection(openingCostBasis.COLLECTION).find({
    datasetId:authority.datasetId,status:{$in:['available','VALIDATED_CANDIDATE']},extractionComplete:true
  }).toArray();
  const collision=rows.find(row=>{
    if(!key(row.itemGuid)||key(row.itemGuid)!==key(candidate.itemGuid))return false;
    let quantity=0n;
    try{quantity=accountingDecimal.parse(row.openingQuantityExact||0,accountingDecimal.QUANTITY_SCALE);}catch(_){return false;}
    return quantity>0n&&overlaps(candidate.effectiveFrom,candidate.effectiveTo,clean(row.effectiveOpeningDate||row.openingDate,8),'');
  });
  return collision?{datasetId:authority.datasetId,evidenceId:clean(collision.evidenceId,100),itemGuid:clean(collision.itemGuid,100),openingQuantityExact:clean(collision.openingQuantityExact,100),effectiveOpeningDate:clean(collision.effectiveOpeningDate||collision.openingDate,8)}:null;
}
async function assertNoOpeningCollision(db,candidate){
  const collision=await approvedOpeningCollision(db,candidate);
  if(!collision)return;
  const datasetId=clean(candidate.openingDatasetId,100),evidenceId=clean(candidate.openingEvidenceId,100),scopeFingerprint=clean(candidate.scopeDerivationFingerprint,64);
  if(datasetId===collision.datasetId&&evidenceId===collision.evidenceId&&scopeFingerprint){
    await assertCurrentAffectedPopulation(db,candidate);
    return;
  }
  fail('MANUAL_COST_OPENING_CAPACITY_COLLISION','ظرفیت Opening مصوب برای همین ItemGuid وجود دارد و Scope باقی‌مانده قابل اثبات نیست: '+collision.datasetId,409);
}
function approvedRowsFingerprint(rows = []) {
  const identities = rows.map(row => [
    clean(row.resolutionId,100), Number(row.revision||0), clean(row.contentHash,64) || contentHash({
      ...row,
      manualCostExact:row.manualCostExact || exactUnitCost(row.manualCost)
    })
  ]).sort((a,b)=>a[0].localeCompare(b[0],'en'));
  return { count:identities.length, fingerprint:crypto.createHash('sha256').update(stable(identities)).digest('hex') };
}
async function approvedSetFingerprint(db) {
  const rows = await allRows(db.collection(COLLECTION), { status:'approved', deleted:{ $ne:true } });
  return approvedRowsFingerprint(rows);
}
function allocationIdentityMatches(row,target){
  const targetGuid=key(target.itemGuid),rowGuid=key(row.itemGuid),targetCode=key(target.itemCode),rowCode=key(row.itemCode);
  if(targetGuid&&rowGuid)return targetGuid===rowGuid;
  return Boolean(targetCode&&rowCode===targetCode&&!rowGuid);
}
async function activeFifoEconomicExposure(db,target={}){
  const state=await db.collection('fifoDatasetState').findOne({scopeKey:'fifo-shadow-v2-precision-evidence'}),datasetId=clean(state?.activeDatasetId,100);
  if(!datasetId)fail('MANUAL_COST_ACTIVE_FIFO_REQUIRED','برای محاسبه Scope اقتصادی، FIFO فعال الزامی است.',409);
  const queryParts=[];
  if(clean(target.itemGuid,100))queryParts.push({itemGuid:clean(target.itemGuid,100)});
  if(clean(target.itemCode,100))queryParts.push({itemCode:clean(target.itemCode,100)});
  const candidates=queryParts.length?await db.collection('fifoAllocations').find({datasetId,$or:queryParts}).toArray():[];
  const rows=candidates.filter(row=>Number(row.saleInvoiceType||0)===2&&allocationIdentityMatches(row,target));
  const byLine=new Map();
  for(const row of rows){
    const saleLineId=clean(row.saleLineId,500);if(!saleLineId)continue;
    const group=byLine.get(saleLineId)||{saleLineId,saleInvoiceNo:Number(row.saleInvoiceNo||0),saleRow:Number(row.saleRow||0),saleDate:clean(row.saleDate,8),itemGuid:clean(row.itemGuid||target.itemGuid,100),itemCode:clean(row.itemCode||target.itemCode,100),sellerAccountNumber:clean(row.sellerAccountNumber,100),sellerName:clean(row.sellerName,200),storeName:clean(row.storeName,200),itemDescription:clean(row.itemDescription,500),unknownQuantity:0n,coveredQuantity:0n,openingQuantity:0n,purchaseQuantity:0n,saleValue:0n,sources:new Set()};
    const quantity=accountingDecimal.parse(row.quantityExact??row.unknownQty??row.allocatedQty??0,accountingDecimal.QUANTITY_SCALE);
    const value=accountingDecimal.parse(row.allocatedSaleValueExact??row.allocatedSaleValue??0,accountingDecimal.MONEY_SCALE);
    const unknown=row.sourceType==='unknown_cost'||row.allocatedCostAmountExact==null;
    if(unknown)group.unknownQuantity+=quantity;
    else{
      group.coveredQuantity+=quantity;group.sources.add(clean(row.costSourceType||row.sourceType,100));
      if(clean(row.costSourceType,100)==='APPROVED_OPENING_ACCOUNTING_COST'||clean(row.sourceType,100)==='approved_opening_accounting_cost')group.openingQuantity+=quantity;
      else group.purchaseQuantity+=quantity;
    }
    group.saleValue+=value;byLine.set(saleLineId,group);
  }
  const groups=[...byLine.values()].sort((a,b)=>a.saleDate.localeCompare(b.saleDate,'en')||a.saleInvoiceNo-b.saleInvoiceNo||a.saleRow-b.saleRow||a.saleLineId.localeCompare(b.saleLineId,'en'));
  const population=groups.filter(row=>row.unknownQuantity>0n).map(row=>({saleLineId:row.saleLineId,saleInvoiceNo:row.saleInvoiceNo,saleRow:row.saleRow,saleDate:row.saleDate,quantityExact:accountingDecimal.format(row.unknownQuantity,accountingDecimal.QUANTITY_SCALE)}));
  const total=(field)=>groups.reduce((sum,row)=>sum+row[field],0n);
  return {
    datasetId,
    requiredQuantityExact:accountingDecimal.format(total('unknownQuantity')+total('coveredQuantity'),accountingDecimal.QUANTITY_SCALE),
    unresolvedQuantityExact:accountingDecimal.format(total('unknownQuantity'),accountingDecimal.QUANTITY_SCALE),
    coveredQuantityExact:accountingDecimal.format(total('coveredQuantity'),accountingDecimal.QUANTITY_SCALE),
    openingCoveredQuantityExact:accountingDecimal.format(total('openingQuantity'),accountingDecimal.QUANTITY_SCALE),
    purchaseCoveredQuantityExact:accountingDecimal.format(total('purchaseQuantity'),accountingDecimal.QUANTITY_SCALE),
    saleValueExposureExact:accountingDecimal.format(groups.filter(row=>row.unknownQuantity>0n).reduce((sum,row)=>sum+row.saleValue,0n),accountingDecimal.MONEY_SCALE),
    affectedSaleLinePopulation:population,
    affectedSaleLinePopulationFingerprint:affectedPopulationFingerprint(population),
    coveredLines:groups.filter(row=>row.coveredQuantity>0n).map(row=>({saleLineId:row.saleLineId,saleInvoiceNo:row.saleInvoiceNo,saleRow:row.saleRow,saleDate:row.saleDate,quantityExact:accountingDecimal.format(row.coveredQuantity,accountingDecimal.QUANTITY_SCALE),openingQuantityExact:accountingDecimal.format(row.openingQuantity,accountingDecimal.QUANTITY_SCALE),purchaseQuantityExact:accountingDecimal.format(row.purchaseQuantity,accountingDecimal.QUANTITY_SCALE),sources:[...row.sources].sort()})),
    lineCount:population.length,
    invoiceCount:new Set(population.map(row=>row.saleInvoiceNo)).size,
    itemDescription:groups.find(row=>row.itemDescription)?.itemDescription||''
  };
}
async function assertCurrentAffectedPopulation(db,resolution){
  const expected=sanitizeAffectedSaleLinePopulation(resolution.affectedSaleLinePopulation);
  if(!expected.length)fail('MANUAL_COST_AFFECTED_POPULATION_REQUIRED','Manual Cost جدید باید به جمعیت دقیق Sale Lineهای فاقد هزینه متصل باشد.',409);
  const fingerprint=affectedPopulationFingerprint(expected);
  if(fingerprint!==clean(resolution.affectedSaleLinePopulationFingerprint,64))fail('MANUAL_COST_AFFECTED_POPULATION_FINGERPRINT_MISMATCH','جمعیت Sale Line یا Fingerprint آن تغییر کرده است.',409);
  const current=await activeFifoEconomicExposure(db,resolution);
  const currentByLine=new Map(current.affectedSaleLinePopulation.map(row=>[row.saleLineId,row]));
  for(const row of expected){
    const actual=currentByLine.get(row.saleLineId);
    if(!actual||accountingDecimal.parse(actual.quantityExact,accountingDecimal.QUANTITY_SCALE)<accountingDecimal.parse(row.quantityExact,accountingDecimal.QUANTITY_SCALE))fail('MANUAL_COST_EXPOSURE_ALREADY_COVERED','Opening/Purchase یا lineage فعلی، Exposure انتخاب‌شده را پوشش داده یا Quantity آن را تغییر داده است.',409);
  }
  const expectedQuantity=expected.reduce((sum,row)=>sum+accountingDecimal.parse(row.quantityExact,accountingDecimal.QUANTITY_SCALE),0n);
  if(expectedQuantity!==accountingDecimal.parse(resolution.targetQuantityExact||0,accountingDecimal.QUANTITY_SCALE))fail('MANUAL_COST_SCOPE_POPULATION_MISMATCH','Quantity مصوب با جمعیت frozen Sale Line تطابق ندارد.',409);
  return current;
}
async function impactPreview(db, resolutionId, requestedBy = {}) {
  assertRole(requestedBy?.role, ['admin','accounting','purchase','manager']);
  const resolution = await getById(db, resolutionId);
  const state = await db.collection('fifoDatasetState').findOne({ scopeKey:'fifo-shadow-v2-precision-evidence' });
  const datasetId = clean(state?.activeDatasetId, 100);
  if (!datasetId) return { ok:true, resolutionId:resolution.resolutionId, datasetId:'', affected:{ purchaseLayers:0, allocations:0, saleLines:0, invoices:0, sellers:0, productCategories:0 }, blocker:'FIFO_ACTIVE_DATASET_MISSING', readOnly:true };
  if(clean(resolution.activeFifoDatasetId,100)&&clean(resolution.activeFifoDatasetId,100)!==datasetId)fail('MANUAL_COST_IMPACT_PREVIEW_STALE','FIFO فعال از زمان Review تغییر کرده است؛ Scope باید دوباره محاسبه شود.',409);
  const expectedPopulation=sanitizeAffectedSaleLinePopulation(resolution.affectedSaleLinePopulation);
  if(Number(resolution.schemaVersion||0)>=SCHEMA_VERSION&&resolution.evidenceClass==='COMMERCIAL_ANNOUNCED_COST')await assertCurrentAffectedPopulation(db,resolution);
  const identityParts=[];if(clean(resolution.itemGuid,100))identityParts.push({itemGuid:clean(resolution.itemGuid,100)});if(clean(resolution.itemCode,100))identityParts.push({itemCode:clean(resolution.itemCode,100)});
  const identityQuery=identityParts.length===1?identityParts[0]:{$or:identityParts};
  const dateQuery={};
  if(resolution.effectiveFrom)dateQuery.$gte=resolution.effectiveFrom;
  if(resolution.effectiveTo)dateQuery.$lte=resolution.effectiveTo;
  const query={datasetId,...identityQuery};
  if(Object.keys(dateQuery).length)query.saleDate=dateQuery;
  const candidates = await db.collection('fifoAllocations').find(query).toArray();
  const expectedByLine=new Map(expectedPopulation.map(row=>[row.saleLineId,row]));
  const expectedLineIds=new Set(expectedByLine.keys());
  const rows = candidates.filter(row => {
    if(!allocationIdentityMatches(row,resolution))return false;
    if(expectedLineIds.size&&!expectedLineIds.has(clean(row.saleLineId,500)))return false;
    if (!(expectedLineIds.size?allocationIdentityMatches(row,resolution):matchesManual(resolution, row))) return false;
    if (row.saleDate < resolution.effectiveFrom || (resolution.effectiveTo && row.saleDate > resolution.effectiveTo)) return false;
    if (resolution.status === 'approved' && row.manualResolutionId === resolution.resolutionId) return true;
    return row.sourceType === 'unknown_cost';
  }).map(row=>{
    const expected=expectedByLine.get(clean(row.saleLineId,500));
    if(!expected)return row;
    const sourceQuantity=accountingDecimal.parse(row.quantityExact??row.unknownQty??row.allocatedQty??0,accountingDecimal.QUANTITY_SCALE),boundedQuantity=accountingDecimal.parse(expected.quantityExact,accountingDecimal.QUANTITY_SCALE),sourceSale=accountingDecimal.parse(row.allocatedSaleValueExact??row.allocatedSaleValue??0,accountingDecimal.MONEY_SCALE);
    const boundedSale=sourceQuantity>0n?accountingDecimal.divideRounded(sourceSale*boundedQuantity,sourceQuantity):0n;
    return {...row,quantityExact:expected.quantityExact,allocatedSaleValueExact:accountingDecimal.format(boundedSale,accountingDecimal.MONEY_SCALE)};
  }).sort((a,b)=>clean(a.saleDate,8).localeCompare(clean(b.saleDate,8),'en')||Number(a.saleInvoiceNo||0)-Number(b.saleInvoiceNo||0)||Number(a.saleRow||0)-Number(b.saleRow||0)||clean(a.saleLineId,500).localeCompare(clean(b.saleLineId,500),'en'));
  const manualCostExact = resolution.manualCostExact || exactUnitCost(resolution.manualCost);
  const totalRequiredQuantity=rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.quantityExact??row.unknownQty??row.allocatedQty??0,accountingDecimal.QUANTITY_SCALE),0n);
  const boundedScope=['purchase_layer','opening_quantity','evidence_quantity',COMMERCIAL_SCOPE].includes(clean(resolution.resolutionScope,50));
  const capacity=boundedScope?accountingDecimal.parse(resolution.targetQuantityExact||0,accountingDecimal.QUANTITY_SCALE):totalRequiredQuantity;
  let remainingCapacity=capacity,projectedResolvedCost=0n,coveredQuantity=0n,saleValueExposure=0n;
  const coveredRows=[];
  for (const row of rows) {
    if(remainingCapacity<=0n)break;
    const quantity=accountingDecimal.parse(row.quantityExact??row.unknownQty??row.allocatedQty??0,accountingDecimal.QUANTITY_SCALE);
    const covered=quantity<remainingCapacity?quantity:remainingCapacity;
    if(covered<=0n)continue;
    projectedResolvedCost+=accountingDecimal.allocation(accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),manualCostExact).valueScaled;
    const rowSale=accountingDecimal.parse(row.allocatedSaleValueExact??row.allocatedSaleValue??0,accountingDecimal.MONEY_SCALE);
    saleValueExposure+=quantity>0n?accountingDecimal.divideRounded(rowSale*covered,quantity):0n;
    coveredQuantity+=covered;remainingCapacity-=covered;coveredRows.push({
      row,
      potentiallyCoveredQuantityExact:accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),
      proposedCostExact:accountingDecimal.format(accountingDecimal.allocation(accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),manualCostExact).valueScaled,accountingDecimal.MONEY_SCALE)
    });
  }
  const remainingUnknown=totalRequiredQuantity>coveredQuantity?totalRequiredQuantity-coveredQuantity:0n;
  if(Number(resolution.schemaVersion||0)>=SCHEMA_VERSION&&resolution.evidenceClass==='COMMERCIAL_ANNOUNCED_COST'){
    if(!coveredRows.length||coveredQuantity<=0n)fail('MANUAL_COST_IMPACT_EMPTY','پیش‌نمایش اثر فاقد Sale Line یا Quantity قابل پوشش است.',409);
    if(coveredQuantity!==capacity||totalRequiredQuantity!==capacity||remainingUnknown!==0n)fail('MANUAL_COST_SCOPE_POPULATION_MISMATCH','جمعیت پیش‌نمایش با Scope unresolved مشتق‌شده تطابق ندارد.',409);
  }
  const saleLineIds=[...new Set(coveredRows.map(entry=>entry.row.saleLineId).filter(Boolean))];
  const lineAllocations = saleLineIds.length
    ? await db.collection('fifoAllocations').find({datasetId,saleLineId:{$in:saleLineIds}}).toArray()
    : [];
  const knownCostRows = lineAllocations.filter(row=>row.allocatedCostAmountExact!=null);
  const oldKnownCost = knownCostRows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedCostAmountExact,accountingDecimal.MONEY_SCALE),0n);
  const purchaseLayers = new Set(coveredRows.map(entry => clean(entry.row.purchaseLineIdentity,500)).filter(Boolean));
  const affectedLines=coveredRows.map(({row,potentiallyCoveredQuantityExact,proposedCostExact})=>{
    const siblings=lineAllocations.filter(value=>value.saleLineId===row.saleLineId);
    const currentCost=siblings.reduce((sum,value)=>value.allocatedCostAmountExact==null?sum:sum+accountingDecimal.parse(value.allocatedCostAmountExact,accountingDecimal.MONEY_SCALE),0n);
    const hasKnown=siblings.some(value=>value.allocatedCostAmountExact!=null);
    const hasUnknown=siblings.some(value=>value.sourceType==='unknown_cost'||value.allocatedCostAmountExact==null);
    return {
    saleLineId:clean(row.saleLineId,500),saleInvoiceType:Number(row.saleInvoiceType||0),saleInvoiceNo:Number(row.saleInvoiceNo||0),saleRow:Number(row.saleRow||0),saleDate:clean(row.saleDate,8),
    itemGuid:clean(row.itemGuid,100),itemCode:clean(row.itemCode,100),sellerAccountNumber:clean(row.sellerAccountNumber,100),sellerName:clean(row.sellerName,200),storeName:clean(row.storeName,200),
    currentProvenance:hasKnown&&hasUnknown?'PARTIAL':hasUnknown?'UNKNOWN':'PROVEN',currentFifoCostExact:accountingDecimal.format(currentCost,accountingDecimal.MONEY_SCALE),currentQuantityExact:clean(row.quantityExact??row.unknownQty??row.allocatedQty,100),potentiallyCoveredQuantityExact,proposedCostExact,
    expectedNextFifoProvenance:'COMMERCIAL_ANNOUNCED_COST',activeFifoMutated:false
  };});
  const previewContract={
    resolutionId:resolution.resolutionId,revision:Number(resolution.revision||0),
    resolutionContentHash:resolution.contentHash || contentHash({ ...resolution, manualCostExact }),
    activeFifoDatasetId:datasetId,evidenceClass:clean(resolution.evidenceClass||resolution.sourceClass||resolution.sourceType,100),
    itemGuid:clean(resolution.itemGuid,100),itemCode:clean(resolution.itemCode,100),targetQuantityExact:clean(resolution.targetQuantityExact,100),
    effectiveFrom:clean(resolution.effectiveFrom,8),effectiveTo:clean(resolution.effectiveTo,8),manualCostExact,
    affectedLines:affectedLines.map(row=>[row.saleLineId,row.potentiallyCoveredQuantityExact,row.currentProvenance]),
    affectedSaleLinePopulationFingerprint:clean(resolution.affectedSaleLinePopulationFingerprint,64)
  };
  const previewFingerprint=crypto.createHash('sha256').update(stable(previewContract)).digest('hex');
  return {
    ok:true,
    resolutionId:resolution.resolutionId,
    resolutionContentHash:resolution.contentHash || contentHash({ ...resolution, manualCostExact }),
    status:resolution.status,
    datasetId,
    affected:{
     purchaseLayers:purchaseLayers.size,
     allocations:coveredRows.length,
      saleLines:new Set(coveredRows.map(entry => entry.row.saleLineId)).size,
      invoices:new Set(coveredRows.map(entry => entry.row.saleInvoiceType+':'+entry.row.saleInvoiceNo)).size,
      sellers:new Set(coveredRows.map(entry => clean(entry.row.sellerAccountNumber,100)).filter(Boolean)).size,
      productCategories:new Set(coveredRows.map(entry => clean(entry.row.officialProductCategoryName,300)).filter(Boolean)).size
    },
    quantity:{requiredExact:accountingDecimal.format(totalRequiredQuantity,accountingDecimal.QUANTITY_SCALE),capacityExact:accountingDecimal.format(capacity,accountingDecimal.QUANTITY_SCALE),coveredExact:accountingDecimal.format(coveredQuantity,accountingDecimal.QUANTITY_SCALE),remainingUnknownExact:accountingDecimal.format(remainingUnknown,accountingDecimal.QUANTITY_SCALE)},
    saleValueExposureExact:accountingDecimal.format(saleValueExposure,accountingDecimal.MONEY_SCALE),
    oldKnownCostExact:accountingDecimal.format(oldKnownCost,accountingDecimal.MONEY_SCALE),
    projectedResolvedCostExact:accountingDecimal.format(projectedResolvedCost,accountingDecimal.MONEY_SCALE),
    projectedNewKnownCostExact:accountingDecimal.format(oldKnownCost+projectedResolvedCost,accountingDecimal.MONEY_SCALE),
    fifoProfitDeltaExact:null,
    fifoProfitDeltaReason:'baseline-profit-is-unknown-for-unresolved-quantity',
    evidenceType:resolution.evidenceClass||resolution.sourceType,
    evidence:{
      itemGuid:clean(resolution.itemGuid,100),itemCode:clean(resolution.itemCode,100),
      manualCostExact,targetQuantityExact:clean(resolution.targetQuantityExact,100),
      effectiveFrom:clean(resolution.effectiveFrom,8),effectiveTo:clean(resolution.effectiveTo,8),
      commercialReference:clean(resolution.commercialReference,500),reason:clean(resolution.reason,1000)
    },
    evidenceRevision:Number(resolution.revision||0),
    previewFingerprint,
    affectedLines,
   activationRequired:true,
    historicalDatasetMutated:false,
    readOnly:true
  };
}
async function ensureNoDuplicate(db, candidate, excludedResolutionId = '') {
  const rows = await allRows(db.collection(COLLECTION), { status:{ $in:['draft', 'pending', 'approved'] } });
  const duplicate = rows.find(row =>
    row.resolutionId !== excludedResolutionId &&
    sameResolutionTarget(row, candidate) &&
    overlaps(row.effectiveFrom, row.effectiveTo, candidate.effectiveFrom, candidate.effectiveTo) &&
    row.resolutionId !== clean(candidate.supersedesResolutionId,100)
  );
  if (duplicate) fail(
    'MANUAL_COST_OVERLAP',
    `برای این کالا در بازه مؤثر، Resolution فعال دیگری وجود دارد: ${duplicate.resolutionId}`,
    409
  );
}
async function createDraft(db, input, requestedBy) {
  assertRole(requestedBy?.role, EDIT_ROLES);
  const normalized = validateDraft(input);
  await assertStableItemIdentity(db,normalized);
  await validatePurchaseLayerScope(db,normalized);
  await validateSupersession(db,normalized);
  await ensureNoDuplicate(db, normalized);
  const now = new Date();
  const createdBy = actor(requestedBy);
  const doc = {
    resolutionId:newResolutionId(),
    schemaVersion:SCHEMA_VERSION,
    ...normalized,
    status:'draft',
    revision:1,
    createdBy,
    approvedBy:null,
    approvedAt:null,
    rejectedBy:null,
    rejectedAt:null,
    expiredBy:null,
    expiredAt:null,
    deleted:false,
    auditLog:[auditEntry('created-draft', requestedBy, { fields:Object.keys(normalized), oldValue:null, newValue:{ ...normalized, status:'draft' } })],
    createdAt:now,
    updatedAt:now
  };
  await db.collection(COLLECTION).insertOne(doc);
  invalidateReadinessCache(db);
  return { ok:true, resolution:doc };
}
async function getById(db, resolutionId) {
  const resolution = await db.collection(COLLECTION).findOne({ resolutionId:clean(resolutionId, 100) });
  if (!resolution) fail('MANUAL_COST_NOT_FOUND', 'Resolution هزینه دستی پیدا نشد.', 404);
  return resolution;
}
async function updateDraft(db, resolutionId, input, requestedBy) {
  assertRole(requestedBy?.role, EDIT_ROLES);
  const current = await getById(db, resolutionId);
  if (!['draft', 'rejected'].includes(current.status)) {
    fail('MANUAL_COST_IMMUTABLE', 'فقط Resolution پیش‌نویس یا ردشده قابل ویرایش است.', 409);
  }
  const expectedRevision = Number(input.revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== Number(current.revision || 1)) {
    fail('MANUAL_COST_CONCURRENT_CHANGE', 'نسخه Resolution تغییر کرده است؛ دوباره بارگذاری کنید.', 409);
  }
  const normalized = validateDraft({ ...current, ...input },{allowLegacy:Number(current.schemaVersion||0)<SCHEMA_VERSION});
  await assertStableItemIdentity(db,{...normalized,schemaVersion:Number(current.schemaVersion||0)});
  await validatePurchaseLayerScope(db,normalized);
  await validateSupersession(db,normalized,current.resolutionId);
  await ensureNoDuplicate(db, normalized, current.resolutionId);
  const changed = Object.keys(normalized).filter(field => JSON.stringify(current[field] ?? null) !== JSON.stringify(normalized[field] ?? null));
  const nextAudit = [...(current.auditLog || []), auditEntry('updated-draft', requestedBy, {
    fields:changed,
    oldValue:auditValueSnapshot(current),
    newValue:{ ...normalized, status:'draft' }
  })].slice(-200);
  const result = await db.collection(COLLECTION).updateOne(
    { resolutionId:current.resolutionId, status:current.status, revision:expectedRevision },
    { $set:{ ...normalized, status:'draft', revision:expectedRevision + 1, approvedBy:null, approvedAt:null, rejectedBy:null, rejectedAt:null, auditLog:nextAudit, updatedAt:new Date() } }
  );
  if (!result.matchedCount) fail('MANUAL_COST_CONCURRENT_CHANGE', 'Resolution هم‌زمان تغییر کرده است؛ دوباره بارگذاری کنید.', 409);
  invalidateReadinessCache(db);
  return { ok:true, resolution:await getById(db, resolutionId) };
}
async function transition(db, resolutionId, action, requestedBy, input = {}) {
  const options = typeof input === 'string' ? { reason:input } : (input || {});
  const reason = clean(options.reason, 1000);
  assertRole(requestedBy?.role, action === 'submit' ? EDIT_ROLES : APPROVE_ROLES);
  const current = await getById(db, resolutionId);
  const expectedRevision = Number(options.revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== Number(current.revision || 1)) {
    fail('MANUAL_COST_CONCURRENT_CHANGE', 'نسخه Resolution تغییر کرده است؛ دوباره بارگذاری کنید.', 409);
  }
  const transitions = {
    submit:{ from:['draft'], to:'pending' },
    approve:{ from:['pending'], to:'approved' },
    reject:{ from:['pending'], to:'rejected' },
    expire:{ from:['approved'], to:'expired' }
  };
  const rule = transitions[action];
  if (!rule || !rule.from.includes(current.status)) {
    fail('MANUAL_COST_INVALID_TRANSITION', `انتقال وضعیت ${current.status} با عملیات ${action} مجاز نیست.`, 409);
  }
  if(['submit','approve'].includes(action)){
    await assertStableItemIdentity(db,current);
    await validateSupersession(db,current,current.resolutionId);
    await ensureNoDuplicate(db,current,current.resolutionId);
    await assertNoOpeningCollision(db,current);
  }
  let approvalPreview=null;
  if(action==='approve'){
    approvalPreview=await impactPreview(db,current.resolutionId,requestedBy);
    const expectedPreview=clean(options.previewFingerprint,64);
    if(!expectedPreview)fail('MANUAL_COST_IMPACT_PREVIEW_REQUIRED','پیش‌نمایش اثر معتبر قبل از Approval الزامی است.',409);
    if(expectedPreview!==approvalPreview.previewFingerprint)fail('MANUAL_COST_IMPACT_PREVIEW_STALE','پیش‌نمایش اثر با Revision یا lineage فعلی تطابق ندارد؛ دوباره بررسی کنید.',409);
  }
  const now = new Date();
  const patch = {
    status:rule.to,
    revision:expectedRevision + 1,
    updatedAt:now,
    auditLog:[...(current.auditLog || []), auditEntry(action, requestedBy, {
      reason,
      fromStatus:current.status,
      toStatus:rule.to,
      oldValue:{ status:current.status },
      newValue:{ status:rule.to }
    })].slice(-200)
  };
  if (action === 'approve') Object.assign(patch, { approvedBy:actor(requestedBy), approvedAt:now, approvedImpactPreview:{fingerprint:approvalPreview.previewFingerprint,fifoDatasetId:approvalPreview.datasetId,resolutionContentHash:approvalPreview.resolutionContentHash,affected:approvalPreview.affected,quantity:approvalPreview.quantity,affectedLines:approvalPreview.affectedLines.map(row=>({saleLineId:row.saleLineId,potentiallyCoveredQuantityExact:row.potentiallyCoveredQuantityExact})),affectedSaleLinePopulationFingerprint:clean(current.affectedSaleLinePopulationFingerprint,64),recordedAt:now} });
  if (action === 'reject') Object.assign(patch, { rejectedBy:actor(requestedBy), rejectedAt:now, rejectionReason:clean(reason, 1000) });
  if (action === 'expire') Object.assign(patch, { expiredBy:actor(requestedBy), expiredAt:now, expirationReason:clean(reason, 1000) });
  const result = await db.collection(COLLECTION).updateOne(
    { resolutionId:current.resolutionId, status:current.status, revision:expectedRevision },
    { $set:patch }
  );
  if (!result.matchedCount) fail('MANUAL_COST_CONCURRENT_CHANGE', 'وضعیت Resolution هم‌زمان تغییر کرده است؛ دوباره بارگذاری کنید.', 409);
  if(action==='approve')await db.collection('fifoSourceInvalidations').insertOne({invalidationId:'FST-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),reason:'approved-manual-cost-set-changed',resolutionId:current.resolutionId,manualCostContentHash:current.contentHash,previewFingerprint:approvalPreview.previewFingerprint,createdBy:actor(requestedBy),createdAt:now,immutable:true});
  invalidateReadinessCache(db);
  return { ok:true, resolution:await getById(db, resolutionId) };
}
async function list(db, filters = {}) {
  let rows = await allRows(db.collection(COLLECTION), {});
  const search = key(filters.search);
  if (filters.status) rows = rows.filter(row => row.status === clean(filters.status));
  if (filters.sourceType) rows = rows.filter(row => row.sourceType === clean(filters.sourceType));
  if (filters.itemCode) rows = rows.filter(row => key(row.itemCode) === key(filters.itemCode));
  if (search) rows = rows.filter(row => [
    row.resolutionId, row.itemCode, row.itemGuid, row.reason, row.notes, row.createdBy?.username
  ].some(value => key(value).includes(search)));
  rows.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const total = rows.length;
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), 200));
  return { ok:true, total, page, pageSize, list:rows.slice((page - 1) * pageSize, page * pageSize) };
}
async function legacyItemScopeAudit(db, requestedBy = {}) {
  assertRole(requestedBy?.role,['admin','accounting','manager']);
  const [rows,state]=await Promise.all([
    db.collection(COLLECTION).find({status:'approved',deleted:{$ne:true}}).toArray(),
    db.collection('fifoDatasetState').findOne({scopeKey:'fifo-shadow-v2-precision-evidence'})
  ]);
  const legacy=rows.filter(row=>(!row.resolutionScope||row.resolutionScope==='item')&&Number(row.schemaVersion||0)<SCHEMA_VERSION);
  const superseded=new Set(rows.map(row=>clean(row.supersedesResolutionId,100)).filter(Boolean));
  const allocations=state?.activeDatasetId?await db.collection('fifoAllocations').find({datasetId:state.activeDatasetId,manualResolutionId:{$in:legacy.map(row=>row.resolutionId)}}).toArray():[];
  const list=legacy.map(row=>{
    const used=allocations.filter(allocation=>allocation.manualResolutionId===row.resolutionId);
    const bounded=Boolean(clean(row.targetQuantityExact||row.affectedQuantityExact,100)&&clean(row.effectiveFrom,8)&&clean(row.effectiveTo,8));
    const classification=superseded.has(row.resolutionId)?'SUPERSEDED':used.length===0?'UNUSED':bounded?'SAFE_BOUNDED_BY_EXISTING_EVIDENCE':'REQUIRES_MANAGEMENT_REVIEW';
    return {resolutionId:row.resolutionId,itemGuid:clean(row.itemGuid,100),itemCode:clean(row.itemCode,100),classification,legacyClass:LEGACY_UNBOUNDED_CLASS,activeFifoDatasetId:clean(state?.activeDatasetId,100),activeAllocationCount:used.length,activeQuantityExact:accountingDecimal.format(used.reduce((sum,item)=>sum+accountingDecimal.parse(item.quantityExact??item.allocatedQty??0,accountingDecimal.QUANTITY_SCALE),0n),accountingDecimal.QUANTITY_SCALE),effectiveFrom:clean(row.effectiveFrom,8),effectiveTo:clean(row.effectiveTo,8),targetQuantityExact:clean(row.targetQuantityExact,100),futureFifoEligible:row.legacyConsumptionReview?.status==='approved-for-fifo'};
  });
  return {ok:true,readOnly:true,total:list.length,requiresManagementReview:list.filter(row=>row.classification==='REQUIRES_MANAGEMENT_REVIEW').length,list};
}
function validAt(row, saleDate) {
  return row.status === 'approved' &&
    row.deleted !== true &&
    /^1[34]\d{6}$/.test(clean(row.effectiveFrom, 8)) &&
    row.effectiveFrom <= saleDate &&
    (!row.effectiveTo || row.effectiveTo >= saleDate);
}
function effectiveRowsAt(rows = [], saleDate = '') {
  const eligible=(rows||[]).filter(row=>validAt(row,saleDate));
  const superseded=new Set(eligible.map(row=>clean(row.supersedesResolutionId,100)).filter(Boolean));
  return eligible.filter(row=>!superseded.has(clean(row.resolutionId,100)));
}
function officialLayerValid(row) {
  const cost = Number(row.netUnitCost ?? row.grossUnitCost);
  return row.layerKind === 'purchase' &&
    row.validationStatus !== 'rejected' &&
    Number.isFinite(cost) &&
    cost > 0;
}
function matchesOfficial(row, sale) {
  const saleGuid = key(sale.itemGuid);
  const rowGuid = key(row.itemGuid);
  if (saleGuid) return (rowGuid && rowGuid === saleGuid) || (!rowGuid && key(row.itemCode) === key(sale.itemCode));
  return key(row.itemCode) === key(sale.itemCode);
}
function matchesManual(row, sale) {
  const saleGuid = key(sale.itemGuid);
  const rowGuid = key(row.itemGuid);
  if(Number(row.schemaVersion||0)>=SCHEMA_VERSION||row.evidenceClass==='COMMERCIAL_ANNOUNCED_COST')return Boolean(saleGuid&&rowGuid&&saleGuid===rowGuid);
  if (saleGuid) return (rowGuid && rowGuid === saleGuid) || (!rowGuid && key(row.itemCode) === key(sale.itemCode));
  return key(row.itemCode) === key(sale.itemCode);
}
function addToIndex(map, indexKey, row) {
  if (!indexKey) return;
  if (!map.has(indexKey)) map.set(indexKey, []);
  map.get(indexKey).push(row);
}
function indexedRows(context, prefix, sale, allowCodeWithMissingGuid = false) {
  const saleGuid = key(sale.itemGuid);
  const saleCode = key(sale.itemCode);
  if (!saleGuid) return context[`${prefix}ByCode`].get(saleCode) || [];
  const exactGuid = context[`${prefix}ByGuid`].get(saleGuid) || [];
  if (!allowCodeWithMissingGuid) return exactGuid;
  const missingGuidByCode = (context[`${prefix}ByCode`].get(saleCode) || []).filter(row => !key(row.itemGuid));
  return [...new Set([...exactGuid, ...missingGuidByCode])];
}
function brandOf(row) {
  return clean(row.brand || row.itemBrand || clean(row.itemName || row.itemDescription).split(/\s+/)[0], 100);
}
function classifyMissing(sale, context) {
  const code = key(sale.itemCode);
  const guid = key(sale.itemGuid);
  const codeLayers = context.allLayersByCode.get(code) || [];
  const guidLayers = guid ? (context.allLayersByGuid.get(guid) || []) : [];
  const legacyRows = [...new Set([
    ...(context.legacyByCode.get(code) || []),
    ...(guid ? context.legacyByGuid.get(guid) || [] : [])
  ])];
  const returnRows = [...new Set([
    ...(context.returnsByCode.get(code) || []),
    ...(guid ? context.returnsByGuid.get(guid) || [] : [])
  ])];
  if (codeLayers.some(row => key(row.itemGuid) && key(row.itemGuid) !== guid) && guid) return 'item_guid_mismatch';
  if (guidLayers.some(row => key(row.itemCode) !== code)) return 'item_code_changed';
  if (returnRows.some(row => ['unmatched', 'ambiguous', 'quantity-exceeds-purchase'].includes(row.returnMatchStatus))) return 'purchase_return_ambiguity';
  if (legacyRows.length) return 'legacy_layer_only';
  if (context.purchaseDateFrom && sale.saleDate && sale.saleDate < context.purchaseDateFrom) return 'historical_purchase_outside_range';
  if (!codeLayers.length && !guidLayers.length) return 'no_purchase_found';
  return 'unknown_cost';
}
const SUGGESTIONS = Object.freeze({
  no_purchase_found:'فاکتور خرید تاریخی را پیدا کنید یا Resolution هزینه دستی مستند ثبت کنید.',
  historical_purchase_outside_range:'بازه Dataset خرید را به عقب گسترش دهید؛ در صورت نبود منبع، موجودی افتتاحیه ثبت کنید.',
  item_guid_mismatch:'نگاشت ItemGuid بین فروش و خرید را با اسناد شایگان بررسی کنید.',
  item_code_changed:'تغییر کد کالا را با ItemGuid و اسناد تاریخی تطبیق دهید.',
  purchase_return_ambiguity:'ارتباط برگشت خرید با فاکتور و ردیف خرید اصلی را تعیین کنید.',
  legacy_layer_only:'منبع Legacy را اعتبارسنجی و در صورت تأیید به Resolution رسمی مستند تبدیل کنید.',
  unknown_cost:'ردیف خرید ناقص یا هزینه نامعتبر را بررسی کنید.',
  source_history_incomplete:'هویت کالا ثبت شده اما تکمیل تاریخچه خرید اثبات نشده است؛ ابتدا Recovery محدود Purchase Engine را اجرا کنید.'
});
async function loadReadinessContext(db) {
  const [purchaseActive,saleActive]=await Promise.all([purchaseLayerDataset.activeDataset(db),saleSnapshot._activeDataset(db)]);
  const cacheKey=`${clean(purchaseActive?.datasetId,100)}|${clean(saleActive?.snapshotId,100)}`;
  const cached=db.databaseName?readinessCache.get(db):null;
  if(cached&&cached.key===cacheKey&&Date.now()-cached.at<READINESS_CACHE_TTL_MS)return cached.value||cached.promise;
  const loading=(async()=>{const [allLayers,manual,saleRows,legacyLayers]=await Promise.all([
      purchaseActive?.datasetId?allRows(db.collection(purchaseLayerDataset.LAYERS),canonicalLayerContract.canonicalLayerQuery({datasetId:purchaseActive.datasetId})):[],
      allRows(db.collection(COLLECTION),{status:'approved'}),
      allRows(db.collection(saleActive.lineCollection),{...saleActive.lineQuery,saleInvoiceType:2}),
      allRows(db.collection(purchaseLayerDataset.LAYERS),{datasetId:{$exists:false}}).catch(()=>[])
    ]);
  const itemCodes=[...new Set(saleRows.map(row=>clean(row.itemCode,100)).filter(Boolean))],itemGuids=[...new Set(saleRows.map(row=>clean(row.itemGuid,100)).filter(Boolean))];
  const catalogRows=itemCodes.length||itemGuids.length?await allRows(db.collection(canonicalItemCatalog.CATALOG),{$or:[...(itemCodes.length?[{itemCode:{$in:itemCodes}}]:[]),...(itemGuids.length?[{itemGuid:{$in:itemGuids}}]:[])]}):[];
  const official = allLayers.filter(officialLayerValid);
  const returns = allLayers.filter(row => row.layerKind === 'purchase-return');
  const indexes = {};
  for (const prefix of ['allLayers','official','returns','manual','legacy']) {
    indexes[`${prefix}ByCode`] = new Map();
    indexes[`${prefix}ByGuid`] = new Map();
  }
  for (const [prefix, rows] of [
    ['allLayers', allLayers],
    ['official', official],
    ['returns', returns],
    ['manual', manual],
    ['legacy', legacyLayers]
  ]) {
    for (const row of rows) {
      addToIndex(indexes[`${prefix}ByCode`], key(row.itemCode), row);
      addToIndex(indexes[`${prefix}ByGuid`], key(row.itemGuid), row);
    }
  }
  const value={
    purchaseActive,
    saleActive,
    allLayers,
    official,
    returns,
    manual,
    saleRows,
    legacyLayers,
    catalogByCode:new Map(catalogRows.map(row=>[key(row.itemCode),row])),
    catalogByGuid:new Map(catalogRows.filter(row=>key(row.itemGuid)).map(row=>[key(row.itemGuid),row])),
    ...indexes,
    purchaseDateFrom:clean(purchaseActive?.dataset?.sourceDateFrom || purchaseActive?.dataset?.request?.dateFrom)
  };return value;})();
  if(db.databaseName)readinessCache.set(db,{key:cacheKey,at:Date.now(),promise:loading});
  try{const value=await loading;if(db.databaseName)readinessCache.set(db,{key:cacheKey,at:Date.now(),value});return value;}catch(error){invalidateReadinessCache(db);throw error;}
}

function identityMatches(row, target) {
  const targetGuid=key(target.itemGuid),rowGuid=key(row.itemGuid);
  if(targetGuid&&rowGuid)return targetGuid===rowGuid;
  return Boolean(key(target.itemCode))&&key(target.itemCode)===key(row.itemCode);
}
function eligibleSuggestionLayer(row, target, applicableDate) {
  if(!identityMatches(row,target)||row.layerKind!=='purchase')return false;
  if(clean(row.costStatus).toLowerCase()===canonicalLayerContract.PENDING_PURCHASE_PRICE)return false;
  if(['rejected','invalid'].includes(clean(row.validationStatus).toLowerCase()))return false;
  if(row.returnMatchStatus&&['ambiguous','quantity-exceeds-purchase','unmatched'].includes(clean(row.returnMatchStatus)))return false;
  const purchaseDate=clean(row.purchaseInvoiceDate,8);
  if(!/^1[34]\d{6}$/.test(purchaseDate)||purchaseDate>applicableDate)return false;
  try {
    const quantity=accountingDecimal.parse(row.netPurchasedQuantityExact??row.netPurchasedQuantity??row.originalQuantityExact??row.originalQuantity,accountingDecimal.QUANTITY_SCALE);
    const unitCost=accountingDecimal.parse(row.netUnitCostExact??row.netUnitCost??row.grossUnitCostExact??row.grossUnitCost,accountingDecimal.UNIT_COST_SCALE);
    return quantity>0n&&unitCost>0n;
  } catch (_) { return false; }
}
function suggestionFromLayers(rows=[], target={}, applicableDate='', affectedQuantityExact='') {
  const eligible=rows.filter(row=>eligibleSuggestionLayer(row,target,applicableDate));
  const excludedPending=rows.filter(row=>identityMatches(row,target)&&row.layerKind==='purchase'&&clean(row.purchaseInvoiceDate,8)<=applicableDate&&clean(row.costStatus).toLowerCase()===canonicalLayerContract.PENDING_PURCHASE_PRICE);
  const excludedEvidence=excludedPending.map(row=>({purchaseLineIdentity:clean(row.purchaseLineIdentity,500),purchaseInvoiceNumber:Number(row.purchaseInvoiceNo||0),purchaseInvoiceDate:clean(row.purchaseInvoiceDate,8),quantityExact:clean(row.netPurchasedQuantityExact??row.netPurchasedQuantity??row.originalQuantityExact??row.originalQuantity,100),unitCostExact:clean(row.netUnitCostExact??row.netUnitCost??row.grossUnitCostExact??row.grossUnitCost,100),costStatus:clean(row.costStatus),sourceHash:clean(row.sourceHash,128)}));
  const excludedQuantity=excludedPending.reduce((sum,row)=>{try{return sum+accountingDecimal.parse(row.netPurchasedQuantityExact??row.netPurchasedQuantity??row.originalQuantityExact??row.originalQuantity,accountingDecimal.QUANTITY_SCALE);}catch(_){return sum;}},0n);
  const excluded={excludedPendingCount:excludedEvidence.length,excludedPendingQuantityExact:accountingDecimal.format(excludedQuantity,accountingDecimal.QUANTITY_SCALE),excludedPurchaseIds:[...new Set(excludedEvidence.map(row=>String(row.purchaseInvoiceNumber)))],excludedEvidence};
  if(!eligible.length)return {available:false,method:'NO_VALID_HISTORICAL_PURCHASE',suggestedCostExact:null,purchaseCount:0,eligiblePurchaseCount:0,quantityBasisExact:'0.000000',sourcePurchaseIds:[],sourceFingerprint:crypto.createHash('sha256').update('[]').digest('hex'),evidence:[],...excluded};
  let quantity=0n,totalCost=0n;
  const evidence=eligible.map(row=>{
    const q=accountingDecimal.parse(row.netPurchasedQuantityExact??row.netPurchasedQuantity??row.originalQuantityExact??row.originalQuantity,accountingDecimal.QUANTITY_SCALE);
    const c=accountingDecimal.parse(row.netUnitCostExact??row.netUnitCost??row.grossUnitCostExact??row.grossUnitCost,accountingDecimal.UNIT_COST_SCALE);
    quantity+=q;totalCost+=q*c;
    return {purchaseLineIdentity:clean(row.purchaseLineIdentity,500),purchaseInvoiceNumber:Number(row.purchaseInvoiceNo||0),purchaseInvoiceDate:clean(row.purchaseInvoiceDate,8),supplierIdentity:clean(row.supplierAccountNumber||row.supplierGuid,100),supplierName:clean(row.supplierName,250),quantityExact:accountingDecimal.format(q,accountingDecimal.QUANTITY_SCALE),unitCostExact:accountingDecimal.format(c,accountingDecimal.UNIT_COST_SCALE),sourceHash:clean(row.sourceHash,128)};
  }).sort((a,b)=>a.purchaseInvoiceDate.localeCompare(b.purchaseInvoiceDate)||a.purchaseLineIdentity.localeCompare(b.purchaseLineIdentity));
  const weighted=accountingDecimal.divideRounded(totalCost,quantity);
  const costs=evidence.map(row=>accountingDecimal.parse(row.unitCostExact,accountingDecimal.UNIT_COST_SCALE));
  const latest=evidence[evidence.length-1];
  const fingerprint=crypto.createHash('sha256').update(stable(evidence.map(row=>[row.purchaseLineIdentity,row.sourceHash,row.quantityExact,row.unitCostExact]))).digest('hex');
  const affected=affectedQuantityExact?accountingDecimal.parse(affectedQuantityExact,accountingDecimal.QUANTITY_SCALE):quantity,covered=affected<quantity?affected:quantity;
  return {available:true,method:'WEIGHTED_AVERAGE_HISTORICAL_OFFICIAL_PURCHASES',suggestedCostExact:accountingDecimal.format(weighted,accountingDecimal.UNIT_COST_SCALE),purchaseCount:evidence.length,eligiblePurchaseCount:evidence.length,quantityBasisExact:accountingDecimal.format(quantity,accountingDecimal.QUANTITY_SCALE),eligibleTargetQuantityExact:accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),totalRequiredQuantityExact:accountingDecimal.format(affected,accountingDecimal.QUANTITY_SCALE),remainingUnknownQuantityExact:accountingDecimal.format(affected-covered,accountingDecimal.QUANTITY_SCALE),evidenceQuality:'BROAD_ITEM_LEVEL_HISTORICAL_AVERAGE',dateFrom:evidence[0].purchaseInvoiceDate,dateTo:latest.purchaseInvoiceDate,minPurchaseCostExact:accountingDecimal.format(costs.reduce((a,b)=>a<b?a:b),accountingDecimal.UNIT_COST_SCALE),maxPurchaseCostExact:accountingDecimal.format(costs.reduce((a,b)=>a>b?a:b),accountingDecimal.UNIT_COST_SCALE),latestPurchaseCostExact:latest.unitCostExact,sourcePurchaseIds:[...new Set(evidence.map(row=>String(row.purchaseInvoiceNumber)))],sourceFingerprint:fingerprint,evidence,...excluded};
}
function openingSuggestion(row,target={},applicableDate='',affectedQuantityExact='') {
  if(!row||!['available','VALIDATED_CANDIDATE'].includes(row.status)||row.extractionComplete!==true)return null;
  if(!identityMatches(row,target)||!row.effectiveOpeningDate||row.effectiveOpeningDate>applicableDate)return null;
  const openingQty=accountingDecimal.parse(row.openingQuantityExact,accountingDecimal.QUANTITY_SCALE);
  const affectedQty=affectedQuantityExact?accountingDecimal.parse(affectedQuantityExact,accountingDecimal.QUANTITY_SCALE):openingQty;
  if(openingQty<=0n||affectedQty<=0n)return null;
  const covered=affectedQty<openingQty?affectedQty:openingQty;
  const datasetId=clean(row.datasetId,100),approvalStatus=clean(row.approvalStatus,50);
  const reviewOnly=Boolean(datasetId)&&approvalStatus!=='approved';
  return {available:true,sourceClass:'OPENING_ACCOUNTING_COST',method:'SHAYGAN_BEGIN_DURATION_REMAIN_ACCOUNTING_COST',itemGuid:clean(row.itemGuid,100),itemCode:clean(row.itemCode,100),suggestedCostExact:clean(row.openingUnitCostExact,100),quantityBasisExact:accountingDecimal.format(openingQty,accountingDecimal.QUANTITY_SCALE),eligibleTargetQuantityExact:accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),totalRequiredQuantityExact:accountingDecimal.format(affectedQty,accountingDecimal.QUANTITY_SCALE),remainingUnknownQuantityExact:accountingDecimal.format(affectedQty-covered,accountingDecimal.QUANTITY_SCALE),effectiveOpeningDate:clean(row.effectiveOpeningDate,8),openingQuantityExact:clean(row.openingQuantityExact,100),openingUnitCostExact:clean(row.openingUnitCostExact,100),openingTotalValueExact:clean(row.openingTotalValueExact,100),sourceFields:row.sourceFields||{},sourceFingerprint:clean(row.sourceFingerprint,64),recordFingerprint:clean(row.recordFingerprint,64),evidenceQuality:clean(row.evidenceQuality,100),evidenceId:clean(row.evidenceId,100),openingEvidenceDatasetId:datasetId,warehouseEvidence:Array.isArray(row.warehouseEvidence)?row.warehouseEvidence.map(value=>({warehouseNumber:clean(value.warehouseNumber,100),openingQuantityExact:clean(value.openingQuantityExact,100),openingTotalValueExact:clean(value.openingTotalValueExact,100),openingUnitCostExact:clean(value.openingUnitCostExact,100),evidenceQuality:clean(value.evidenceQuality,100),extractionComplete:value.extractionComplete===true})):[],queriedWarehouseCount:Number(row.queriedWarehouseCount||0),warehouseCount:Number(row.warehouseCount||0),approvalStatus,authorityStatus:reviewOnly?'VALIDATED_NOT_APPROVED':'APPROVED',reviewOnly,financialAuthority:!reviewOnly,extractedAt:row.extractedAt||row.updatedAt||null,partialTarget:affectedQty>openingQty};
}

async function latestOpeningReviewDataset(db){
  return db.collection(openingCostBasis.DATASETS).findOne(
    {status:'completed',approvalStatus:{$in:['validated','pending','approved']}},
    {sort:{completedAt:-1,createdAt:-1,updatedAt:-1}}
  ).catch(()=>null);
}

async function openingReviewLineage(db,purchaseDatasetId,openingDataset){
  const fifoDatasetId=clean(openingDataset?.eligibilityPreview?.fifoDatasetId,100);
  const fifoDataset=fifoDatasetId?await db.collection('fifoDatasets').findOne({datasetId:fifoDatasetId}).catch(()=>null):null;
  let saleSnapshotId=clean(fifoDataset?.sourceSaleSnapshotId||fifoDataset?.saleSnapshotId,100);
  if(!saleSnapshotId){
    const saleState=await db.collection('saleSnapshotState').findOne({activeSnapshotId:{$exists:true,$ne:''}},{sort:{activatedAt:-1,updatedAt:-1}}).catch(()=>null);
    saleSnapshotId=clean(saleState?.activeSnapshotId,100);
  }
  return {saleSnapshotId,purchaseDatasetId:clean(purchaseDatasetId,100),openingDatasetId:clean(openingDataset?.datasetId,100),openingApprovalStatus:clean(openingDataset?.approvalStatus,50),openingEligibilityFifoDatasetId:fifoDatasetId,openingEligibilitySaleSnapshotId:clean(fifoDataset?.sourceSaleSnapshotId||fifoDataset?.saleSnapshotId,100)};
}

async function openingEligibilitySummary(db,openingRow,target){
  const datasetId=clean(openingRow?.datasetId,100);if(!datasetId)return null;
  const identityParts=[];if(clean(target.itemGuid,100))identityParts.push({itemGuid:clean(target.itemGuid,100)});if(clean(target.itemCode,100))identityParts.push({itemCode:clean(target.itemCode,100)});
  const rows=await db.collection(openingCostBasis.ELIGIBILITY).find({datasetId,...(identityParts.length===1?identityParts[0]:{$or:identityParts})}).sort({saleDate:1,saleInvoiceNo:1,saleRow:1}).limit(5000).toArray();
  if(!rows.length)return null;
  let required=0n,covered=0n,remaining=0n;
  for(const row of rows){required+=accountingDecimal.parse(row.unknownQuantityExact||0,accountingDecimal.QUANTITY_SCALE);covered+=accountingDecimal.parse(row.openingEligibleQuantityExact||0,accountingDecimal.QUANTITY_SCALE);remaining+=accountingDecimal.parse(row.remainingUnknownQuantityExact||0,accountingDecimal.QUANTITY_SCALE);}
  return {totalRequiredQuantityExact:accountingDecimal.format(required,accountingDecimal.QUANTITY_SCALE),eligibleTargetQuantityExact:accountingDecimal.format(covered,accountingDecimal.QUANTITY_SCALE),remainingUnknownQuantityExact:accountingDecimal.format(remaining,accountingDecimal.QUANTITY_SCALE),mixedTimeline:rows.some(row=>row.classification==='PRE_OPENING_PERIOD')&&rows.some(row=>Number(row.openingEligibleQuantityExact)>0),rows:rows.map(row=>({saleLineIdentity:clean(row.saleLineIdentity,500),saleInvoiceNo:Number(row.saleInvoiceNo||0),saleRow:Number(row.saleRow||0),saleDate:clean(row.saleDate,8),unknownQuantityExact:clean(row.unknownQuantityExact,100),openingEligibleQuantityExact:clean(row.openingEligibleQuantityExact,100),remainingUnknownQuantityExact:clean(row.remainingUnknownQuantityExact,100),classification:clean(row.classification,100),earlierOfficialPurchaseAvailable:row.earlierOfficialPurchaseAvailable===true,laterPurchaseAvailable:row.laterPurchaseAvailable===true}))};
}
function openingConflict(opening,governedRows=[]) {
  if(!opening)return null;
  const conflicts=governedRows.filter(row=>row.status==='approved'&&identityMatches(row,opening)).filter(row=>{
    try{return accountingDecimal.rescale(accountingDecimal.parse(row.unitCostExact,accountingDecimal.UNIT_COST_SCALE),accountingDecimal.UNIT_COST_SCALE,0)!==accountingDecimal.rescale(accountingDecimal.parse(opening.openingUnitCostExact,accountingDecimal.UNIT_COST_SCALE),accountingDecimal.UNIT_COST_SCALE,0);}catch(_){return true;}
  });
  if(!conflicts.length)return null;
  return {available:false,sourceClass:'CONFLICT_REQUIRES_REVIEW',method:'OPENING_ACCOUNTING_COST_CONFLICT',suggestedCostExact:null,sourceFingerprint:opening.sourceFingerprint,evidenceQuality:'CONFLICT',openingEvidence:opening,conflicts:conflicts.map(row=>({evidenceId:clean(row.evidenceId,100),openingDate:clean(row.openingDate,8),quantityExact:clean(row.quantityExact,100),unitCostExact:clean(row.unitCostExact,100),contentHash:clean(row.contentHash,64)}))};
}
async function assistedSuggestion(db,input={},requestedBy={}) {
  assertRole(requestedBy?.role,['admin','accounting','manager','purchase']);
  const itemGuid=clean(input.itemGuid,100),itemCode=clean(input.itemCode,100);
  if(!itemGuid&&!itemCode)fail('MANUAL_COST_TARGET_REQUIRED','هویت هدف هزینه الزامی است.');
  const applicableDate=date8(input.applicableDate,'applicableDate');
  const reviewDateTo=clean(input.reviewDateTo,100)?date8(input.reviewDateTo,'reviewDateTo'):applicableDate;
  const active=await purchaseLayerDataset.activeDataset(db);
  const datasetId=clean(input.purchaseDatasetId||active?.datasetId,100);
  if(!datasetId)fail('PURCHASE_DATASET_REQUIRED','Purchase Dataset رسمی در دسترس نیست.',409);
  const dataset=await db.collection(purchaseLayerDataset.DATASETS).findOne({datasetId});
  if(!dataset||dataset.status!=='completed')fail('PURCHASE_DATASET_NOT_CANONICAL','فقط Dataset ساخته‌شده توسط Purchase Engine رسمی مجاز است.',409);
  const identityParts=[];if(itemGuid)identityParts.push({itemGuid});if(itemCode)identityParts.push({itemCode});
  const layerQuery=canonicalLayerContract.canonicalLayerQuery({datasetId,purchaseInvoiceDate:{$lte:applicableDate},...(identityParts.length===1?identityParts[0]:{$or:identityParts})});
  const [layers,openingRows,governedOpening]=await Promise.all([
    db.collection(purchaseLayerDataset.LAYERS).find(layerQuery).sort({purchaseInvoiceDate:1,purchaseInvoiceNo:1,sourceRow:1}).limit(5001).toArray(),
    db.collection(openingCostBasis.COLLECTION).find({status:{$in:['available','VALIDATED_CANDIDATE','NO_OPENING_STOCK']},extractionComplete:true,...(identityParts.length===1?identityParts[0]:{$or:identityParts}),effectiveOpeningDate:{$lte:reviewDateTo}}).sort({effectiveOpeningDate:-1,createdAt:-1,updatedAt:-1}).limit(10).toArray(),
    db.collection('openingInventoryEvidence').find({status:'approved',...(identityParts.length===1?identityParts[0]:{$or:identityParts})}).limit(20).toArray()
  ]);
  if(layers.length>5000)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target:{itemGuid,itemCode},available:false,method:'EVIDENCE_LIMIT_EXCEEDED',suggestedCostExact:null,purchaseCount:layers.length,evidenceComplete:false,limit:5000};
  const target={itemGuid,itemCode};
  const unresolvedReturns=layers.filter(row=>row.layerKind==='purchase-return'&&row.returnMatchStatus!=='matched');
  if(unresolvedReturns.length)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,available:false,manualCostRequired:false,sourceClass:'PURCHASE_RETURN_CONFLICT',method:'PURCHASE_RETURN_REQUIRES_GOVERNED_LINKAGE',suggestedCostExact:null,returnCount:unresolvedReturns.length,returnEvidence:unresolvedReturns.map(row=>({purchaseLineIdentity:clean(row.purchaseLineIdentity,500),returnInvoiceNumber:Number(row.purchaseInvoiceNo||0),returnDate:clean(row.purchaseInvoiceDate,8),quantityExact:clean(row.returnedQuantityExact??row.returnedQuantity,100),returnMatchStatus:clean(row.returnMatchStatus),returnLinkageClass:clean(row.returnLinkageClass)})),remediation:'REVIEW_CANONICAL_PURCHASE_RETURN_LINKAGE'};
  const exactIdentity=clean(input.purchaseLineIdentity,500);
  const exact=exactIdentity?layers.find(row=>clean(row.purchaseLineIdentity,500)===exactIdentity&&eligibleSuggestionLayer(row,target,applicableDate)):null;
  if(exact)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,available:false,manualCostRequired:false,sourceClass:'EXACT_OFFICIAL_PURCHASE_LAYER',method:'EXACT_OFFICIAL_PURCHASE_LAYER',suggestedCostExact:clean(exact.netUnitCostExact??exact.netUnitCost??exact.grossUnitCostExact??exact.grossUnitCost,100),purchaseLineIdentity:exactIdentity,remediation:'USE_CANONICAL_PURCHASE_LAYER'};
  let openingRow=openingRows[0],openingDataset=null;
  if(openingRow?.datasetId){
    openingDataset=await db.collection(openingCostBasis.DATASETS).findOne({datasetId:openingRow.datasetId});
    openingRow={...openingRow,approvalStatus:clean(openingDataset?.approvalStatus,50)};
  }
  const openingReviewContext=openingDataset?{reviewLineage:await openingReviewLineage(db,datasetId,openingDataset),openingReviewEvidence:{status:clean(openingRow?.status,100),evidenceId:clean(openingRow?.evidenceId,100),datasetId:clean(openingDataset.datasetId,100),approvalStatus:clean(openingDataset.approvalStatus,50),openingQuantityExact:clean(openingRow?.openingQuantityExact,100),openingUnitCostExact:clean(openingRow?.openingUnitCostExact,100),openingTotalValueExact:clean(openingRow?.openingTotalValueExact,100),queriedWarehouseCount:Number(openingRow?.queriedWarehouseCount||0),extractionComplete:openingRow?.extractionComplete===true}}:{};
  let opening=openingSuggestion(openingRow,target,reviewDateTo,clean(input.affectedQuantityExact,100));
  const eligibility=opening?await openingEligibilitySummary(db,openingRow,target):null;
  if(opening&&eligibility)opening={...opening,totalRequiredQuantityExact:eligibility.totalRequiredQuantityExact,eligibleTargetQuantityExact:eligibility.eligibleTargetQuantityExact,remainingUnknownQuantityExact:eligibility.remainingUnknownQuantityExact,eligibilityPreview:eligibility};
  const conflict=openingConflict(opening,governedOpening);
  if(conflict)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,...openingReviewContext,...conflict};
  if(opening)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,reviewDateTo,target,evidenceComplete:true,...openingReviewContext,...opening};
  const historical=suggestionFromLayers(layers,target,applicableDate,clean(input.affectedQuantityExact,100));
  if(historical.available)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,...openingReviewContext,sourceClass:'HISTORICAL_PURCHASE_AVERAGE',...historical};
  if(historical.excludedPendingCount)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,...openingReviewContext,sourceClass:'PENDING_PURCHASE_PRICE',available:false,manualCostRequired:false,method:'PENDING_PURCHASE_PRICE_QUARANTINE',suggestedCostExact:null,...historical,remediation:'WAIT_FOR_CANONICAL_PURCHASE_PRICE_CORRECTION'};
  const history=await canonicalItemCatalog.historyStatus(db,target);
  const requiredExact=clean(input.affectedQuantityExact,100)?accountingDecimal.format(accountingDecimal.parse(input.affectedQuantityExact,accountingDecimal.QUANTITY_SCALE),accountingDecimal.QUANTITY_SCALE):'0.000000';
  if(!history.complete)return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:false,...openingReviewContext,historyCompleteness:history.state,sourceClass:'SOURCE_HISTORY_INCOMPLETE',available:false,manualCostRequired:false,method:'BOUNDED_PURCHASE_HISTORY_RECOVERY_REQUIRED',suggestedCostExact:null,purchaseCount:0,quantityBasisExact:'0.000000',totalRequiredQuantityExact:requiredExact,eligibleTargetQuantityExact:'0.000000',remainingUnknownQuantityExact:requiredExact,sourceFingerprint:crypto.createHash('sha256').update(stable({target,historyState:history.state})).digest('hex'),remediation:'QUEUE_CANONICAL_PURCHASE_HISTORY_RECOVERY'};
  return {ok:true,readOnly:true,purchaseDatasetId:datasetId,applicableDate,target,evidenceComplete:true,...openingReviewContext,sourceClass:'NO_VALID_COST_BASIS',...historical};
}

function managementSourceLabel(sourceClass='') {
  return ({OPENING_ACCOUNTING_COST:'قیمت موجودی ابتدای دوره مصوب',HISTORICAL_PURCHASE_AVERAGE:'پیشنهاد میانگین خرید تاریخی',NO_VALID_COST_BASIS:'تعیین هزینه دستی برای exposure فاقد پیشنهاد معتبر',COMMERCIAL_ANNOUNCED_COST:'قیمت اعلام بازرگانی',COMMERCIAL_ANNOUNCED_COST_REFERENCING_OPENING:'قیمت اعلام بازرگانی با مرجع Opening مصوب',COMMERCIAL_ANNOUNCED_COST_REFERENCING_HISTORICAL_AVERAGE:'قیمت اعلام بازرگانی با مرجع میانگین خرید تاریخی',MANUAL_COST_NO_VALID_PROPOSAL:'تعیین هزینه دستی بدون پیشنهاد معتبر'})[sourceClass]||sourceClass;
}

function managementDecisionClass(review={}) {
  if(review.mode==='SUPERSEDE_APPROVED')return clean(review.technicalDetails?.previousManagementDecisionClass,100)||'COMMERCIAL_ANNOUNCED_COST';
  if(review.proposal?.sourceClass==='OPENING_ACCOUNTING_COST')return 'COMMERCIAL_ANNOUNCED_COST_REFERENCING_OPENING';
  if(review.proposal?.sourceClass==='HISTORICAL_PURCHASE_AVERAGE')return 'COMMERCIAL_ANNOUNCED_COST_REFERENCING_HISTORICAL_AVERAGE';
  if(review.proposal?.sourceClass==='NO_VALID_COST_BASIS')return 'MANUAL_COST_NO_VALID_PROPOSAL';
  return 'COMMERCIAL_ANNOUNCED_COST';
}

function positiveQuantity(value) {
  try{return accountingDecimal.parse(value||0,accountingDecimal.QUANTITY_SCALE)>0n;}catch(_){return false;}
}

async function resolveManagementIdentity(db,input={}) {
  const requestedGuid=canonicalItemCatalog.canonicalItemGuid(input.itemGuid),requestedCode=canonicalItemCatalog.canonicalItemCode(input.itemCode);
  const normalizedCode=canonicalItemCatalog.normalizedItemCode(requestedCode);
  if(!requestedCode)fail('MANUAL_COST_STABLE_IDENTITY_REQUIRED','انتخاب Queue باید ItemCode پایدار داشته باشد.',409);
  const queryParts=[{normalizedItemCode:normalizedCode},{itemCode:requestedCode}];
  if(requestedGuid)queryParts.push({canonicalItemGuid:requestedGuid},{itemGuid:requestedGuid});
  const rows=await db.collection(canonicalItemCatalog.CATALOG).find({$or:queryParts}).toArray();
  const codeRows=rows.filter(row=>canonicalItemCatalog.normalizedItemCode(row.normalizedItemCode||row.itemCode)===normalizedCode);
  const guidRows=requestedGuid?rows.filter(row=>canonicalItemCatalog.canonicalItemGuid(row.canonicalItemGuid||row.itemGuid)===requestedGuid):[];
  const resolved=canonicalItemCatalog._resolveExisting({itemGuid:requestedGuid,itemCode:requestedCode},guidRows,codeRows);
  const resolvedGuid=canonicalItemCatalog.canonicalItemGuid(resolved.existing?.canonicalItemGuid||resolved.existing?.itemGuid);
  if(resolved.conflict||!resolvedGuid)fail('MANUAL_COST_ITEM_IDENTITY_CONFLICT','ItemCode صف به یک ItemGuid یکتای canonical متصل نیست؛ تعیین هزینه تا رفع تعارض هویت مجاز نیست.',409);
  return {itemGuid:resolvedGuid,itemCode:canonicalItemCatalog.canonicalItemCode(resolved.existing?.itemCode||requestedCode)};
}

async function managementReview(db,input={},requestedBy={}) {
  assertRole(requestedBy?.role,MANAGEMENT_ROLES);
  const supersedesResolutionId=clean(input.supersedesResolutionId,100);
  if(supersedesResolutionId){
    const previous=await getById(db,supersedesResolutionId);
    if(previous.status!=='approved'||previous.deleted===true)fail('MANUAL_COST_SUPERSEDED_NOT_APPROVED','فقط هزینه مصوب و حذف‌نشده قابل اصلاح است.',409);
    if(![COMMERCIAL_SCOPE,'evidence_quantity','opening_quantity','purchase_layer'].includes(clean(previous.resolutionScope,50))||!positiveQuantity(previous.targetQuantityExact)||!previous.effectiveFrom||!previous.effectiveTo)fail('MANUAL_COST_CORRECTION_SCOPE_UNSAFE','هزینه قدیمی Scope محدود و قابل اثبات ندارد؛ اصلاح مدیریتی خودکار مجاز نیست.',409);
    const scope={itemGuid:clean(previous.itemGuid,100),itemCode:clean(previous.itemCode,100),targetQuantityExact:clean(previous.targetQuantityExact,100),effectiveFrom:clean(previous.effectiveFrom,8),effectiveTo:clean(previous.effectiveTo,8),purchaseDatasetId:clean(previous.purchaseDatasetId,100),resolutionScope:clean(previous.resolutionScope,50),scopeDerivationFingerprint:clean(previous.scopeDerivationFingerprint,64),openingDatasetId:clean(previous.openingDatasetId,100),openingEvidenceId:clean(previous.openingEvidenceId,100),openingCoveredQuantityExact:clean(previous.openingCoveredQuantityExact,100),affectedSaleLinePopulation:sanitizeAffectedSaleLinePopulation(previous.affectedSaleLinePopulation),affectedSaleLinePopulationFingerprint:clean(previous.affectedSaleLinePopulationFingerprint,64),activeFifoDatasetId:clean(previous.activeFifoDatasetId,100)};
    const reviewFingerprint=crypto.createHash('sha256').update(stable({mode:'SUPERSEDE_APPROVED',supersedesResolutionId,contentHash:clean(previous.contentHash,64),revision:Number(previous.revision||0),scope})).digest('hex');
    return {ok:true,readOnly:true,mode:'SUPERSEDE_APPROVED',actionAllowed:true,item:{itemGuid:scope.itemGuid,itemCode:scope.itemCode,itemDescription:''},exposure:{requiredQuantityExact:scope.targetQuantityExact,openingCoveredQuantityExact:scope.openingCoveredQuantityExact||'0.000000',unresolvedQuantityExact:scope.targetQuantityExact,affectedInvoiceCount:Number(previous.approvedImpactPreview?.affected?.invoices||0),affectedLineCount:Number(previous.approvedImpactPreview?.affected?.saleLines||previous.affectedLineCount||0),saleValueExposure:Number(previous.saleValueExposure||0),effectiveFrom:scope.effectiveFrom,effectiveTo:scope.effectiveTo},proposal:{available:true,sourceClass:'COMMERCIAL_ANNOUNCED_COST',sourceLabel:managementSourceLabel(previous.managementDecisionClass||'COMMERCIAL_ANNOUNCED_COST'),suggestedCostExact:clean(previous.manualCostExact||previous.manualCost,100),currentApprovedCostExact:clean(previous.manualCostExact||previous.manualCost,100)},scope,reviewFingerprint,supersedesResolutionId,technicalDetails:{previousResolutionId:previous.resolutionId,previousContentHash:previous.contentHash,previousRevision:Number(previous.revision||0),previousManagementDecisionClass:clean(previous.managementDecisionClass,100)},blockers:[]};
  }
  const identity=await resolveManagementIdentity(db,input),itemGuid=identity.itemGuid,itemCode=identity.itemCode;
  const [queue,economic]=await Promise.all([missingQueue(db,{coverage:'unknown',page:1,pageSize:5000,export:true}),activeFifoEconomicExposure(db,{itemGuid,itemCode})]);
  const row=(queue.list||[]).find(value=>key(value.itemCode)===key(itemCode)&&(!clean(value.itemGuid,100)||key(value.itemGuid)===key(itemGuid)));
  if(!row&&positiveQuantity(economic.unresolvedQuantityExact))fail('MANUAL_COST_EXPOSURE_NOT_FOUND','Exposure فاقد هزینه در FIFO فعال وجود دارد اما در Queue canonical قابل تطبیق نیست.',409);
  let suggestion;
  if(row)suggestion=await assistedSuggestion(db,{itemGuid,itemCode,applicableDate:row.firstSaleDate,reviewDateTo:row.lastSaleDate,affectedQuantityExact:String(row.saleQuantity||0),purchaseDatasetId:queue.activePurchaseLayerDatasetId},requestedBy);
  else{
    const collision=await approvedOpeningCollision(db,{itemGuid,itemCode,effectiveFrom:'00000000',effectiveTo:'99999999'}),basis=collision?await db.collection(openingCostBasis.COLLECTION).findOne({datasetId:collision.datasetId,evidenceId:collision.evidenceId}):null;
    suggestion={sourceClass:basis?'OPENING_ACCOUNTING_COST':'EXACT_OFFICIAL_PURCHASE_LAYER',available:Boolean(basis?.openingUnitCostExact),suggestedCostExact:clean(basis?.openingUnitCostExact,100),approvalStatus:basis?'approved':'',openingEvidenceDatasetId:clean(basis?.datasetId,100),evidenceId:clean(basis?.evidenceId,100),sourceFingerprint:clean(basis?.sourceFingerprint,64)};
  }
  const openingApproved=suggestion.sourceClass==='OPENING_ACCOUNTING_COST'&&suggestion.approvalStatus==='approved';
  const population=economic.affectedSaleLinePopulation;
  const effectiveFrom=clean(population[0]?.saleDate||economic.coveredLines[0]?.saleDate||row?.firstSaleDate,8),effectiveTo=clean(population[population.length-1]?.saleDate||economic.coveredLines[economic.coveredLines.length-1]?.saleDate||row?.lastSaleDate,8);
  const requiredQuantityExact=economic.requiredQuantityExact;
  const openingCoveredQuantityExact=economic.openingCoveredQuantityExact;
  const unresolvedQuantityExact=economic.unresolvedQuantityExact;
  const blockers=[];
  if(suggestion.reviewOnly===true||suggestion.financialAuthority===false)blockers.push('OPENING_EVIDENCE_NOT_APPROVED');
  if(suggestion.sourceClass==='EXACT_OFFICIAL_PURCHASE_LAYER')blockers.push('OFFICIAL_PURCHASE_PRECEDENCE');
  if(suggestion.sourceClass==='SOURCE_HISTORY_INCOMPLETE')blockers.push('SOURCE_HISTORY_INCOMPLETE');
  if(suggestion.sourceClass==='PENDING_PURCHASE_PRICE')blockers.push('PENDING_PURCHASE_PRICE');
  if(suggestion.sourceClass==='PURCHASE_RETURN_CONFLICT')blockers.push('PURCHASE_RETURN_CONFLICT');
  if(suggestion.sourceClass==='CONFLICT_REQUIRES_REVIEW')blockers.push('SOURCE_CONFLICT');
  if(!positiveQuantity(unresolvedQuantityExact))blockers.push('OPENING_AUTHORITY_ALREADY_COVERS_EXPOSURE');
  const scopeContract={activeFifoDatasetId:economic.datasetId,datasetId:openingApproved?clean(suggestion.openingEvidenceDatasetId,100):'',evidenceId:openingApproved?clean(suggestion.evidenceId,100):'',itemGuid,itemCode,effectiveFrom,effectiveTo,targetQuantityExact:unresolvedQuantityExact,openingCoveredQuantityExact,affectedSaleLinePopulationFingerprint:economic.affectedSaleLinePopulationFingerprint,remainingLines:population.map(value=>[value.saleLineId,value.saleDate,value.quantityExact])};
  const scopeDerivationFingerprint=crypto.createHash('sha256').update(stable(scopeContract)).digest('hex');
  const scope={itemGuid,itemCode,targetQuantityExact:unresolvedQuantityExact,effectiveFrom,effectiveTo,purchaseDatasetId:queue.activePurchaseLayerDatasetId,resolutionScope:COMMERCIAL_SCOPE,scopeDerivationFingerprint,openingDatasetId:scopeContract.datasetId,openingEvidenceId:scopeContract.evidenceId,openingCoveredQuantityExact,affectedSaleLinePopulation:population,affectedSaleLinePopulationFingerprint:economic.affectedSaleLinePopulationFingerprint,activeFifoDatasetId:economic.datasetId};
  const reviewContract={mode:'NEW_EXPOSURE',activeFifoDatasetId:economic.datasetId,saleSnapshotId:queue.activeSnapshotId,purchaseDatasetId:queue.activePurchaseLayerDatasetId,itemGuid,itemCode,saleLineCount:population.length,saleCount:economic.invoiceCount,saleQuantity:unresolvedQuantityExact,saleValue:economic.saleValueExposureExact,firstSaleDate:effectiveFrom,lastSaleDate:effectiveTo,sourceClass:suggestion.sourceClass,sourceFingerprint:clean(suggestion.sourceFingerprint,64),scope};
  const reviewFingerprint=crypto.createHash('sha256').update(stable(reviewContract)).digest('hex');
  return {ok:true,readOnly:true,mode:'NEW_EXPOSURE',actionAllowed:blockers.length===0,item:{itemGuid,itemCode,itemDescription:row?.itemDescription||economic.itemDescription},exposure:{requiredQuantityExact,coveredQuantityExact:economic.coveredQuantityExact,openingCoveredQuantityExact,purchaseCoveredQuantityExact:economic.purchaseCoveredQuantityExact,unresolvedQuantityExact,affectedInvoiceCount:economic.invoiceCount,affectedLineCount:population.length,saleValueExposure:Number(economic.saleValueExposureExact||0),effectiveFrom,effectiveTo},proposal:{available:Boolean(suggestion.available&&suggestion.suggestedCostExact)&&positiveQuantity(unresolvedQuantityExact),sourceClass:suggestion.sourceClass,sourceLabel:managementSourceLabel(suggestion.sourceClass),suggestedCostExact:clean(suggestion.suggestedCostExact,100)||null},scope,reviewFingerprint,supersedesResolutionId:'',technicalDetails:{activeFifoDatasetId:economic.datasetId,saleSnapshotId:queue.activeSnapshotId,purchaseDatasetId:queue.activePurchaseLayerDatasetId,openingDatasetId:clean(suggestion.openingEvidenceDatasetId,100),openingEvidenceId:clean(suggestion.evidenceId,100),sourceFingerprint:clean(suggestion.sourceFingerprint,64),affectedSaleLinePopulation:population,affectedSaleLinePopulationFingerprint:economic.affectedSaleLinePopulationFingerprint,coveredLines:economic.coveredLines,reviewLineage:suggestion.reviewLineage||null,eligibilityPreview:suggestion.eligibilityPreview||null},blockers:[...new Set(blockers)]};
}

async function managementApprove(db,input={},requestedBy={}) {
  assertRole(requestedBy?.role,MANAGEMENT_ROLES);
  const review=await managementReview(db,{itemGuid:input.itemGuid,itemCode:input.itemCode,supersedesResolutionId:input.supersedesResolutionId},requestedBy);
  if(clean(input.reviewFingerprint,64)!==review.reviewFingerprint)fail('MANUAL_COST_MANAGEMENT_REVIEW_STALE','پیش‌نمایش تصمیم تغییر کرده است؛ دوباره Review کنید.',409);
  if(!review.actionAllowed)fail('MANUAL_COST_MANAGEMENT_BLOCKED','این Exposure به‌دلیل تقدم یا تعارض مأخذ قابل ثبت نیست.',409);
  const finalCostExact=exactUnitCost(input.finalCost);if(!finalCostExact)fail('MANUAL_COST_INVALID_AMOUNT','مبلغ نهایی مورد تأیید باید معتبر و بزرگ‌تر از صفر باشد.');
  if(review.mode==='SUPERSEDE_APPROVED'&&finalCostExact===review.proposal.currentApprovedCostExact)fail('MANUAL_COST_AMOUNT_UNCHANGED','مبلغ اصلاحی با مبلغ مصوب فعلی برابر است.',409);
  const reason=review.mode==='SUPERSEDE_APPROVED'?`اصلاح مبلغ مصوب ${review.supersedesResolutionId}: ${review.proposal.currentApprovedCostExact} → ${finalCostExact}`:`تصمیم مدیریت برای ${review.exposure.unresolvedQuantityExact} واحد exposure فاقد هزینه؛ مبنا: ${review.proposal.sourceLabel}`;
  const decisionClass=managementDecisionClass(review);
  const commercialReference=`MANAGEMENT_REVIEW:${review.reviewFingerprint}`;
  let resolution=await db.collection(COLLECTION).findOne({commercialReference});
  if(resolution&&clean(resolution.manualCostExact||resolution.manualCost,100)!==finalCostExact)fail('MANUAL_COST_MANAGEMENT_RETRY_AMOUNT_MISMATCH','برای این Review قبلاً مبلغ دیگری ثبت شده است؛ وضعیت را بازخوانی کنید.',409);
  if(!resolution){
    const created=await createDraft(db,{itemGuid:review.scope.itemGuid,itemCode:review.scope.itemCode,manualCost:finalCostExact,resolutionScope:review.scope.resolutionScope,targetQuantityExact:review.scope.targetQuantityExact,effectiveFrom:review.scope.effectiveFrom,effectiveTo:review.scope.effectiveTo,sourceType:COMMERCIAL_SOURCE,commercialReference,currency:'IRR',reason,notes:'Created by management Review → Set Cost → Approve workflow.',supersedesResolutionId:review.supersedesResolutionId,affectedQuantityExact:review.exposure.unresolvedQuantityExact,affectedLineCount:review.exposure.affectedLineCount,saleValueExposure:review.exposure.saleValueExposure,purchaseDatasetId:review.scope.purchaseDatasetId,scopeDerivationFingerprint:review.scope.scopeDerivationFingerprint,openingDatasetId:review.scope.openingDatasetId,openingEvidenceId:review.scope.openingEvidenceId,openingCoveredQuantityExact:review.scope.openingCoveredQuantityExact,managementDecisionClass:decisionClass,affectedSaleLinePopulation:review.scope.affectedSaleLinePopulation,affectedSaleLinePopulationFingerprint:review.scope.affectedSaleLinePopulationFingerprint,activeFifoDatasetId:review.scope.activeFifoDatasetId},requestedBy);
    resolution=created.resolution;
  }
  if(resolution.status==='draft')resolution=(await transition(db,resolution.resolutionId,'submit',requestedBy,{revision:resolution.revision,reason})).resolution;
  if(resolution.status==='pending'){
    const preview=await impactPreview(db,resolution.resolutionId,requestedBy);
    resolution=(await transition(db,resolution.resolutionId,'approve',requestedBy,{revision:resolution.revision,reason,previewFingerprint:preview.previewFingerprint})).resolution;
  }
  if(resolution.status!=='approved')fail('MANUAL_COST_MANAGEMENT_INCOMPLETE','فرآیند governed به Approval نرسید؛ رکورد ایمن و غیرفعال برای بررسی حفظ شد.',409);
  return {ok:true,message:'هزینه ثبت و تایید شد.',resolutionId:resolution.resolutionId,approvedAmountExact:resolution.manualCostExact,quantityCoveredExact:resolution.targetQuantityExact,evidenceType:managementSourceLabel(resolution.managementDecisionClass||resolution.evidenceClass),affectedExposure:{lineCount:Number(resolution.affectedLineCount||0),saleValue:Number(resolution.saleValueExposure||0),effectiveFrom:resolution.effectiveFrom,effectiveTo:resolution.effectiveTo},actor:resolution.approvedBy,timestamp:resolution.approvedAt,fifoImpactState:'منتظر به‌روزرسانی FIFO',activeFifoMutated:false,supersedesResolutionId:resolution.supersedesResolutionId||''};
}

async function managementArchive(db,filters={},requestedBy={}) {
  assertRole(requestedBy?.role,['admin','accounting','purchase','manager']);
  let rows=await allRows(db.collection(COLLECTION),{});
  const search=key(filters.search),status=clean(filters.status,50);
  if(status)rows=rows.filter(row=>row.status===status);
  if(search)rows=rows.filter(row=>[row.resolutionId,row.itemCode,row.itemGuid,row.reason,row.createdBy?.username].some(value=>key(value).includes(search)));
  rows.sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));
  const report={ok:true,total:rows.length,list:rows},state=await db.collection('fifoDatasetState').findOne({scopeKey:'fifo-shadow-v2-precision-evidence'}),datasetId=clean(state?.activeDatasetId,100);
  const dataset=datasetId?await db.collection('fifoDatasets').findOne({datasetId}):null;
  const ids=report.list.map(row=>row.resolutionId),allocations=datasetId&&ids.length?await db.collection('fifoAllocations').find({datasetId,manualResolutionId:{$in:ids}}).toArray():[];
  const applied=new Set(allocations.map(row=>clean(row.manualResolutionId,100))),supersededBy=new Map();
  for(const row of report.list)if(row.supersedesResolutionId)supersededBy.set(clean(row.supersedesResolutionId,100),row.resolutionId);
  return {...report,readOnly:true,activeFifoDatasetId:datasetId,lastFifoUpdate:dataset?.activatedAt||dataset?.completedAt||dataset?.createdAt||null,calculationCutoff:clean(dataset?.calculationCutoff,8),list:report.list.map(row=>({...row,currentAmountExact:clean(row.manualCostExact||row.manualCost,100),sourceLabel:managementSourceLabel(row.managementDecisionClass||(row.evidenceClass==='COMMERCIAL_ANNOUNCED_COST'?'COMMERCIAL_ANNOUNCED_COST':row.sourceClass||row.sourceType)),coveredQuantityExact:clean(row.targetQuantityExact||row.affectedQuantityExact,100),lastCorrectionId:supersededBy.get(row.resolutionId)||'',fifoImpactState:row.status==='expired'?'منقضی‌شده — فاقد ظرفیت FIFO':row.status!=='approved'?'در انتظار تکمیل حاکمیت':supersededBy.has(row.resolutionId)?'جایگزین‌شده':applied.has(row.resolutionId)?'اعمال‌شده در FIFO':'منتظر به‌روزرسانی FIFO',appliedInActiveFifo:applied.has(row.resolutionId)}))};
}
async function assistedDecision(db,input={},requestedBy={}) {
  assertRole(requestedBy?.role,ASSISTED_FINALIZE_ROLES);
  const suggestion=await assistedSuggestion(db,input,requestedBy);
  if(suggestion.reviewOnly===true||suggestion.financialAuthority===false)fail('OPENING_EVIDENCE_NOT_APPROVED','شواهد Opening فقط برای بازبینی معتبر است و تا تأیید مستقل، مجاز به ایجاد هزینه یا ورود به FIFO نیست.',409);
  const decision=clean(input.decision,50).toUpperCase();
  if(['DEFERRED','REJECTED'].includes(decision)) {
    const reason=clean(input.reason,1000);if(!reason)fail('MANUAL_COST_DECISION_REASON_REQUIRED','دلیل تصمیم الزامی است.');
    const now=new Date(),record={resolutionId:newResolutionId(),schemaVersion:SCHEMA_VERSION,workflowType:ASSISTED_WORKFLOW,assistedStatus:decision,status:decision==='DEFERRED'?'draft':'rejected',itemGuid:suggestion.target.itemGuid,itemCode:suggestion.target.itemCode,suggestion,reason,revision:1,contentHash:crypto.createHash('sha256').update(stable({decision,target:suggestion.target,suggestionFingerprint:suggestion.sourceFingerprint,reason})).digest('hex'),createdBy:actor(requestedBy),auditLog:[auditEntry('assisted-decision',requestedBy,{reason,fromStatus:'ACCOUNTING_REVIEW',toStatus:decision})],createdAt:now,updatedAt:now,deleted:false};
    await db.collection(COLLECTION).insertOne(record);invalidateReadinessCache(db);return {ok:true,resolution:record,fifoStale:false};
  }
  if(decision!=='APPROVE_SUGGESTED'&&decision!=='APPROVE_OVERRIDE')fail('MANUAL_COST_DECISION_INVALID','تصمیم حسابداری معتبر نیست.');
  if(suggestion.sourceClass==='EXACT_OFFICIAL_PURCHASE_LAYER')fail('MANUAL_COST_NOT_REQUIRED','لایه خرید رسمی معتبر وجود دارد؛ مسیر اصلاح Dataset را استفاده کنید.',409);
  if(suggestion.sourceClass==='OPENING_ACCOUNTING_COST'&&suggestion.openingEvidenceDatasetId&&suggestion.approvalStatus==='approved')fail('MANUAL_COST_NOT_REQUIRED','Opening Accounting Cost مصوب، authority مستقل FIFO آینده است و نباید به Manual Cost تبدیل شود.',409);
  if(suggestion.sourceClass==='SOURCE_HISTORY_INCOMPLETE')fail('MANUAL_COST_SOURCE_HISTORY_INCOMPLETE','تا پیش از تکمیل Recovery تاریخچه رسمی، ثبت هزینه دستی مجاز نیست.',409);
  if(suggestion.sourceClass==='PENDING_PURCHASE_PRICE')fail('MANUAL_COST_PENDING_PURCHASE_PRICE','قیمت خرید هنوز موقت است و نمی‌تواند مأخذ هزینه باشد.',409);
  if(suggestion.sourceClass==='PURCHASE_RETURN_CONFLICT')fail('MANUAL_COST_PURCHASE_RETURN_CONFLICT','برگشت خرید حل‌نشده باید ابتدا در Purchase Engine رسمی تعیین تکلیف شود.',409);
  if(suggestion.sourceClass==='CONFLICT_REQUIRES_REVIEW')fail('MANUAL_COST_SOURCE_CONFLICT','مأخذهای هزینه با یکدیگر تعارض دارند و نیازمند بررسی انسانی‌اند.',409);
  const finalInput=decision==='APPROVE_SUGGESTED'?suggestion.suggestedCostExact:input.finalCost;
  if(decision==='APPROVE_SUGGESTED'&&!suggestion.available)fail('MANUAL_COST_SUGGESTION_UNAVAILABLE','قیمت پیشنهادی معتبر وجود ندارد.',409);
  const finalCostExact=exactUnitCost(finalInput);if(!finalCostExact)fail('MANUAL_COST_INVALID_AMOUNT','هزینه نهایی معتبر نیست.');
  const reason=clean(input.reason,1000);
  if((decision==='APPROVE_OVERRIDE'||!suggestion.available)&&!reason)fail('MANUAL_COST_DECISION_REASON_REQUIRED','برای مبلغ متفاوت یا ورود دستی، دلیل الزامی است.');
  fail('MANUAL_COST_ASSISTED_APPROVAL_RETIRED','تصمیم جدید هزینه باید به‌صورت Draft قیمت اعلام بازرگانی، Impact Preview و Approval مستقل ثبت شود.',409);
}
function assessSaleRow(row, context) {
  const officialRows = indexedRows(context, 'official', row, true).filter(layer => matchesOfficial(layer, row));
  const manualRows = indexedRows(context, 'manual', row, true).filter(resolution => validAt(resolution, row.saleDate) && matchesManual(resolution, row));
  const returnRows = [...new Set([
    ...(context.returnsByCode.get(key(row.itemCode)) || []),
    ...(key(row.itemGuid) ? context.returnsByGuid.get(key(row.itemGuid)) || [] : [])
  ])];
  const source = officialRows.length ? 'official' : (manualRows.length ? 'manual' : 'unknown');
  const catalog=context.catalogByGuid.get(key(row.itemGuid))||context.catalogByCode.get(key(row.itemCode));
  const reason = source === 'unknown' ? (catalog?.historyCompleteness==='complete'?classifyMissing(row, context):'source_history_incomplete') : '';
  return {
    source,
    officialLayerCount:officialRows.length,
    manualResolutionId:source === 'manual' ? manualRows[0].resolutionId : '',
    manualCost:source === 'manual' ? manualRows[0].manualCost : null,
    ready:source !== 'unknown',
    missingReason:reason,
    unknownCostReason:reason,
    returnLinkStatus:returnRows.length
      ? clean(returnRows[0]?.returnMatchStatus || 'represented')
      : 'none'
  };
}
function applyQueueFilters(rows, filters) {
  const search = key(filters.search);
  return rows.filter(row => {
    if (filters.coverage && filters.coverage !== 'all' && row.coverage !== clean(filters.coverage)) return false;
    if (filters.store && !key(row.stores.join(' ')).includes(key(filters.store))) return false;
    if (filters.category && !key(row.category).includes(key(filters.category))) return false;
    if (filters.brand && !key(row.brand).includes(key(filters.brand))) return false;
    if (filters.supplier && !key(row.suppliers.join(' ')).includes(key(filters.supplier))) return false;
    if (search && !key(`${row.itemCode} ${row.itemDescription} ${row.itemGuid}`).includes(search)) return false;
    return true;
  });
}
function queueSort(rows, sort, direction) {
  const allowed = ['itemCode', 'saleAmount', 'saleCount', 'saleQuantity', 'firstSaleDate', 'lastSaleDate', 'currentInventory'];
  const field = allowed.includes(sort) ? sort : 'saleAmount';
  const sign = clean(direction).toLowerCase() === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[field] ?? '', bv = b[field] ?? '';
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return String(a.itemCode).localeCompare(String(b.itemCode), 'en');
  });
}
async function missingQueue(db, filters = {}) {
  const dates = normalizeJalaliRange({ dateFrom:filters.dateFrom || '', dateTo:filters.dateTo || '' });
  const [context,openingDataset] = await Promise.all([loadReadinessContext(db),latestOpeningReviewDataset(db)]);
  const inventoryRows = await allRows(db.collection('itemInventoryCatalog'), {});
  const inventory = new Map();
  for (const row of inventoryRows) {
    const code = key(row.itemCode);
    inventory.set(code, (inventory.get(code) || 0) + Math.max(0, Number(row.quantity || 0)));
  }
  const grouped = new Map();
  for (const sale of context.saleRows) {
    if (dates.dateFrom && sale.saleDate < dates.dateFrom) continue;
    if (dates.dateTo && sale.saleDate > dates.dateTo) continue;
    const identity = key(sale.itemGuid) || `code:${key(sale.itemCode)}`;
    if (!identity) continue;
    const assessment = assessSaleRow(sale, context);
    const group = grouped.get(identity) || {
      itemGuid:clean(sale.itemGuid),
      itemCode:clean(sale.itemCode),
      itemDescription:clean(sale.itemName),
      currentInventory:inventory.get(key(sale.itemCode)) || 0,
      saleInvoiceIds:new Set(),
      saleCount:0,
      saleLineCount:0,
      saleQuantity:0,
      saleAmount:0,
      firstSaleDate:'',
      lastSaleDate:'',
      coverage:assessment.source,
      reason:assessment.missingReason,
      purchaseLayerStatus:assessment.source === 'official' ? 'official-layer-available' : 'no-valid-official-layer',
      manualResolutionId:assessment.manualResolutionId,
      stores:new Set(),
      categories:new Set(),
      brands:new Set(),
      suppliers:new Set(),
      sellers:new Set()
    };
    group.saleInvoiceIds.add(`${sale.saleInvoiceType}-${sale.saleInvoiceNo}`);
    group.saleLineCount++;
    group.saleQuantity += Number(sale.qty || 0);
    group.saleAmount += Number(sale.saleValue || 0);
    group.firstSaleDate = !group.firstSaleDate || sale.saleDate < group.firstSaleDate ? sale.saleDate : group.firstSaleDate;
    group.lastSaleDate = !group.lastSaleDate || sale.saleDate > group.lastSaleDate ? sale.saleDate : group.lastSaleDate;
    group.stores.add(clean(sale.sellerStoreName));
    group.categories.add(clean(sale.mainGroup));
    group.brands.add(brandOf(sale));
    group.sellers.add(clean(`${sale.sellerAccountNumber||''} ${sale.sellerName||''}`));
    grouped.set(identity, group);
  }
  let rows = [...grouped.values()].map(group => {
    const matchingLayers = [...new Set([
      ...(context.allLayersByCode.get(key(group.itemCode)) || []),
      ...(key(group.itemGuid) ? context.allLayersByGuid.get(key(group.itemGuid)) || [] : [])
    ])];
    for (const layer of matchingLayers) {
      if (layer.supplierAccountNumber || layer.supplierName) group.suppliers.add(clean(`${layer.supplierAccountNumber || ''} ${layer.supplierName || ''}`));
    }
    return {
      ...group,
      saleCount:group.saleInvoiceIds.size,
      saleInvoiceIds:undefined,
      stores:[...group.stores].filter(Boolean),
      category:[...group.categories].filter(Boolean).join('، '),
      brand:[...group.brands].filter(Boolean).join('، '),
      suppliers:[...group.suppliers].filter(Boolean),
      affectedSellers:[...group.sellers].filter(Boolean),
      suggestedResolution:SUGGESTIONS[group.reason] || '',
      profitCalculated:false,
      fifoAllocationCreated:false
    };
  });
  rows = applyQueueFilters(rows, filters);
  queueSort(rows, filters.sort, filters.direction);
  const total = rows.length;
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), filters.export === true ? 5000 : 500));
  return {
    ok:true,
    source:'active-sale-snapshot-plus-active-purchase-layer-dataset-plus-approved-manual-cost',
    activeSnapshotId:context.saleActive.snapshotId || '',
    activePurchaseLayerDatasetId:context.purchaseActive?.datasetId || '',
    openingDatasetId:clean(openingDataset?.datasetId,100),
    openingApprovalStatus:clean(openingDataset?.approvalStatus,50),
    total,
    page,
    pageSize,
    list:rows.slice((page - 1) * pageSize, page * pageSize),
    classifications:Object.fromEntries([...new Set(rows.map(row => row.reason).filter(Boolean))].map(reason => [reason, rows.filter(row => row.reason === reason).length])),
    profitActivationAllowed:false,
    fifoCalculationActivated:false
  };
}
async function cleanCaseCandidates(db, filters = {}) {
  const queue=await missingQueue(db,{...filters,coverage:'unknown',page:1,pageSize:5000,export:true});
  const [manualRows,openingRows,basisRows]=await Promise.all([
    allRows(db.collection(COLLECTION),{}),
    allRows(db.collection('openingInventoryEvidence'),{}),
    allRows(db.collection(openingCostBasis.COLLECTION),{status:{$in:['available','VALIDATED_CANDIDATE']},extractionComplete:true})
  ]);
  const contaminated=rows=>new Set(rows.flatMap(row=>[key(row.itemGuid),key(row.itemCode)].filter(Boolean)));
  const manualKeys=contaminated(manualRows),openingKeys=contaminated(openingRows);
  const basisByIdentity=new Map();
  for(const row of basisRows)for(const identity of [key(row.itemGuid),key(row.itemCode)].filter(Boolean))basisByIdentity.set(identity,row);
  const list=queue.list.filter(row=>{
    const identities=[key(row.itemGuid),key(row.itemCode)].filter(Boolean);
    return !identities.some(identity=>manualKeys.has(identity)||openingKeys.has(identity));
  }).map(row=>{
    const basis=[key(row.itemGuid),key(row.itemCode)].map(identity=>basisByIdentity.get(identity)).find(Boolean);
    return {...row,cleanCase:true,priorManualCost:false,openingInventoryEvidence:false,sourceClass:basis?'OPENING_ACCOUNTING_COST':(row.reason==='source_history_incomplete'?'SOURCE_HISTORY_INCOMPLETE':'NO_VALID_COST_BASIS'),sourceFingerprint:clean(basis?.sourceFingerprint,64),evidenceQuantityCapacityExact:clean(basis?.openingQuantityExact,100),suggestedUnitCostExact:clean(basis?.openingUnitCostExact,100),evidenceDate:clean(basis?.effectiveOpeningDate,8)};
  });
  return {ok:true,readOnly:true,total:list.length,list,excluded:{manualCostIdentities:manualKeys.size,openingEvidenceIdentities:openingKeys.size},activeSnapshotId:queue.activeSnapshotId,activePurchaseLayerDatasetId:queue.activePurchaseLayerDatasetId};
}
async function sourceReclassificationReport(db, filters = {}) {
  const queue=await missingQueue(db,{...filters,coverage:'unknown',page:1,pageSize:5000,export:true});
  const [basisRows,catalogRows]=await Promise.all([allRows(db.collection(openingCostBasis.COLLECTION),{status:{$in:['available','VALIDATED_CANDIDATE']},extractionComplete:true}),allRows(db.collection(canonicalItemCatalog.CATALOG),{})]);
  const byIdentity=new Map();for(const row of basisRows)for(const identity of [key(row.itemGuid),key(row.itemCode)].filter(Boolean))byIdentity.set(identity,row);
  const catalogByIdentity=new Map();for(const row of catalogRows)for(const identity of [key(row.itemGuid),key(row.itemCode)].filter(Boolean))catalogByIdentity.set(identity,row);
  const buckets={SOURCE_HISTORY_INCOMPLETE:[],OPENING_ACCOUNTING_COST:[],TRUE_NO_VALID_COST_BASIS:[],OTHER_UNRESOLVED:[]};
  for(const row of queue.list){
    const identities=[key(row.itemGuid),key(row.itemCode)].filter(Boolean),basis=identities.map(id=>byIdentity.get(id)).find(Boolean),catalog=identities.map(id=>catalogByIdentity.get(id)).find(Boolean);
    const bucket=basis?'OPENING_ACCOUNTING_COST':(catalog?.historyCompleteness!=='complete'?'SOURCE_HISTORY_INCOMPLETE':(row.reason==='no_purchase_found'?'TRUE_NO_VALID_COST_BASIS':'OTHER_UNRESOLVED'));
    buckets[bucket].push({...row,sourceClass:bucket,openingEvidenceId:basis?.evidenceId||'',historyCompleteness:catalog?.historyCompleteness||'missing'});
  }
  const summary=Object.fromEntries(Object.entries(buckets).map(([name,rows])=>[name,{items:rows.length,saleLines:rows.reduce((sum,row)=>sum+Number(row.saleLineCount||0),0),quantity:rows.reduce((sum,row)=>sum+Number(row.saleQuantity||0),0),saleValue:rows.reduce((sum,row)=>sum+Number(row.saleAmount||0),0)}]));
  return {ok:true,readOnly:true,activeSnapshotId:queue.activeSnapshotId,activePurchaseLayerDatasetId:queue.activePurchaseLayerDatasetId,totalUnknownItems:queue.total,summary,list:Object.values(buckets).flat(),historicalFinancialFactsMutated:false};
}
async function readiness(db, filters = {}) {
  const dates = normalizeJalaliRange({ dateFrom:filters.dateFrom || '', dateTo:filters.dateTo || '' });
  const context = await loadReadinessContext(db);
  const rows = context.saleRows
    .filter(row => (!dates.dateFrom || row.saleDate >= dates.dateFrom) && (!dates.dateTo || row.saleDate <= dates.dateTo))
    .map(row => ({ saleLineId:row.saleLineId, saleInvoiceNo:row.saleInvoiceNo, saleDate:row.saleDate, itemGuid:row.itemGuid, itemCode:row.itemCode, itemDescription:row.itemName, qty:row.qty, saleValue:row.saleValue, ...assessSaleRow(row, context), profitCalculated:false, fifoAllocationCreated:false }));
  const grouped = new Map();
  for (const row of rows) {
    const id = key(row.itemGuid) || `code:${key(row.itemCode)}`;
    const current = grouped.get(id) || { itemGuid:row.itemGuid, itemCode:row.itemCode, itemDescription:row.itemDescription, saleLines:0, saleQuantity:0, saleValue:0, coveredQuantity:0, coveredSaleValue:0, officialLines:0, manualLines:0, unknownLines:0, reasons:new Set(), resolutionIds:new Set(), returnLinkStatuses:new Set() };
    current.saleLines++;
    current.saleQuantity += Number(row.qty || 0);
    current.saleValue += Number(row.saleValue || 0);
    if (row.ready) {
      current.coveredQuantity += Number(row.qty || 0);
      current.coveredSaleValue += Number(row.saleValue || 0);
    }
    current[`${row.source}Lines`]++;
    if (row.missingReason) current.reasons.add(row.missingReason);
    if (row.manualResolutionId) current.resolutionIds.add(row.manualResolutionId);
    current.returnLinkStatuses.add(row.returnLinkStatus);
    grouped.set(id, current);
  }
  const list = [...grouped.values()].map(row => ({
    ...row,
    ready:row.unknownLines === 0,
    coverage:row.officialLines ? (row.manualLines || row.unknownLines ? 'mixed' : 'official') : (row.manualLines ? (row.unknownLines ? 'mixed' : 'manual') : 'unknown'),
    lineCoveragePercent:percentage(row.officialLines + row.manualLines, row.saleLines),
    quantityCoveragePercent:percentage(row.coveredQuantity, row.saleQuantity),
    saleValueCoveragePercent:percentage(row.coveredSaleValue, row.saleValue),
    missingReasons:[...row.reasons],
    manualResolutionIds:[...row.resolutionIds],
    returnLinkStatuses:[...row.returnLinkStatuses],
    reasons:undefined,
    resolutionIds:undefined,
    profitCalculated:false,
    fifoAllocationCreated:false
  }));
  return { ok:true, activeSnapshotId:context.saleActive.snapshotId || '', activePurchaseLayerDatasetId:context.purchaseActive?.datasetId || '', total:list.length, list, profitActivationAllowed:false, fifoCalculationActivated:false };
}
function percentage(part, total) { return total ? Math.round(part * 10000 / total) / 100 : 0; }
function coverageFromContext(context, dates) {
  const rows = context.saleRows.filter(row => (!dates.dateFrom || row.saleDate >= dates.dateFrom) && (!dates.dateTo || row.saleDate <= dates.dateTo));
  const totals = { items:new Set(), quantity:0, saleValue:0 };
  const official = { items:new Set(), quantity:0, saleValue:0 };
  const manual = { items:new Set(), quantity:0, saleValue:0 };
  const unknown = { items:new Set(), quantity:0, saleValue:0 };
  for (const row of rows) {
    const identity = key(row.itemGuid) || `code:${key(row.itemCode)}`;
    const assessment = assessSaleRow(row, context);
    totals.items.add(identity);
    totals.quantity += Number(row.qty || 0);
    totals.saleValue += Number(row.saleValue || 0);
    const bucket = assessment.source === 'official' ? official : (assessment.source === 'manual' ? manual : unknown);
    bucket.items.add(identity);
    bucket.quantity += Number(row.qty || 0);
    bucket.saleValue += Number(row.saleValue || 0);
  }
  function summary(bucket) {
    return {
      itemCount:bucket.items.size,
      itemCoveragePercent:percentage(bucket.items.size, totals.items.size),
      saleQuantity:bucket.quantity,
      quantityCoveragePercent:percentage(bucket.quantity, totals.quantity),
      saleValue:Math.round(bucket.saleValue),
      saleValueCoveragePercent:percentage(bucket.saleValue, totals.saleValue)
    };
  }
  const officialSummary = summary(official);
  const manualSummary = summary(manual);
  const unknownSummary = summary(unknown);
  const afterManualItems = new Set([...official.items, ...manual.items]);
  return {
    ok:true,
    period:dates,
    activeSnapshotId:context.saleActive.snapshotId || '',
    activePurchaseLayerDatasetId:context.purchaseActive?.datasetId || '',
    totals:{ itemCount:totals.items.size, saleQuantity:totals.quantity, saleValue:Math.round(totals.saleValue) },
    beforeManual:{ ...officialSummary, source:'official-only' },
    afterManual:{
      itemCount:afterManualItems.size,
      itemCoveragePercent:percentage(afterManualItems.size, totals.items.size),
      saleQuantity:official.quantity + manual.quantity,
      quantityCoveragePercent:percentage(official.quantity + manual.quantity, totals.quantity),
      saleValue:Math.round(official.saleValue + manual.saleValue),
      saleValueCoveragePercent:percentage(official.saleValue + manual.saleValue, totals.saleValue),
      source:'official-plus-approved-effective-manual'
    },
    official:officialSummary,
    manual:manualSummary,
    unknown:unknownSummary,
    safety:{ officialPriority:true, unknownIsZero:false, manualIsOfficial:false, profitCalculated:false, fifoAllocationCreated:false }
  };
}
async function coverage(db, filters = {}) {
  const dates = normalizeJalaliRange({ dateFrom:filters.dateFrom || '', dateTo:filters.dateTo || '' });
  const context = await loadReadinessContext(db);
  return coverageFromContext(context, dates);
}
async function dataHealth(db, build = {}) {
  const context = await loadReadinessContext(db);
  const cov = coverageFromContext(context, { dateFrom:'', dateTo:'' });
  const jobs = await allRows(db.collection('appJobs'), {});
  const resolutions = await allRows(db.collection(COLLECTION), {});
  const latestBackup = await db.collection('appLogs').findOne({ type:'mongo_backup' }, { sort:{ at:-1 } }).catch(() => null);
  const purchaseLayers = context.allLayers;
  const gitMetadata=localGitMetadata();
  const saleHeaderCount = context.saleActive.headerCollection
    ? await count(db.collection(context.saleActive.headerCollection), context.saleActive.headerQuery)
    : 0;
  const duplicateLayerKeys = new Set();
  const seenLayers = new Set();
  for (const row of purchaseLayers) {
    const identity = row.purchaseLineIdentity || `${row.purchaseInvoiceNo}:${row.sourceRow}:${row.itemCode}`;
    if (seenLayers.has(identity)) duplicateLayerKeys.add(identity);
    seenLayers.add(identity);
  }
  return {
    ok:true,
    version:APP_VERSION,
    gitSha:clean(build.gitSha || process.env.GIT_COMMIT || process.env.COMMIT_SHA || gitMetadata.gitSha, 128),
    buildTime:clean(build.buildTime || process.env.BUILD_TIME || gitMetadata.buildTime, 128),
    generatedAt:new Date(),
    health:'healthy-read-model',
    activeDataset:{
      saleSnapshotId:context.saleActive.snapshotId || '',
      saleSnapshotStatus:context.saleActive.status || '',
      purchaseLayerDatasetId:context.purchaseActive?.datasetId || '',
      purchaseLayerStatus:context.purchaseActive?.dataset?.status || 'missing'
    },
    saleSnapshot:{ headers:saleHeaderCount, lines:context.saleRows.length },
    purchaseLayer:{ rows:purchaseLayers.length, officialRows:context.official.length, returnRows:context.returns.length, warnings:purchaseLayers.filter(row => row.validationStatus === 'warning').length, rejected:purchaseLayers.filter(row => row.validationStatus === 'rejected').length, duplicateRows:duplicateLayerKeys.size },
    manualCost:{ total:resolutions.length, byStatus:Object.fromEntries(STATUSES.map(status => [status, resolutions.filter(row => row.status === status).length])) },
    coverage:cov,
    missingQueue:{ itemCount:cov.unknown.itemCount, saleValue:cov.unknown.saleValue },
    retry:{ jobsWithRetry:jobs.filter(job => Number(job.result?.retryCount || job.retryCount || 0) > 0).length },
    resume:{ jobsWithResume:jobs.filter(job => Number(job.result?.resumeCount || job.resumeCount || 0) > 0).length },
    failedJobs:jobs.filter(job => job.status === 'failed').length,
    runningJobs:jobs.filter(job => ['queued', 'running'].includes(job.status)).length,
    returns:{ total:context.returns.length, unresolved:context.returns.filter(row => row.returnMatchStatus !== 'matched').length },
    latestBackup:latestBackup ? { at:latestBackup.at, status:latestBackup.status, database:latestBackup.database, sizeBytes:latestBackup.sizeBytes } : null,
    profitActivationAllowed:false,
    fifoCalculationActivated:false
  };
}

module.exports = {
  COLLECTION,
  SCHEMA_VERSION,
  SOURCE_TYPES,
  STATUSES,
  RESOLUTION_SCOPES,
  COMMERCIAL_SOURCE,
  COMMERCIAL_SCOPE,
  LEGACY_UNBOUNDED_CLASS,
  MANAGEMENT_ROLES,
  EDIT_ROLES,
  APPROVE_ROLES,
  ensureIndexes,
  createDraft,
  updateDraft,
  transition,
  list,
  legacyItemScopeAudit,
  getById,
  missingQueue,
  cleanCaseCandidates,
  sourceReclassificationReport,
  readiness,
  coverage,
  dataHealth,
  assistedSuggestion,
  assistedDecision,
  managementReview,
  managementApprove,
  managementArchive,
  approvedSetFingerprint,
  impactPreview,
  _validAt:validAt,
  _assessSaleRow:assessSaleRow,
  _validateDraft:validateDraft,
  _sameIdentity:sameIdentity,
  _sameResolutionTarget:sameResolutionTarget,
  _overlaps:overlaps,
  _effectiveRowsAt:effectiveRowsAt,
  _validateSupersession:validateSupersession,
  _approvedOpeningCollision:approvedOpeningCollision,
  _assertStableItemIdentity:assertStableItemIdentity,
  _contentHash:contentHash,
  _exactUnitCost:exactUnitCost,
  _approvedRowsFingerprint:approvedRowsFingerprint,
  _suggestionFromLayers:suggestionFromLayers
};
