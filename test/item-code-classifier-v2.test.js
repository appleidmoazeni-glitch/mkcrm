const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ItemCodeClassifierV2,
  compareItemCodeClassifiers,
  hasValidGtinChecksum
} = require('../src/lib/item-code-classifier-v2');

const classifier = new ItemCodeClassifierV2();
const oldClassifier = value => /^[0-9A-Za-z_-]{5,}$/.test(String(value || '').trim()) && !/\s/.test(String(value || '').trim());

const expectedClassifications = new Map([
  ['14400', 'probable_code'],
  ['14400f', 'probable_code'],
  ['patriot', 'brand'],
  ['kingston', 'brand'],
  ['adata', 'brand'],
  ['intel', 'brand'],
  ['cpu intel', 'mixed_query'],
  ['patriot 3200', 'mixed_query'],
  ['cpu intel 14400f', 'mixed_query'],
  ['11I0305535', 'definite_code'],
  ['5901234123457', 'barcode']
]);

test('classifies the approved shadow comparison data', () => {
  for (const [query, expected] of expectedClassifications) {
    const result = classifier.classify(query);
    assert.equal(result.classification, expected, query);
    assert.equal(typeof result.confidence, 'number', query);
    assert.ok(result.confidence >= 0 && result.confidence <= 1, query);
    assert.ok(result.reason, query);
  }
});

test('recognizes valid GTIN and rejects an invalid checksum', () => {
  assert.equal(hasValidGtinChecksum('5901234123457'), true);
  assert.equal(hasValidGtinChecksum('5901234123458'), false);
});

test('reports old-detector false-positive candidates without changing the old decision', () => {
  for (const query of ['patriot', 'kingston', 'adata', 'intel']) {
    const oldDecision = oldClassifier(query);
    const comparison = compareItemCodeClassifiers(query, oldDecision, classifier);
    assert.equal(oldDecision, true);
    assert.equal(comparison.oldDecision, true);
    assert.equal(comparison.newDecision, false);
    assert.equal(comparison.differentDecision, true);
  }
});

test('reports potential old-detector false-negative candidates', () => {
  const query = 'AB/12345';
  const comparison = compareItemCodeClassifiers(query, oldClassifier(query), classifier);
  assert.equal(comparison.oldDecision, false);
  assert.equal(comparison.newDecision, true);
  assert.equal(comparison.classification, 'definite_code');
});

test('comparison statistics are deterministic for the approved fixture set', () => {
  const rows = [...expectedClassifications.keys()].map(query => compareItemCodeClassifiers(query, oldClassifier(query), classifier));
  const stats = {
    total:rows.length,
    same:rows.filter(row => row.sameDecision).length,
    different:rows.filter(row => row.differentDecision).length,
    oldPositiveNewNegative:rows.filter(row => row.oldDecision && !row.newDecision).length,
    oldNegativeNewPositive:rows.filter(row => !row.oldDecision && row.newDecision).length
  };
  assert.deepEqual(stats, { total:11, same:7, different:4, oldPositiveNewNegative:4, oldNegativeNewPositive:0 });
});

test('server keeps the original detector unchanged and shadow output outside decisions', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src/server.js'), 'utf8');
  assert.match(server, /function looksLikeItemCode\(q = ''\) \{\s*const x = String\(q \|\| ''\)\.trim\(\);\s*return \/\^\[0-9A-Za-z_-\]\{5,\}\$\/\.test\(x\) && !\/\\s\/\.test\(x\);\s*\}/);
  assert.match(server, /ITEM_CODE_CLASSIFIER_V2_SHADOW/);
  assert.doesNotMatch(server, /if\s*\([^)]*(compareItemCodeClassifiers|classification|newDecision)/);
  assert.doesNotMatch(server, /searchInventoryRows\([^)]*(classification|newDecision)/);
  assert.doesNotMatch(server, /searchSaleInventorySnapshot\([^)]*(classification|newDecision)/);
});

test('classifier module is pure and has no inventory, Mongo, or Shaygan dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/lib/item-code-classifier-v2.js'), 'utf8');
  assert.doesNotMatch(source, /mongodb|shaygan|itemInventoryCatalog|updateOne|updateMany|bulkWrite|fetch\(/i);
});
