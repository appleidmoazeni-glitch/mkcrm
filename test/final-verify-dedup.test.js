const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');

function sourceSection(start, end, from = 0) {
  const startAt = frontend.indexOf(start, from);
  const endAt = frontend.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `missing section start: ${start}`);
  assert.ok(endAt > startAt, `missing section end: ${end}`);
  return { text: frontend.slice(startAt, endAt), startAt, endAt };
}

function secondOccurrence(needle) {
  const first = frontend.indexOf(needle);
  assert.ok(first >= 0, `missing first occurrence: ${needle}`);
  const second = frontend.indexOf(needle, first + needle.length);
  assert.ok(second > first, `missing second occurrence: ${needle}`);
  return second;
}

function createHarness() {
  const base = sourceSection(
    'function applyVerifiedSaleStockSelection',
    'function addSaleLine'
  ).text;
  const secondVerifyAt = secondOccurrence('async function verifyLiveInventory');
  const wrapper = sourceSection(
    'async function verifyLiveInventory',
    '  window.renderInventory = renderInventory',
    secondVerifyAt
  ).text;
  const phase3 = sourceSection(
    'async function verifyAndSelectSaleStock',
    '  function bindSaleSnapshotSearch'
  ).text;

  const context = {
    apiCalls: [],
    apiImpl: async () => ({ ok:true, list:[] }),
    selectionCalls: 0,
    state: {
      selectedItem: null,
      selectedStock: null,
      selectedSerials: [],
      serialInfo: null
    },
    elements: new Map([
      ['#saleInventory', { innerHTML:'' }],
      ['#STNumber', { value:'' }]
    ]),
    window: {}
  };
  context.$ = selector => context.elements.get(selector) || null;
  context.api = async url => {
    context.apiCalls.push(url);
    return context.apiImpl(url);
  };
  context.safe = value => String(value ?? '');
  context.esc = context.safe;
  context.nfmt = value => String(Number(value || 0));
  context.qtyOf = value => Number(value?.quantity ?? value?.RemainQ ?? value?.Quantity1 ?? 0);
  context.stockNo = value => String(value?.stockNumber ?? value?.STNumber ?? '');
  context.productFromRow = row => ({
    itemCode:String(row.itemCode || ''),
    itemDescription:String(row.itemDescription || ''),
    itemGuid:String(row.itemGuid || '')
  });
  context.stockFromRow = row => ({
    stockNumber:String(row.stockNumber || ''),
    stockName:String(row.stockName || ''),
    stockGuid:String(row.stockGuid || ''),
    quantity:Number(row.quantity || 0),
    averageCost:Number(row.averageCost || 0),
    remainCost:Number(row.remainCost || 0)
  });
  context.checkBelowCost = () => {};
  context.loadSerialsForSelected = () => { context.selectionCalls += 1; };

  vm.createContext(context);
  vm.runInContext(`${base}\n${wrapper}\n${phase3}`, context);
  return context;
}

const item = {
  itemCode:'ITEM-1',
  itemDescription:'Test item',
  itemGuid:'ITEM-GUID'
};
const stock01 = {
  stockNumber:'01',
  stockName:'Main',
  stockGuid:'STOCK-01',
  quantity:3
};
const stock70 = {
  stockNumber:'70',
  stockName:'Second',
  stockGuid:'STOCK-70',
  quantity:2
};

function availableRows() {
  return [
    { ...item, ...stock01 },
    { ...item, ...stock70 }
  ];
}

function finalVerifyCalls(context) {
  return context.apiCalls.filter(url => /^\/api\/items\/[^/]+\/inventory/.test(url));
}

test('the source contains one legacy verification wrapper and one base selector', () => {
  assert.equal(
    (frontend.match(/window\.selectSaleStock = selectSaleStock = async function/g) || []).length,
    1
  );
  assert.equal(
    (frontend.match(/function applyVerifiedSaleStockSelection/g) || []).length,
    1
  );
  const phase3 = sourceSection(
    'async function verifyAndSelectSaleStock',
    '  function bindSaleSnapshotSearch'
  ).text;
  assert.match(phase3, /applyVerifiedSaleStockSelection\(item, liveStock\)/);
  assert.doesNotMatch(phase3, /selectSaleStock\(item, liveStock\)/);
});

test('one snapshot selection performs one final verify and one selection', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await context.verifyAndSelectSaleStock(item, stock01);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 1);
  assert.equal(context.state.selectedStock.stockNumber, '01');
});

test('one legacy selection performs one final verify and one selection', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await context.selectSaleStock(item, stock70);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 1);
  assert.equal(context.state.selectedStock.stockNumber, '70');
});

test('double click performs one verify per click without wrapper multiplication', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await Promise.all([
    context.verifyAndSelectSaleStock(item, stock01),
    context.verifyAndSelectSaleStock(item, stock01)
  ]);
  assert.equal(finalVerifyCalls(context).length, 2);
  assert.equal(context.selectionCalls, 2);
});

test('rapid repeated clicks do not multiply verifies inside a selection', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await Promise.all(Array.from(
    { length:5 },
    () => context.verifyAndSelectSaleStock(item, stock01)
  ));
  assert.equal(finalVerifyCalls(context).length, 5);
  assert.equal(context.selectionCalls, 5);
});

test('different warehouse keeps the verified warehouse identity', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await context.selectSaleStock(item, stock70);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.state.selectedStock.stockNumber, '70');
  assert.equal(context.state.selectedStock.quantity, 2);
});

test('unavailable stock rejects selection after one final verify', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:true, list:[] });
  await context.verifyAndSelectSaleStock(item, stock01);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 0);
  assert.equal(context.state.selectedItem, null);
  assert.equal(context.state.selectedStock, null);
});

test('final verify transport failure preserves rejection behavior', async () => {
  const context = createHarness();
  context.apiImpl = async () => ({ ok:false, error:'controlled failure', list:[] });
  await context.verifyAndSelectSaleStock(item, stock01);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 0);
  assert.equal(context.state.selectedItem, null);
  assert.equal(context.state.selectedStock, null);
});

test('page navigation during final verify is contained without another verify', async () => {
  const context = createHarness();
  let resolveVerify;
  context.apiImpl = () => new Promise(resolve => { resolveVerify = resolve; });
  const pending = context.verifyAndSelectSaleStock(item, stock01);
  context.elements.clear();
  resolveVerify({ ok:true, list:availableRows() });
  await pending;
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 0);
  assert.equal(context.state.selectedItem, null);
  assert.equal(context.state.selectedStock, null);
});

test('background verify remains a separate read-only path', () => {
  const background = sourceSection(
    'async function verifyVisibleResult',
    '    const search=debounceLocal'
  ).text;
  assert.match(background, /\/api\/search\/inventory-verify/);
  assert.doesNotMatch(background, /\/api\/items\/.*\/inventory/);
  assert.doesNotMatch(background, /selectSaleStock|applyVerifiedSaleStockSelection/);
});

test('a completed background verify does not add another final verify', async () => {
  const context = createHarness();
  context.apiCalls.push('/api/search/inventory-verify?q=ITEM-1');
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await context.verifyAndSelectSaleStock(item, stock01);
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 1);
});

test('a pending background verify does not join or duplicate final verify', async () => {
  const context = createHarness();
  let finishBackground;
  const background = new Promise(resolve => { finishBackground = resolve; });
  context.apiCalls.push('/api/search/inventory-verify?q=ITEM-1');
  context.apiImpl = async () => ({ ok:true, list:availableRows() });
  await context.verifyAndSelectSaleStock(item, stock01);
  finishBackground({ ok:true });
  await background;
  assert.equal(finalVerifyCalls(context).length, 1);
  assert.equal(context.selectionCalls, 1);
});

test('sale row removal and invoice issuing paths remain present', () => {
  assert.match(frontend, /state\.saleLines\.splice\(Number\(b\.dataset\.i\),1\)/);
  assert.match(frontend, /async function issueSale\(\)/);
  assert.match(frontend, /\/admin\/accounting\/putInvoice/);
});
