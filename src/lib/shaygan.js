const { config } = require('./config');

function range(from = '', to = '', arr = []) { return { From: String(from || ''), To: String(to || ''), In: arr }; }
function sortRange(value = '0') { return { From: String(value), To: '', In: [] }; } // Shaygan GetStatement requires Sort.From = 0 or 1
function body(domain) { return { StartVersion: '0', EndVersion: '', Domain: domain, Config: { ConnectionName: config.shayganConnectionName } }; }

async function post(endpoint, domain, rowStart = 0, rowCount = 100, opts = {}) {
  const safeRowCount = Math.max(1, Math.min(Number(rowCount || 100), Number(opts.maxRowCount || 100)));
  const url = `${config.shayganBaseUrl}${endpoint}?RowStart=${rowStart}&RowCount=${safeRowCount}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || config.shayganTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-version': config.shayganApiVersion },
      body: JSON.stringify(body(domain)),
      signal: controller.signal
    });
    const raw = await response.json().catch(() => ({}));
    const err = raw.ErrorMessage || (Array.isArray(raw.Result) && raw.Result.find(x => x && x.ErrorMessage)?.ErrorMessage) || '';
    return { ok: response.ok && !err, status: response.status, result: Array.isArray(raw.Result) ? raw.Result : [], raw, error: err };
  } catch (e) {
    return { ok: false, status: 0, result: [], raw: null, error: e.name === 'AbortError' ? 'Shaygan request timeout' : e.message };
  } finally { clearTimeout(timer); }
}

async function put(endpoint, putBody, opts = {}) {
  const url = `${config.shayganBaseUrl}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || config.shayganTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-version': config.shayganApiVersion },
      body: JSON.stringify(putBody),
      signal: controller.signal
    });
    const raw = await response.json().catch(() => ({}));
    const err = raw.ErrorMessage || (Array.isArray(raw.Result) && raw.Result.find(x => x && x.ErrorMessage)?.ErrorMessage) || '';
    return { ok: response.ok && !err, status: response.status, result: Array.isArray(raw.Result) ? raw.Result : [], raw, error: err };
  } catch (e) {
    return { ok: false, status: 0, result: [], raw: null, error: e.name === 'AbortError' ? 'Shaygan request timeout' : e.message };
  } finally { clearTimeout(timer); }
}


const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

function serialDomain(input = {}) {
  const itemCode = input.itemCode || '';
  const itemGuid = input.itemGuid || '';
  const stockNumber = input.stockNumber || '';
  const stockGuid = input.stockGuid || '';
  return {
    WithExtraFields: 'false',
    Sort: range(),
    Date: range(),
    ItemCode: itemCode ? range(itemCode, itemCode) : range(),
    ItemNumber: itemCode ? range(itemCode, itemCode) : range(),
    ItemGuID: itemGuid ? range(itemGuid, itemGuid) : range(),
    ItemGuId: itemGuid ? range(itemGuid, itemGuid) : range(),
    StockGuID: stockGuid ? range(stockGuid, stockGuid) : range(),
    STGuId: stockGuid ? range(stockGuid, stockGuid) : range(),
    STNumber: stockNumber ? range(stockNumber, stockNumber) : range(),
    StoreNumber: stockNumber ? range(stockNumber, stockNumber) : range(),
    SerialNumber: range(),
    BatchNumber: range(),
    ShowItemsZeroRemain: range(),
    ItemMainGroupCode: range(),
    ItemGroupCode: range()
  };
}

function extractSerialRows(rows = []) {
  const out = [];
  const seen = new Set();
  const fields = ['SerialNumber','serialNumber','UserSerial','CyberSerial','BatchNumber','BatchNo','Serial','serial','BodySerialNumber'];
  for (const row of rows || []) {
    for (const f of fields) {
      const v = row && row[f];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      const sn = String(v).trim();
      if (seen.has(sn)) continue;
      seen.add(sn);
      out.push({
        serialNumber: sn,
        serialHeaderGuid: row.SerialHeaderGuId || row.SerialHeaderGuid || row.SerialHeaderGUID || row.HeaderGuId || row.HeaderGuid || ZERO_GUID,
        serialBodyId: Number(row.SerialBodyId || row.SerialBodyID || row.SerialBody || 0),
        guId: row.GuId || row.Guid || row.SerialBodyGuId || ZERO_GUID,
        itemCode: row.ItemCode || row.ItemNumber || '',
        stockNumber: row.STNumber || row.StoreNumber || row.StockNumber || '',
        raw: row
      });
      break;
    }
  }
  return out;
}

async function getSerialsByItemStock(input = {}) {
  const domain = serialDomain(input);
  const attempts = [
    { name: 'Item/GetRemainWithBatchNumber', endpoint: '/api/Item/GetRemainWithBatchNumber', rowCount: 100 },
    { name: 'Item/GetRemainHistoryWithBatchNumber', endpoint: '/api/Item/GetRemainHistoryWithBatchNumber', rowCount: 100 },
    { name: 'BatchNumber/Get', endpoint: '/api/BatchNumber/Get', rowCount: 100 },
    { name: 'Item/GetSerials', endpoint: '/api/Item/GetSerials', rowCount: 100 },
    { name: 'Item/GetSerial', endpoint: '/api/Item/GetSerial', rowCount: 100 },
    { name: 'Serial/Get', endpoint: '/api/Serial/Get', rowCount: 100 },
    { name: 'SerialNumber/Get', endpoint: '/api/SerialNumber/Get', rowCount: 100 }
  ];
  const diagnostics = [];
  for (const a of attempts) {
    const r = await post(a.endpoint, domain, 0, a.rowCount, { maxRowCount: a.rowCount, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 7000) });
    diagnostics.push({ endpoint: a.name, ok: r.ok, status: r.status, count: r.result.length, error: r.error || '' });
    if (r.ok && r.result.length) {
      const list = extractSerialRows(r.result);
      if (list.length) return { ok: true, list, source: a.name, attempts: diagnostics, raw: r.raw };
    }
  }
  return { ok: true, list: [], source: '', attempts: diagnostics, needsManual: true, note: 'در WebService موجود، endpoint قطعی برای خواندن سریال پیدا نشد یا برای این کالا/انبار سریالی برنگشت. اگر کالا سریال‌دار است، سریال را دستی وارد کنید تا در Invoice/Put داخل Body.Serials ارسال شود.' };
}

function mapItem(row) {
  return {
    itemCode: row.ItemCode || row.ProductCode,
    itemDescription: row.ItemDesc || row.ProductDesc || row.ItemDescription,
    itemGuid: row.ItemGuId || row.GuId,
    groupNumber: row.ItemGroupNumber || row.ProductGroupNumber,
    groupGuid: row.ItemGroupGuId || row.ProductGroupGuId,
    raw: row
  };
}

async function getAccountsPage(rowStart = 0, rowCount = 100) {
  const domain = {
    WithExtraFields: 'false',
    Sort: range(),
    AccountNumber: range(),
    AccountName: range(),
    MoinNumber: range(),
    AccountGuId: range()
  };
  const res = await post('/api/Account/Get', domain, rowStart, rowCount, { maxRowCount: 100, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 7000) });
  const list = res.result.map(x => ({
    accountNumber: x.AccountNumber,
    accountName: x.AccountName,
    moinNumber: x.MoinNumber,
    accountTypeId: x.AccountTypeId,
    mobile: x.Mobile || '',
    guId: x.GuId,
    raw: x
  })).filter(x => x.accountNumber || x.accountName);
  return { ...res, list };
}


function normSearch(v = '') {
  return String(v || '').trim().toLowerCase()
    .replace(/[ي]/g,'ی').replace(/[ك]/g,'ک')
    .replace(/‌/g,' ')
    .replace(/[_\-\/\|.,؛:()\[\]{}+]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function accountTokens(q = '') { return normSearch(q).split(/\s+/).filter(Boolean); }
function scoreAccount(acc, tokens) {
  const number = normSearch(acc.accountNumber || '');
  const name = normSearch(acc.accountName || '');
  const moin = normSearch(acc.moinNumber || '');
  const hay = `${number} ${name} ${moin}`;
  const unique = [...new Set(tokens.map(normSearch).filter(Boolean))];
  if (!unique.length) return 0;
  if (!unique.every(t => hay.includes(t))) return -Infinity;
  let score = 0;
  for (const t of unique) {
    if (number === t) score += 10000;
    else if (number.startsWith(t)) score += 5000;
    else if (number.includes(t)) score += 2500;
    if (name.startsWith(t)) score += 1800;
    else if (name.includes(t)) score += Math.max(200, 900 - name.indexOf(t));
    if (moin.includes(t)) score += 400;
  }
  score -= Math.min(name.length, 200) / 20;
  return score;
}

async function searchAccounts(q = '', limit = 30, maxPages = config.accountSearchPages || 220) {
  const tokens = accountTokens(q);
  const found = [];
  const seen = new Set();
  let scannedPages = 0;
  for (let rowStart = 0, page = 0; page < maxPages; page++, rowStart += 100) {
    const res = await getAccountsPage(rowStart, 100);
    scannedPages = page + 1;
    if (!res.ok) return { ok:false, list:found, error:res.error, source:'account-live', scannedPages:page };
    if (!res.list.length) break;
    for (const a of res.list) {
      const score = scoreAccount(a, tokens);
      const key = a.guId ? `guid:${a.guId}` : `${a.accountNumber}|${a.moinNumber||''}|${a.accountName||''}`;
      if (score > -Infinity && !seen.has(key)) {
        seen.add(key);
        found.push({ ...a, accountKey:key, _score: score });
      }
    }
    if (res.list.length < 100) break;
  }
  found.sort((a,b) => (b._score||0) - (a._score||0) || String(a.accountName||'').localeCompare(String(b.accountName||''),'fa') || String(a.accountNumber||'').localeCompare(String(b.accountNumber||'')));
  return { ok:true, list:found.slice(0, Number(limit||30)), source:'account-live-ranked', scannedPages };
}

async function getStocks() {
  const domain = { WithExtraFields: 'false', Sort: range(), STNumber: range(), STGuId: range() };
  const res = await post('/api/Stock/Get', domain, 0, 100);
  return { ...res, list: res.result.map(x => ({ stockNumber: x.StockNumber, stockName: x.StockName, stockGuid: x.GuId, raw: x })) };
}

async function getInventoryByItemCode(itemCode) {
  const domain = {
    Sort: range(), Date: range(), ItemCode: range(itemCode, itemCode), ItemGuID: range(), StockGuID: range(), STNumber: range(),
    ShowItemsZeroRemain: range(), ItemMainGroupCode: range(), ItemGroupCode: range()
  };
  const res = await post('/api/Item/GetRemain', domain, 0, 100);
  const list = res.result.map(x => ({
    itemCode: x.ItemCode,
    itemDescription: x.ItemDescription,
    itemGuid: x.ItemGuId,
    stockNumber: x.StoreNumber,
    stockName: x.StoreName,
    stockGuid: x.StockGuId,
    quantity: Number(x.Quantity1 || 0),
    quantity2: Number(x.Quantity2 || 0),
    averageCost: Number(x.RemainUnit1Price || 0),
    remainCost: Number(x.RemainCost || 0),
    raw: x
  })).filter(x => x.quantity > 0).sort((a,b) => b.quantity - a.quantity || String(a.stockNumber).localeCompare(String(b.stockNumber)));
  return { ...res, list };
}


async function getInventoryPage(rowStart = 0, rowCount = 100, filters = {}) {
  const domain = {
    Sort: range(), Date: range(), ItemCode: range(), ItemGuID: range(), StockGuID: range(),
    STNumber: filters.stockNumber ? range(filters.stockNumber, filters.stockNumber) : range(),
    ShowItemsZeroRemain: range(),
    ItemMainGroupCode: filters.itemMainGroupCode ? range(filters.itemMainGroupCode, filters.itemMainGroupCode) : range(),
    ItemGroupCode: filters.itemGroupCode ? range(filters.itemGroupCode, filters.itemGroupCode) : range()
  };
  const res = await post('/api/Item/GetRemain', domain, rowStart, rowCount);
  const list = res.result.map(x => ({
    itemCode: x.ItemCode,
    itemDescription: x.ItemDescription,
    itemGuid: x.ItemGuId,
    stockNumber: x.StoreNumber,
    stockName: x.StoreName,
    stockGuid: x.StockGuId,
    quantity: Number(x.Quantity1 || 0),
    quantity2: Number(x.Quantity2 || 0),
    averageCost: Number(x.RemainUnit1Price || 0),
    remainCost: Number(x.RemainCost || 0),
    raw: x
  })).filter(x => x.itemCode && x.quantity > 0);
  return { ...res, list };
}

function normalizeKardexRow(row = {}) {
  const inQty = Number(row.IncomeQuan1 || row.IncomeQuan || row.InQty || 0);
  const outQty = Number(row.OutComeQuan1 || row.OutComeQuan || row.OutQty || 0);
  const costPrice = Number(row.InPrice || 0) > 0
    ? Number(row.InPrice)
    : Number(row.OutPrice || 0) > 0
      ? Number(row.OutPrice)
      : Number(row.ProductValue || 0);
  const salePrice = Number(row.Price || row.Rial || 0);
  return {
    stateId: row.StateId,
    id: row.ID || row.Id || row.Itemsegid || '',
    date: row.Date,
    invoiceNumber: row.InvoiceNumber,
    invoiceType: row.InvoiceType,
    accountNumber: row.CustomerNumber,
    accountName: row.CustomerName,
    inQty,
    outQty,
    remainQty: Number(row.RemainQuan1 || row.Remain || 0),
    costPrice,
    salePrice,
    grossProfit: outQty > 0 ? salePrice - costPrice : 0,
    rowAmount: Number(row.Rial || 0),
    remainValue: Number(row.Remain || 0),
    raw: row
  };
}

function isRealKardexMovement(row = {}) {
  return Boolean(row.Date || row.InvoiceNumber || Number(row.IncomeQuan1 || 0) || Number(row.OutComeQuan1 || 0) || Number(row.IncomeQuan || 0) || Number(row.OutComeQuan || 0));
}

function kardexDedupKey(x = {}) {
  const r = x.raw || {};
  return [r.ID || r.Id || '', r.Itemsegid || '', x.date || '', x.invoiceNumber || '', x.invoiceType || '', x.inQty || 0, x.outQty || 0, x.remainQty || 0].join('|');
}

async function getKardexByItemCode(itemCode, stockNumber = '', opts = {}) {
  const maxRows = Math.max(1, Math.min(Number(opts.maxRows || config.kardexSellerMaxRows || 20), Number(opts.hardMaxRows || config.kardexAdminFullMaxRows || 100)));
  const domain = {
    InvDate: range(), InvType: range(), ItemMainGroupCode: range(), ItemCode: range(itemCode, itemCode), STNumber: stockNumber ? range(stockNumber, stockNumber) : range(), STGuId: range(),
    ItemGuId: range(), AccountGuId: range(), JobGuId: range(), ItemGroupCode: range()
  };
  const rows = [];
  const seen = new Set();
  let firstRes = null;
  let item = null;
  let error = '';
  let fetchedPages = 0;

  for (let rowStart = 0; rowStart < maxRows; rowStart++) {
    const res = await post('/api/Item/GetKardex', domain, rowStart, 1, { maxRowCount: 1, timeoutMs: opts.timeoutMs || config.kardexRequestTimeoutMs || Math.min(config.shayganTimeoutMs || 15000, 6000) });
    if (!firstRes) firstRes = res;
    fetchedPages++;
    if (!res.ok) { error = res.error || `Kardex page ${rowStart} failed`; break; }
    if (!res.result.length) break;
    const pageItem = res.result[0];
    if (!item && pageItem) item = pageItem;
    const pageRows = Array.isArray(pageItem?.ItemKardex) ? pageItem.ItemKardex : [];
    for (const rawRow of pageRows) {
      if (!isRealKardexMovement(rawRow)) continue;
      const normalized = normalizeKardexRow(rawRow);
      const key = kardexDedupKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(normalized);
    }
  }

  const reachedLimit = fetchedPages >= maxRows;
  return {
    ...(firstRes || { ok: true, status: 200, result: [], raw: null, error: '' }),
    ok: error ? false : true,
    error,
    item: item ? { itemCode: item.ItemCode, itemDescription: item.ItemDesc, itemGuid: item.ItemGuId } : null,
    rows,
    meta: { fetchedPages, maxRows, reachedLimit, movementCount: rows.length, stockNumber: stockNumber || '' }
  };
}

async function getItemsPage(rowStart = 0, rowCount = 100, itemCodeFrom = '') {
  const domain = { WithExtraFields: 'false', Sort: range(), ItemCode: range(itemCodeFrom, ''), ItemGuId: range(), ItemGroupGuId: range() };
  const res = await post('/api/Item/Get', domain, rowStart, rowCount);
  return { ...res, list: res.result.map(mapItem) };
}

async function getProductListPage(rowStart = 0, rowCount = 100, itemCodeFrom = '') {
  const domain = { WithExtraFields: 'false', Sort: range(), ItemCode: range(itemCodeFrom, ''), ItemGuId: range(), ItemGroupGuId: range() };
  const res = await post('/api/Item/GetProductList', domain, rowStart, rowCount);
  return { ...res, list: res.result.map(mapItem) };
}

async function getInvoice(invNo, invType = 2) {
  const domain = { Sort: range(), InvoiceNumber: range(invNo, invNo), InvoiceType: range(invType, invType), InvoiceDate: range(), ControlCheck: range(), Printed: range() };
  const res = await post('/api/Invoice/Get', domain, 0, 20, { maxRowCount: 20 });
  return { ...res, list: res.result };
}

async function getInvoiceByGuid(guid = '', invType = 2) {
  const g = String(guid || '').trim();
  if (!g) return { ok:false, list:[], result:[], error:'invoice guid empty' };
  const domain = {
    Sort: range(), InvoiceNumber: range(), InvoiceType: range(invType, invType), InvoiceDate: range(), ControlCheck: range(), Printed: range(),
    GuId: range(g, g), Guid: range(g, g), InvGuId: range(g, g), InvHeaderGuId: range(g, g), InvHeaderGuid: range(g, g)
  };
  const res = await post('/api/Invoice/Get', domain, 0, 20, { maxRowCount: 20, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 7000) });
  const list = (res.result || []).filter(x => String(x.GuId || x.Guid || x.InvGuId || x.InvHeaderGuId || '').trim().toLowerCase() === g.toLowerCase());
  return { ...res, list };
}

async function getInvoicePage(rowStart = 0, invType = 2) {
  const domain = { Sort: range(), InvoiceNumber: range(), InvoiceType: range(invType, invType), InvoiceDate: range(), ControlCheck: range(), Printed: range() };
  return post('/api/Invoice/Get', domain, rowStart, 20, { maxRowCount: 20, timeoutMs: config.shayganTimeoutMs });
}


function div(a,b){ return Math.trunc(a/b); }
function jalaliToGregorian(jy, jm, jd){
  jy = Number(jy); jm = Number(jm); jd = Number(jd);
  jy += 1595;
  let days = -355668 + (365 * jy) + div(jy,33)*8 + div((jy % 33) + 3,4) + jd + (jm < 7 ? (jm-1)*31 : ((jm-7)*30 + 186));
  let gy = 400 * div(days,146097); days %= 146097;
  if(days > 36524){ gy += 100 * div(--days,36524); days %= 36524; if(days >= 365) days++; }
  gy += 4 * div(days,1461); days %= 1461;
  if(days > 365){ gy += div(days-1,365); days = (days-1)%365; }
  let gd = days + 1;
  const sal_a = [0,31,((gy%4===0 && gy%100!==0) || (gy%400===0)) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  let gm=1; for(; gm<=12 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
  const pad=n=>String(n).padStart(2,'0');
  return `${gy}-${pad(gm)}-${pad(gd)}`;
}
function normalizeInvoiceDate(v=''){
  // Shaygan Invoice/Get date filter expects an 8-digit date string.
  // Do NOT convert Jalali to Gregorian and do NOT add dashes.
  // Valid examples: 14050101 or 20260701. If UI sends 2026-07-01, strip dashes.
  const s=String(v||'').trim();
  if(!s) return '';
  const m=s.replace(/[^0-9]/g,'');
  if(/^\d{8}$/.test(m)) return m;
  return s;
}

async function getInvoicePageByDate(rowStart = 0, invType = 2, dateFrom = '', dateTo = '', rowCount = 20) {
  const df = normalizeInvoiceDate(dateFrom); const dt = normalizeInvoiceDate(dateTo);
  const domain = { Sort: range(), InvoiceNumber: range(), InvoiceType: range(invType, invType), InvoiceDate: (df || dt) ? range(df || '', dt || '') : range(), ControlCheck: range(), Printed: range() };
  return post('/api/Invoice/Get', domain, rowStart, rowCount, { maxRowCount: Math.min(Number(rowCount || 20), 20), timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 10000) });
}

async function getInvoicePageByTypeRange(rowStart = 0, invTypeFrom = 6, invTypeTo = 7, dateFrom = '', dateTo = '', rowCount = 20) {
  const rc = Math.max(1, Math.min(Number(rowCount || 20), 20));
  const df = normalizeInvoiceDate(dateFrom); const dt = normalizeInvoiceDate(dateTo);
  const domain = {
    Sort: range(),
    InvoiceNumber: range(),
    InvoiceType: range(invTypeFrom, invTypeTo),
    InvoiceDate: (df || dt) ? range(df || '', dt || '') : range(),
    ControlCheck: range(),
    Printed: range()
  };
  return post('/api/Invoice/Get', domain, rowStart, rc, { maxRowCount: 20, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 15000) });
}



async function getInvoicePageByTypeNumberRange(rowStart = 0, invType = 6, invNoFrom = '', invNoTo = '', dateFrom = '', dateTo = '', rowCount = 20) {
  const rc = Math.max(1, Math.min(Number(rowCount || 20), 20));
  const df = normalizeInvoiceDate(dateFrom); const dt = normalizeInvoiceDate(dateTo);
  const domain = {
    Sort: range(),
    InvoiceNumber: (invNoFrom || invNoTo) ? range(invNoFrom || '', invNoTo || '') : range(),
    InvoiceType: range(invType, invType),
    InvoiceDate: (df || dt) ? range(df || '', dt || '') : range(),
    ControlCheck: range(),
    Printed: range()
  };
  return post('/api/Invoice/Get', domain, rowStart, rc, { maxRowCount: 20, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 15000) });
}

async function getLastInvoiceNumber(invType = 2) {
  // Invoice/Get returns ascending pages. Find the last non-empty page without scanning linearly.
  let low = 0, high = 20, lastGoodStart = 0, lastGoodRes = null;
  const first = await getInvoicePage(0, invType);
  if (!first.ok) return { ok: false, last: 0, count: 0, error: first.error, raw: first.raw };
  if (!first.result.length) return { ok: true, last: 0, count: 0, raw: first.raw };
  lastGoodRes = first;
  const maxStart = Number(config.invoiceScanMaxPages || 300) * 20;
  while (high <= maxStart) {
    const r = await getInvoicePage(high, invType);
    if (!r.ok) return { ok:false, last:0, count:0, error:r.error, raw:r.raw };
    if (!r.result.length) break;
    lastGoodStart = high; lastGoodRes = r; low = high; high *= 2;
  }
  if (high > maxStart) high = maxStart;
  // binary search last non-empty page boundary
  let l = low, h = high;
  while (h - l > 20) {
    const mid = Math.floor(((l + h) / 40)) * 20;
    const r = await getInvoicePage(mid, invType);
    if (r.ok && r.result.length) { lastGoodStart = mid; lastGoodRes = r; l = mid; } else { h = mid; }
  }
  // walk a few pages forward to ensure exact last non-empty
  for (let start = lastGoodStart + 20; start <= Math.min(high, lastGoodStart + 200); start += 20) {
    const r = await getInvoicePage(start, invType);
    if (!r.ok || !r.result.length) break;
    lastGoodStart = start; lastGoodRes = r;
  }
  const nums = (lastGoodRes?.result || []).map(x => Number(x.InvNo || 0)).filter(Boolean);
  return { ok: true, last: nums.length ? Math.max(...nums) : 0, count: (lastGoodRes?.result || []).length, rowStart: lastGoodStart, invType, raw: lastGoodRes?.raw };
}

async function getLastSaleInvoiceNumber() { return getLastInvoiceNumber(2); }
async function getLastPurchaseInvoiceNumber() { return getLastInvoiceNumber(3); }

function formatDate8(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function buildSaleInvoicePut(input) {
  const items = Array.isArray(input.items) && input.items.length
    ? input.items
    : [{
        itemCode: input.itemCode,
        itemDescription: input.itemDescription,
        itemGuid: input.itemGuid,
        stockNumber: input.stockNumber,
        stockName: input.stockName,
        stockGuid: input.stockGuid,
        quantity: input.quantity,
        price: input.price,
        discountAmount: input.discountAmount,
        discountPercent: input.discountPercent,
        lineDescription: input.lineDescription
      }];
  const validItems = items.filter(x => x && x.itemCode && x.stockNumber && Number(x.quantity) > 0 && Number(x.price) > 0);
  if (!validItems.length) throw new Error('invoice items required');
  const descParts = [];
  if (input.customerName) descParts.push(`خریدار: ${input.customerName}`);
  if (input.mobile) descParts.push(`موبایل: ${input.mobile}`);
  if (input.nationalCode) descParts.push(`کد ملی: ${input.nationalCode}`);
  if (input.leadId) descParts.push(`Lead: ${input.leadId}`);
  // 0.9.19.25: CRM technical IDs must not be written into Shaygan official invoice description.
  const description = input.description || descParts.join(' | ') || 'ثبت از CRM';
  const grossBeforeHeaderDiscount = validItems.reduce((sum, line) => sum + (Number(line.quantity || 0) * Number(line.price || 0)), 0);
  const requestedHeaderDiscount = Math.max(0, Math.min(Number(input.discountAmount || input.DiscAmount || 0), grossBeforeHeaderDiscount));
  let distributedDiscount = 0;
  const bodyRows = validItems.map((line, idx) => {
    const grossLine = Number(line.quantity) * Number(line.price);
    const manualLineDiscount = Number(line.discountAmount || 0);
    const allocatedHeaderDiscount = requestedHeaderDiscount > 0
      ? (idx === validItems.length - 1 ? (requestedHeaderDiscount - distributedDiscount) : Math.round(requestedHeaderDiscount * (grossLine / Math.max(grossBeforeHeaderDiscount, 1))))
      : 0;
    distributedDiscount += allocatedHeaderDiscount;
    const lineDiscount = Math.max(0, Math.min(grossLine, manualLineDiscount + allocatedHeaderDiscount));
    const amount = Math.max(0, grossLine - lineDiscount);
    return {
      LineItemId: 0,
      InvHeaderId: 0,
      LineItemOrder: idx + 1,
      ItemNumber: line.itemCode,
      ItemDescription: line.itemDescription || '',
      STNumber: line.stockNumber,
      STDesc: line.stockName || '',
      STGuId: line.stockGuid || '00000000-0000-0000-0000-000000000000',
      ItemGuId: line.itemGuid || '00000000-0000-0000-0000-000000000000',
      Quan: Number(line.quantity),
      Quan2: 0,
      Price: Number(line.price),
      Price2: 0,
      Amount: amount,
      CurRial: amount,
      Rial: amount,
      LineDiscAmount: lineDiscount,
      LineDiscPer: grossLine ? Number(((lineDiscount / grossLine) * 100).toFixed(4)) : 0,
      FinalOrderQuan: 0,
      FinalOrderQuan2: 0,
      // 0.9.19.25: keep Shaygan line description clean; do not copy invoice description/crmId to every line.
      LineItemDesc: line.lineDescription || '',
      Serials: Array.isArray(line.serials) ? line.serials.filter(Boolean).map((sn) => {
        const serialNumber = typeof sn === 'string' ? sn : (sn.serialNumber || sn.SerialNumber || '');
        return {
          SerialBodyId: Number((typeof sn === 'object' && (sn.serialBodyId || sn.SerialBodyId)) || 0),
          SerialHeaderGuId: (typeof sn === 'object' && (sn.serialHeaderGuid || sn.SerialHeaderGuId)) || ZERO_GUID,
          SerialNumber: String(serialNumber || '').trim(),
          LineItemGuid: ZERO_GUID,
          Cycle: 0,
          HeaderNote: '',
          BodyNote: '',
          GaranterAccountGuid: ZERO_GUID,
          GaranterJobGuid: ZERO_GUID,
          GaranteeStartDate: '',
          GaranteeTime: 0,
          UpdateKind: 0,
          GuId: (typeof sn === 'object' && (sn.guId || sn.GuId)) || ZERO_GUID,
          ExtraFields: []
        };
      }).filter(x => x.SerialNumber) : [],
      UpdateKind: 0,
      // Shaygan 9+ stored procedure CAS_AC_3009_N_Insert expects this parameter.
      // Keep it on line rows too because some Shaygan web-service builds map body-row fields to that proc.
      HasDuplicateTrackingCode: false,
      '@HasDuplicateTrackingCode': false
    };
  });
  const totalAmount = bodyRows.reduce((sum, x) => sum + Number(x.Amount || 0), 0);
  // 0.9.19.22: invoice extras/additions are stored in Shaygan Invoice.Expense.
  // Only positive rows are sent from CRM after admin allow-list validation.
  const expenseRows = Array.isArray(input.invoiceExtras) ? input.invoiceExtras
    .map((x, idx) => {
      const amount = Math.max(0, Number(x.amount || x.InvExpRowAmount || 0));
      const accountNumber = String(x.accountNumber || x.AccountNumber || '').trim();
      if (!accountNumber || amount <= 0) return null;
      return {
        InvExpRowId: 0,
        InvExpRowOrder: idx + 1,
        InvHeaderId: 0,
        AccountGuId: x.accountGuid || x.AccountGuId || '00000000-0000-0000-0000-000000000000',
        AccountNumber: accountNumber,
        AccountName: String(x.accountName || x.AccountName || '').trim(),
        InvExpRowDesc: String(x.description || x.InvExpRowDesc || x.accountName || x.AccountName || '').trim(),
        InvExpRowAmount: amount,
        CurrencyAbb1: 'ریال',
        Rate: Number(x.rate || x.Rate || 1) || 1,
        UpdateKind: 0,
        GuId: x.guId || x.GuId || '00000000-0000-0000-0000-000000000000',
        ExtraFields: []
      };
    }).filter(Boolean) : [];
  const expenseTotal = expenseRows.reduce((sum, x) => sum + Number(x.InvExpRowAmount || 0), 0);
  return {
    PutObject: [{
      Body: bodyRows,
      Expense: expenseRows,
      InvTyp: 2,
      InvHeaderId: 0,
      InvNo: Number(input.invoiceNumber),
      InvDescription: description,
      GeneralRef: String(input.generalRef || input.GeneralRef || '').trim(),
      InvDate: input.invDate || formatDate8(),
      InvPayDue: input.invDate || formatDate8(),
      AccountNumber: input.accountNumber,
      SAccountNumber: input.sAccountNumber,
      Rate: 1,
      DiscAmount: requestedHeaderDiscount,
      SourceTotalAmount: Math.max(0, totalAmount + expenseTotal),
      RelatedInvHeaderId: 0,
      InvHeaderIdRoot: 0,
      ControlCheck: false,
      Printed: true,
      HasDuplicateTrackingCode: false,
      '@HasDuplicateTrackingCode': false,
      DuplicateTrackingCode: false,
      FirstIssuerUsername: input.username || 'CRM',
      LastIssuerUsername: input.username || 'CRM',
      UpdateKind: 0
    }],
    Config: { ConnectionName: config.shayganConnectionName }
  };
}

async function putSaleInvoice(input) {
  if (config.stagingReadOnly) {
    return { ok:false, status:403, result:[], raw:null, error:'Operation disabled in staging read-only mode', operation:'shaygan.putSaleInvoice' };
  }
  return await put('/api/Invoice/Put', buildSaleInvoicePut(input));
}


function divi(a,b){return Math.floor(a/b)}
function jalaliToGregorian(jy,jm,jd){
  jy=Number(jy); jm=Number(jm); jd=Number(jd);
  jy += 1595;
  let days = -355668 + (365 * jy) + divi(jy,33)*8 + divi((jy%33)+3,4) + jd + (jm < 7 ? (jm-1)*31 : ((jm-7)*30)+186);
  let gy = 400 * divi(days,146097); days %= 146097;
  if (days > 36524) { gy += 100 * divi(--days,36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * divi(days,1461); days %= 1461;
  if (days > 365) { gy += divi(days-1,365); days = (days-1)%365; }
  let gd = days + 1;
  const sal_a = [0,31,((gy%4===0 && gy%100!==0)||gy%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  let gm=0; for(gm=1; gm<=12 && gd>sal_a[gm]; gm++) gd-=sal_a[gm];
  return [gy,gm,gd];
}
function date8ForShaygan(v){
  const x=String(v||'').replace(/[^0-9]/g,'').slice(0,8);
  if(!x || x.length!==8) return '';
  if(x.startsWith('13')||x.startsWith('14')){ const [gy,gm,gd]=jalaliToGregorian(x.slice(0,4),x.slice(4,6),x.slice(6,8)); return String(gy)+String(gm).padStart(2,'0')+String(gd).padStart(2,'0'); }
  return x;
}
function maybeDateRange(from='',to=''){
  const f=date8ForShaygan(from), t=date8ForShaygan(to||from);
  return (f||t) ? range(f||'', t||f||'') : range();
}
function rowDateJalali8(row){
  const v=row.Date||row.date||row.InvDate||row.DocDate||row.VouchDate||row.VoucherDate||'';
  const x=String(v||'');
  if(/^\d{8}$/.test(x)&&(x.startsWith('13')||x.startsWith('14'))) return x;
  // client will display; backend filtering is best-effort only
  return '';
}

function accountRangeFrom(v='') { return { From: String(v || ''), To: '', In: [] }; }
function accountRangeExact(v='') { const x = String(v || ''); return { From: x, To: x, In: [] }; }
function normIdentity(v='') { return String(v || '').trim().toLowerCase().replace(/[ي]/g,'ی').replace(/[ك]/g,'ک').replace(/\s+/g,' '); }
function statementIdentityMatches(result = [], requested = {}) {
  const reqNum = String(requested.accountNumber || '').trim();
  const reqGuid = String(requested.accountGuid || '').trim().toLowerCase();
  const reqName = normIdentity(requested.accountName || '');
  if (!reqNum && !reqGuid && !reqName) return { ok:true, reason:'no-requested-identity' };
  const top = Array.isArray(result) && result.length ? result[0] : {};
  const gotNum = String(top.AccountNumber || top.accountNumber || '').trim();
  const gotGuid = String(top.AccountGuId || top.AccountGuID || top.GuId || top.guid || '').trim().toLowerCase();
  const gotName = normIdentity(top.AccountName || top.accountName || '');
  if (reqGuid && gotGuid && reqGuid === gotGuid) return { ok:true, reason:'guid-match', gotNum, gotName, gotGuid };
  if (reqNum && gotNum && reqNum === gotNum) return { ok:true, reason:'number-match', gotNum, gotName, gotGuid };
  // If Shaygan ignores AccountGuId and returns a different wrapper account, reject it.
  // Returning a wrong account is worse than returning an empty diagnostic.
  return { ok:false, reason:'identity-mismatch', requestedNumber:reqNum, requestedGuid:reqGuid, requestedName:reqName, gotNum, gotGuid, gotName };
}
function statementRowDate8(row = {}) {
  const v = String(row.Date || row.date || row.InvDate || row.DocDate || row.VouchDate || row.VoucherDate || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10).replace(/-/g,'');
  const d = v.replace(/[^0-9]/g,'').slice(0,8);
  if (d.length !== 8) return '';
  return d.startsWith('13') || d.startsWith('14') ? date8ForShaygan(d) : d;
}
function flattenStatementResult(result = []) {
  const out = [];
  for (const acc of result || []) {
    const accountNumber = acc.AccountNumber || acc.accountNumber || '';
    const accountName = acc.AccountName || acc.accountName || '';
    const accountGuId = acc.AccountGuId || acc.AccountGuID || acc.GuId || acc.guid || '';
    const rows = Array.isArray(acc.AccountStatement) ? acc.AccountStatement : (acc.RowNo || acc.DebitAmount !== undefined || acc.CreditAmount !== undefined ? [acc] : []);
    for (const r of rows) {
      // Skip completely empty wrapper rows, but keep opening-balance rows.
      const hasMeaning = r.RowNo !== undefined || r.RowDesc || r.Description || r.DebitAmount !== undefined || r.CreditAmount !== undefined || r.Remain !== undefined || r.DocumentNumber !== undefined;
      if (!hasMeaning) continue;
      out.push({ ...r, InvNo:r.InvNo ?? r.InvoiceNumber ?? '', InvTyp:Number(r.InvTyp ?? r.InvoiceType ?? 0)||0, AccountNumber: r.AccountNumber || accountNumber, AccountName: r.AccountName || accountName, AccountGuId: r.AccountGuId || accountGuId });
    }
  }
  return out;
}
function filterStatementByDate(rows = [], dateFrom = '', dateTo = '') {
  const f = date8ForShaygan(dateFrom);
  const t = date8ForShaygan(dateTo || dateFrom);
  if (!f && !t) return rows;
  const from = f || '00000000';
  const to = t || f || '99999999';
  return rows.filter(r => {
    const d = statementRowDate8(r);
    return d && d >= from && d <= to;
  });
}
function statementSortKey(row = {}) {
  const d = statementRowDate8(row);
  const rowNo = Number(row.RowNo || row.rowNo || row.RowNumber || row.DocumentNumber || row.DocNo || 0) || 0;
  return `${d || '00000000'}:${String(rowNo).padStart(12,'0')}`;
}
function sortStatementRowsDesc(rows = []) {
  return [...(rows || [])].sort((a,b) => statementSortKey(b).localeCompare(statementSortKey(a)));
}

async function getAccountStatement(accountNumber, dateFrom = '', dateTo = '', accountGuid = '', accountName = '') {
  // Shaygan Account/GetStatement is identity-sensitive and has unusual paging rules:
  // - RowCount must be 1.
  // - Sort.From must be 0 or 1.
  // - Result[0] is an account wrapper and rows are inside AccountStatement[].
  // - If the domain is loose, Shaygan may return a different account. We must reject mismatches.
  const domains = [];
  function add(d, label){ domains.push({ domain:d, label }); }
  const emptyDate = range();
  const dateRange = maybeDateRange(dateFrom, dateTo);
  const rawDateRange = (dateFrom || dateTo) ? range(dateFrom || '', dateTo || dateFrom || '') : range();
  const requested = { accountNumber, accountGuid, accountName };

  // Exact ranges are intentional. Open-ended From-only ranges caused wrong account wrappers.
  if (accountGuid) {
    add({ AccountGuId: accountRangeExact(accountGuid), Date: emptyDate, AccountNumber: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountGuId exact(no date)');
    add({ AccountGuId: accountRangeExact(accountGuid), Date: dateRange, AccountNumber: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountGuId exact+Date(gregorian)');
    if (String(dateFrom||'').startsWith('14') || String(dateFrom||'').startsWith('13')) add({ AccountGuId: accountRangeExact(accountGuid), Date: rawDateRange, AccountNumber: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountGuId exact+Date(raw)');
  }

  if (accountNumber) {
    add({ AccountNumber: accountRangeExact(accountNumber), Date: emptyDate, AccountGuId: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountNumber exact(no date)');
    add({ AccountNumber: accountRangeExact(accountNumber), Date: dateRange, AccountGuId: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountNumber exact+Date(gregorian)');
    if (String(dateFrom||'').startsWith('14') || String(dateFrom||'').startsWith('13')) add({ AccountNumber: accountRangeExact(accountNumber), Date: rawDateRange, AccountGuId: range(), AccountCode: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountNumber exact+Date(raw)');
    add({ AccountCode: accountRangeExact(accountNumber), Date: emptyDate, AccountGuId: range(), AccountNumber: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountCode exact(no date)');
    add({ AccountCode: accountRangeExact(accountNumber), Date: dateRange, AccountGuId: range(), AccountNumber: range(), JobGuId: range(), DocNo: range(), Sort: sortRange('0') }, 'AccountCode exact+Date(gregorian)');
  }

  const diagnostics = [];
  let lastRaw = null;
  for (const attempt of domains) {
    const res = await post('/api/Account/GetStatement', attempt.domain, 0, 1, { maxRowCount: 1, timeoutMs: Math.min(config.shayganTimeoutMs || 15000, 9000) });
    lastRaw = res.raw;
    const idCheck = res.ok ? statementIdentityMatches(res.result, requested) : { ok:false, reason:'request-failed' };
    const flat = (res.ok && idCheck.ok) ? flattenStatementResult(res.result) : [];
    let filtered = (res.ok && idCheck.ok) ? filterStatementByDate(flat, dateFrom, dateTo) : [];
    filtered = sortStatementRowsDesc(filtered);
    if (!dateFrom && !dateTo) filtered = filtered.slice(0, 30);
    diagnostics.push({
      label: attempt.label,
      ok: res.ok,
      identityOk: !!idCheck.ok,
      identityReason: idCheck.reason || '',
      requestedNumber: String(accountNumber || ''),
      requestedGuid: String(accountGuid || ''),
      requestedName: String(accountName || ''),
      gotNumber: idCheck.gotNum || '',
      gotGuid: idCheck.gotGuid || '',
      gotName: idCheck.gotName || '',
      topCount: res.result.length,
      rawRows: flat.length,
      count: filtered.length,
      error: res.error || ''
    });
    if (res.ok && idCheck.ok && filtered.length) return { ok:true, list: filtered, result: filtered, raw: res.raw, error:'', domainUsed: attempt.label, diagnostics };
  }
  return { ok: true, list: [], result: [], error: '', diagnostics, raw: lastRaw };
}

function buildPurchaseInvoicePut(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const validItems = items.filter(x => x && x.itemCode && x.stockNumber && Number(x.quantity) > 0 && Number(x.price) >= 0);
  if (!validItems.length) throw new Error('purchase invoice items with stockNumber required');
  const descParts = [];
  if (input.supplierName) descParts.push(`تامین‌کننده: ${input.supplierName}`);
  if (input.purchaseDraftNo) descParts.push(`Draft: ${input.purchaseDraftNo}`);
  if (input.description) descParts.push(input.description);
  const description = descParts.join(' | ') || 'ثبت خرید از CRM';
  const bodyRows = validItems.map((line, idx) => {
    const amount = Number(line.quantity || 0) * Number(line.price || 0);
    return {
      LineItemId: 0,
      InvHeaderId: 0,
      LineItemOrder: idx + 1,
      ItemNumber: line.itemCode,
      ItemDescription: line.itemDescription || '',
      STNumber: line.stockNumber,
      STDesc: line.stockName || '',
      STGuId: line.stockGuid || ZERO_GUID,
      ItemGuId: line.itemGuid || ZERO_GUID,
      Quan: Number(line.quantity),
      Quan2: 0,
      Price: Number(line.price),
      Price2: 0,
      Amount: amount,
      CurRial: amount,
      Rial: amount,
      LineDiscAmount: 0,
      LineDiscPer: 0,
      FinalOrderQuan: 0,
      FinalOrderQuan2: 0,
      LineItemDesc: line.lineDescription || description,
      UpdateKind: 0,
      HasDuplicateTrackingCode: false,
      '@HasDuplicateTrackingCode': false
    };
  });
  const totalAmount = bodyRows.reduce((sum, x) => sum + Number(x.Amount || 0), 0);
  // 0.9.19.22: invoice extras/additions are stored in Shaygan Invoice.Expense.
  // Only positive rows are sent from CRM after admin allow-list validation.
  const expenseRows = Array.isArray(input.invoiceExtras) ? input.invoiceExtras
    .map((x, idx) => {
      const amount = Math.max(0, Number(x.amount || x.InvExpRowAmount || 0));
      const accountNumber = String(x.accountNumber || x.AccountNumber || '').trim();
      if (!accountNumber || amount <= 0) return null;
      return {
        InvExpRowId: 0,
        InvExpRowOrder: idx + 1,
        InvHeaderId: 0,
        AccountGuId: x.accountGuid || x.AccountGuId || '00000000-0000-0000-0000-000000000000',
        AccountNumber: accountNumber,
        AccountName: String(x.accountName || x.AccountName || '').trim(),
        InvExpRowDesc: String(x.description || x.InvExpRowDesc || x.accountName || x.AccountName || '').trim(),
        InvExpRowAmount: amount,
        CurrencyAbb1: 'ریال',
        Rate: Number(x.rate || x.Rate || 1) || 1,
        UpdateKind: 0,
        GuId: x.guId || x.GuId || '00000000-0000-0000-0000-000000000000',
        ExtraFields: []
      };
    }).filter(Boolean) : [];
  const expenseTotal = expenseRows.reduce((sum, x) => sum + Number(x.InvExpRowAmount || 0), 0);
  return {
    PutObject: [{
      Body: bodyRows,
      Expense: expenseRows,
      InvTyp: 3,
      InvHeaderId: 0,
      InvNo: Number(input.invoiceNumber || 0),
      InvDescription: description,
      GeneralRef: String(input.generalRef || input.GeneralRef || '').trim(),
      InvDate: input.invDate || formatDate8(),
      InvPayDue: input.invDate || formatDate8(),
      AccountNumber: input.supplierNumber,
      AccountGuId: input.supplierGuid || ZERO_GUID,
      SAccountNumber: input.sAccountNumber || '',
      Rate: 1,
      DiscAmount: 0,
      SourceTotalAmount: Math.max(0, totalAmount + expenseTotal),
      RelatedInvHeaderId: 0,
      InvHeaderIdRoot: 0,
      ControlCheck: false,
      Printed: false,
      HasDuplicateTrackingCode: false,
      '@HasDuplicateTrackingCode': false,
      DuplicateTrackingCode: false,
      FirstIssuerUsername: input.username || 'CRM',
      LastIssuerUsername: input.username || 'CRM',
      UpdateKind: 0
    }],
    Config: { ConnectionName: config.shayganConnectionName }
  };
}

async function putPurchaseInvoice(input) {
  if (config.stagingReadOnly) {
    return { ok:false, status:403, result:[], raw:null, error:'Operation disabled in staging read-only mode', operation:'shaygan.putPurchaseInvoice' };
  }
  return await put('/api/Invoice/Put', buildPurchaseInvoicePut(input));
}

module.exports = { searchAccounts, getAccountsPage, getStocks, getInventoryByItemCode, getInventoryPage, getKardexByItemCode, getItemsPage, getProductListPage, getInvoice, getInvoiceByGuid, getInvoicePageByDate, getInvoicePageByTypeRange, getInvoicePageByTypeNumberRange, getLastInvoiceNumber, getLastSaleInvoiceNumber, getLastPurchaseInvoiceNumber, putSaleInvoice, buildSaleInvoicePut, putPurchaseInvoice, buildPurchaseInvoicePut, formatDate8, getAccountStatement, getSerialsByItemStock };
