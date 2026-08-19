'use strict';

const VALID_LAYER_KINDS = Object.freeze(['purchase', 'purchase-return']);
const CLASSIFICATION = Object.freeze({
  CANONICAL:'CANONICAL_PURCHASE_LAYER',
  LEGACY:'LEGACY_NONCANONICAL_PURCHASE_RECORD'
});

function clean(value) { return String(value == null ? '' : value).trim(); }
function isCanonicalPurchaseLayer(row = {}) {
  return Boolean(
    clean(row.datasetId) &&
    clean(row.purchaseLineIdentity) &&
    VALID_LAYER_KINDS.includes(clean(row.layerKind)) &&
    Number.isInteger(Number(row.datasetSchemaVersion)) &&
    Number(row.datasetSchemaVersion) >= 1
  );
}
function classifyPurchaseLayer(row = {}) {
  return isCanonicalPurchaseLayer(row) ? CLASSIFICATION.CANONICAL : CLASSIFICATION.LEGACY;
}
function canonicalLayerQuery(extra = {}) {
  const contract = {
    datasetId:{ $exists:true, $nin:['', null] },
    purchaseLineIdentity:{ $exists:true, $nin:['', null] },
    layerKind:{ $in:VALID_LAYER_KINDS },
    datasetSchemaVersion:{ $gte:1 }
  };
  return Object.keys(extra || {}).length ? { $and:[contract, extra] } : contract;
}
function canonicalPurchaseQuery(extra = {}) {
  return canonicalLayerQuery({ ...extra, layerKind:'purchase' });
}
function canonicalPurchaseReturnQuery(extra = {}) {
  return canonicalLayerQuery({ ...extra, layerKind:'purchase-return' });
}

module.exports = {
  VALID_LAYER_KINDS,
  CLASSIFICATION,
  isCanonicalPurchaseLayer,
  classifyPurchaseLayer,
  canonicalLayerQuery,
  canonicalPurchaseQuery,
  canonicalPurchaseReturnQuery
};
