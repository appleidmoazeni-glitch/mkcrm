'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const saleSnapshot = require('./sale-snapshot');
const { APP_VERSION } = require('./app-version');
const { canonicalSaleDate, normalizeJalaliRange } = require('./jalali-date');

const COLLECTION = 'manualCostResolutions';
const SCHEMA_VERSION = 1;
const SOURCE_TYPES = Object.freeze([
  'manual',
  'opening_inventory',
  'historical_purchase',
  'accounting_adjustment',
  'legacy_cost'
]);
const STATUSES = Object.freeze(['draft', 'pending', 'approved', 'rejected', 'expired']);
const EDIT_ROLES = Object.freeze(['admin', 'accounting']);
const APPROVE_ROLES = Object.freeze(['admin', 'manager']);
let cachedGitMetadata;

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function key(value) { return clean(value, 250).toLocaleLowerCase('en-US'); }
function finite(value) {
  if (value == null || clean(value) === '') return null;
  const number = Number(String(value).replace(/[,،\s]/g, ''));
  return Number.isFinite(number) && Number.isSafeInteger(Math.trunc(number)) ? number : null;
}
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
  const fields = ['itemGuid','itemCode','manualCost','effectiveFrom','effectiveTo','currency','reason','sourceType','attachment','notes','status'];
  const output = {};
  for (const field of fields) {
    if (value[field] === undefined) continue;
    if (field === 'attachment') output[field] = sanitizeAttachment(value[field]);
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
function validateDraft(input = {}) {
  const itemGuid = clean(input.itemGuid, 100);
  const itemCode = clean(input.itemCode, 100);
  if (!itemGuid && !itemCode) fail('MANUAL_COST_ITEM_REQUIRED', 'حداقل یکی از ItemGuid یا ItemCode الزامی است.');
  const manualCost = finite(input.manualCost);
  if (manualCost == null || manualCost <= 0) fail('MANUAL_COST_INVALID_AMOUNT', 'هزینه دستی باید عدد محدود، امن و بزرگ‌تر از صفر باشد.');
  const sourceType = clean(input.sourceType || 'manual');
  if (!SOURCE_TYPES.includes(sourceType)) fail('MANUAL_COST_INVALID_SOURCE', 'نوع منبع هزینه دستی معتبر نیست.');
  const effectiveFrom = date8(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = date8(input.effectiveTo, 'effectiveTo', true);
  if (effectiveTo && effectiveTo < effectiveFrom) fail('MANUAL_COST_INVALID_RANGE', 'effectiveTo نمی‌تواند قبل از effectiveFrom باشد.');
  const currency = clean(input.currency || 'IRR', 12).toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) fail('MANUAL_COST_INVALID_CURRENCY', 'واحد پول معتبر نیست.');
  return {
    itemGuid,
    itemCode,
    manualCost,
    effectiveFrom,
    effectiveTo,
    currency,
    reason:clean(input.reason, 1000),
    sourceType,
    attachment:sanitizeAttachment(input.attachment),
    notes:clean(input.notes, 2000)
  };
}
function overlaps(aFrom, aTo, bFrom, bTo) {
  const endA = aTo || '99999999';
  const endB = bTo || '99999999';
  return aFrom <= endB && bFrom <= endA;
}
function sameIdentity(a, b) {
  const ag = key(a.itemGuid), bg = key(b.itemGuid);
  if (ag && bg) return ag === bg;
  return Boolean(key(a.itemCode)) && key(a.itemCode) === key(b.itemCode);
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
  const collection = db.collection(COLLECTION);
  await collection.createIndex({ resolutionId:1 }, { unique:true });
  await collection.createIndex({ itemGuid:1, status:1, effectiveFrom:1, effectiveTo:1 });
  await collection.createIndex({ itemCode:1, status:1, effectiveFrom:1, effectiveTo:1 });
  await collection.createIndex({ status:1, updatedAt:-1 });
  return { ok:true, collection:COLLECTION, schemaVersion:SCHEMA_VERSION };
}
async function ensureNoDuplicate(db, candidate, excludedResolutionId = '') {
  const rows = await allRows(db.collection(COLLECTION), { status:{ $in:['draft', 'pending', 'approved'] } });
  const duplicate = rows.find(row =>
    row.resolutionId !== excludedResolutionId &&
    sameIdentity(row, candidate) &&
    overlaps(row.effectiveFrom, row.effectiveTo, candidate.effectiveFrom, candidate.effectiveTo)
  );
  if (duplicate) fail(
    'MANUAL_COST_OVERLAP',
    `برای این کالا در بازه مؤثر، Resolution فعال دیگری وجود دارد: ${duplicate.resolutionId}`,
    409
  );
}
async function createDraft(db, input, requestedBy) {
  await ensureIndexes(db);
  assertRole(requestedBy?.role, EDIT_ROLES);
  const normalized = validateDraft(input);
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
  return { ok:true, resolution:doc };
}
async function getById(db, resolutionId) {
  await ensureIndexes(db);
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
  const normalized = validateDraft({ ...current, ...input });
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
  if (action === 'approve' && clean(current.createdBy?.username) === clean(requestedBy?.username)) {
    fail('MANUAL_COST_SELF_APPROVAL', 'ایجادکننده نمی‌تواند Resolution خود را تأیید کند.', 403);
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
  if (action === 'approve') Object.assign(patch, { approvedBy:actor(requestedBy), approvedAt:now });
  if (action === 'reject') Object.assign(patch, { rejectedBy:actor(requestedBy), rejectedAt:now, rejectionReason:clean(reason, 1000) });
  if (action === 'expire') Object.assign(patch, { expiredBy:actor(requestedBy), expiredAt:now, expirationReason:clean(reason, 1000) });
  const result = await db.collection(COLLECTION).updateOne(
    { resolutionId:current.resolutionId, status:current.status, revision:expectedRevision },
    { $set:patch }
  );
  if (!result.matchedCount) fail('MANUAL_COST_CONCURRENT_CHANGE', 'وضعیت Resolution هم‌زمان تغییر کرده است؛ دوباره بارگذاری کنید.', 409);
  return { ok:true, resolution:await getById(db, resolutionId) };
}
async function list(db, filters = {}) {
  await ensureIndexes(db);
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
function validAt(row, saleDate) {
  return row.status === 'approved' &&
    row.deleted !== true &&
    row.effectiveFrom <= saleDate &&
    (!row.effectiveTo || row.effectiveTo >= saleDate);
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
  unknown_cost:'ردیف خرید ناقص یا هزینه نامعتبر را بررسی کنید.'
});
async function loadReadinessContext(db) {
  await ensureIndexes(db);
  const purchaseActive = await purchaseLayerDataset.activeDataset(db);
  const saleActive = await saleSnapshot._activeDataset(db);
  const allLayers = purchaseActive?.datasetId
    ? await allRows(db.collection(purchaseLayerDataset.LAYERS), { datasetId:purchaseActive.datasetId })
    : [];
  const official = allLayers.filter(officialLayerValid);
  const returns = allLayers.filter(row => row.layerKind === 'purchase-return');
  const manual = await allRows(db.collection(COLLECTION), { status:'approved' });
  const saleRows = await allRows(db.collection(saleActive.lineCollection), { ...saleActive.lineQuery, saleInvoiceType:2 });
  const legacyLayers = await allRows(db.collection(purchaseLayerDataset.LAYERS), { datasetId:{ $exists:false } }).catch(() => []);
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
  return {
    purchaseActive,
    saleActive,
    allLayers,
    official,
    returns,
    manual,
    saleRows,
    legacyLayers,
    ...indexes,
    purchaseDateFrom:clean(purchaseActive?.dataset?.sourceDateFrom || purchaseActive?.dataset?.request?.dateFrom)
  };
}
function assessSaleRow(row, context) {
  const officialRows = indexedRows(context, 'official', row, true).filter(layer => matchesOfficial(layer, row));
  const manualRows = indexedRows(context, 'manual', row, true).filter(resolution => validAt(resolution, row.saleDate) && matchesManual(resolution, row));
  const returnRows = [...new Set([
    ...(context.returnsByCode.get(key(row.itemCode)) || []),
    ...(key(row.itemGuid) ? context.returnsByGuid.get(key(row.itemGuid)) || [] : [])
  ])];
  const source = officialRows.length ? 'official' : (manualRows.length ? 'manual' : 'unknown');
  const reason = source === 'unknown' ? classifyMissing(row, context) : '';
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
  const context = await loadReadinessContext(db);
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
      suppliers:new Set()
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
    total,
    page,
    pageSize,
    list:rows.slice((page - 1) * pageSize, page * pageSize),
    classifications:Object.fromEntries([...new Set(rows.map(row => row.reason).filter(Boolean))].map(reason => [reason, rows.filter(row => row.reason === reason).length])),
    profitActivationAllowed:false,
    fifoCalculationActivated:false
  };
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
  EDIT_ROLES,
  APPROVE_ROLES,
  ensureIndexes,
  createDraft,
  updateDraft,
  transition,
  list,
  getById,
  missingQueue,
  readiness,
  coverage,
  dataHealth,
  _validAt:validAt,
  _assessSaleRow:assessSaleRow,
  _validateDraft:validateDraft,
  _sameIdentity:sameIdentity,
  _overlaps:overlaps
};
