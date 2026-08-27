const crypto = require('crypto');
const canonicalCatalog = require('./canonical-item-catalog');

const CONTRACT_VERSION = 'board-stock-out-transition-v1';

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function transitionAuthority(input = {}) {
  const invoiceGuid = canonicalCatalog.canonicalItemGuid(input.invoiceGuid);
  if (invoiceGuid) return `sale-guid:${invoiceGuid}`;
  const invoiceNumber = clean(input.invoiceNumber, 100);
  if (invoiceNumber) return `sale-invoice:${invoiceNumber}`;
  const saleIssueKey = clean(input.saleIssueKey, 200);
  if (saleIssueKey) return `sale-issue:${saleIssueKey}`;
  return '';
}

function canonicalIdentity(input = {}) {
  const stored = clean(input.canonicalIdentity, 300);
  if (stored) return stored;
  return canonicalCatalog._identityOf({
    itemGuid:input.canonicalItemGuid || input.itemGuid,
    itemCode:input.itemCode
  });
}

function buildStockOutTransition(input = {}) {
  const identity = canonicalIdentity(input);
  const authority = transitionAuthority(input);
  const totalQtyAfter = Number(input.totalQtyAfter || 0);
  const soldQty = Number(input.soldQty || 0);
  if (!identity || !authority || !(soldQty > 0) || totalQtyAfter > 0) {
    return { ok:false, code:'BOARD_STOCK_OUT_TRANSITION_INVALID' };
  }
  const transitionId = crypto
    .createHash('sha256')
    .update(`${CONTRACT_VERSION}|${identity}|${authority}`)
    .digest('hex');
  return {
    ok:true,
    contractVersion:CONTRACT_VERSION,
    transitionId,
    eventKey:`stock_out:v2:${transitionId}`,
    canonicalItemIdentity:identity,
    canonicalItemGuid:canonicalCatalog.canonicalItemGuid(input.canonicalItemGuid || input.itemGuid),
    transitionAuthority:authority,
    totalQtyBefore:totalQtyAfter + soldQty,
    totalQtyAfter,
    soldQty
  };
}

async function resolveCanonicalIdentity(db, input = {}) {
  const supplied = canonicalCatalog.canonicalItemGuid(input.itemGuid);
  let row = null;
  if (supplied) {
    row = await db.collection('itemCatalogAll').findOne({
      $or:[{ canonicalItemGuid:supplied }, { itemGuid:clean(input.itemGuid) }]
    }).catch(() => null);
  }
  if (!row && input.itemCode) {
    const normalizedItemCode = canonicalCatalog.normalizedItemCode(input.itemCode);
    row = await db.collection('itemCatalogAll').findOne({ normalizedItemCode }).catch(() => null);
  }
  return {
    canonicalItemGuid:canonicalCatalog.canonicalItemGuid(row?.canonicalItemGuid || row?.itemGuid || supplied),
    canonicalIdentity:clean(row?.canonicalIdentity, 300),
    itemGuid:clean(row?.itemGuid || input.itemGuid, 100)
  };
}

async function ensureBoardLifecycleIndexes(db) {
  const collection = db.collection('boardEvents');
  const results = [];
  results.push(await collection.createIndex({ eventKey:1 }, { unique:true, sparse:true }));
  results.push(await collection.createIndex({ status:1, createdAt:-1 }));
  results.push(await collection.createIndex({ itemCode:1, status:1 }));
  results.push(await collection.createIndex({ canonicalItemIdentity:1, type:1, createdAt:-1 }));
  return results;
}

module.exports = {
  CONTRACT_VERSION,
  buildStockOutTransition,
  resolveCanonicalIdentity,
  ensureBoardLifecycleIndexes,
  _canonicalIdentity:canonicalIdentity,
  _transitionAuthority:transitionAuthority
};
