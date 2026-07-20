const http = require('http');
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const { config } = require('./lib/config');
const { connectMongo, initMongo } = require('./lib/mongo');
const { sendJson, sendText, collectBody, normalizeMobile, normalizeText } = require('./lib/http-utils');
const shaygan = require('./lib/shaygan');
const stockSleep = require('./lib/stock-sleep');
const purchaseSleep = require('./lib/purchase-sleep');
const saleSnapshot = require('./lib/sale-snapshot');
const time = require('./lib/time');
const { JobManager } = require('../dist/core/jobs/JobManager');
const { JobRegistry } = require('../dist/core/jobs/JobRegistry');
const { JobStatus } = require('../dist/core/jobs/JobStatus');
const { SupplierSleepJob } = require('../dist/jobs/SupplierSleepJob');
// 0.9.19.17→WS: SQL read module حذف شد — همه خواندن‌ها از WebService شایگان
// const shayganSql = require('./lib/shaygan-sql-read'); // REMOVED

const publicDir = path.join(process.cwd(), 'public');
const APP_VERSION = '0.9.19.59-supplier-sleep-operational-control';
const supplierSleepJobRegistry = new JobRegistry();
supplierSleepJobRegistry.register({ name:'supplier-sleep', version:1, factory:input=>new SupplierSleepJob(input) });
const supplierSleepJobManager = new JobManager(supplierSleepJobRegistry);

async function supplierSleepActiveJob(db){
  const now=new Date();
  const cutoff=new Date(now.getTime()-10*60*1000);
  await db.collection('appJobs').updateMany({type:{$in:['supplier-sleep-read-selected-invoices','supplier-sleep-build-selected']},status:{$in:['queued','running']},updatedAt:{$lt:cutoff}},{$set:{status:'failed',phase:'stale-recovered',finishedAt:now,updatedAt:now,error:'Job stale after heartbeat timeout; recovered automatically'}}).catch(()=>{});
  return db.collection('appJobs').findOne({type:{$in:['supplier-sleep-read-selected-invoices','supplier-sleep-build-selected']},status:{$in:['queued','running']},updatedAt:{$gte:cutoff}},{sort:{updatedAt:-1}});
}

function startSupplierSleepBackgroundJob({ db, jobId, operation, request, mapResult }){
  let serviceResult=null;
  const handle=supplierSleepJobManager.start('supplier-sleep',{ operation, db, request, service:purchaseSleep, onResult:result=>{serviceResult=result;} });
  const startedAt=new Date();
  const runningUpdate=db.collection('appJobs').updateOne({jobId},{$set:{status:'running',phase:operation==='read-selected-invoices'?'read-selected-purchase-invoices':'build-selected-snapshot',startedAt,updatedAt:startedAt,heartbeatAt:startedAt}}).catch(()=>{});
  const heartbeatTimer=setInterval(()=>{
    const snapshot=handle.snapshot();
    db.collection('appJobs').updateOne({jobId},{$set:{heartbeatAt:snapshot.heartbeatAt,updatedAt:new Date(),phase:snapshot.progress.phase}}).catch(()=>{});
  },15000);
  heartbeatTimer.unref?.();
  handle.completion.then(async snapshot=>{
    clearInterval(heartbeatTimer);
    await runningUpdate;
    const completed=snapshot.status===JobStatus.Completed && serviceResult?.ok!==false;
    const cancelled=snapshot.status===JobStatus.Cancelled;
    const update={
      status:completed?'completed':(cancelled?'cancelled':'failed'),phase:completed?'done':snapshot.progress.phase,
      finishedAt:new Date(),updatedAt:new Date(),heartbeatAt:snapshot.heartbeatAt,
      error:snapshot.error?.message||serviceResult?.error||''
    };
    if(serviceResult) update.result=mapResult(serviceResult);
    return db.collection('appJobs').updateOne({jobId},{$set:update}).catch(()=>{});
  }).catch(()=>{ clearInterval(heartbeatTimer); });
  return handle;
}

// CHANGELOG 0.9.19.17-ws-no-sql-audited:
// FIX-C1: Removed remaining SQL configuration/dependency exposure and corrected misleading SQL source labels.
// FIX-C2: Locked dangerous/admin endpoints (/api/mongo/init, /api/shaygan/sql-health) behind admin and /api/shaygan/health behind login.
// FIX-C3: Stock-out board events now evaluate inventory only across active warehouses and use WebService source labels.
// FIX-W1: Seller profit source label corrected to WebService Kardex FIFO, not SQL.
// FIX-W2: Supplier aging confidence/source labels corrected to WebService approximation.

function esc(v) {
  return String(v ?? '').replace(/[&<>\"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

function fmtRial(v) {
  const n = Number(v || 0);
  return n.toLocaleString('fa-IR');
}
function jalaliSafe(v) {
  return String(v || '').slice(0, 10);
}

function jalaliToGregorianLocal(jy, jm, jd) {
  jy = Number(jy); jm = Number(jm); jd = Number(jd);
  jy += 1595;
  let days = -355668 + (365 * jy) + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0,31,((gy%4===0 && gy%100!==0)||gy%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  let gm=1; while (gm<=12 && gd>sal[gm]) gd-=sal[gm++];
  return [gy,gm,gd];
}
function normalizeReportDate(v='', end=false) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + (end ? 'T23:59:59' : 'T00:00:00');
  const x = raw.replace(/[^0-9]/g, '');
  if (x.length !== 8) return '';
  let y=Number(x.slice(0,4)), m=Number(x.slice(4,6)), d=Number(x.slice(6,8));
  if (y < 1700) [y,m,d] = jalaliToGregorianLocal(y,m,d);
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}${end?'T23:59:59':'T00:00:00'}`;
}
function parseMoneyInput(v, unit='rial') {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const raw = String(v).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/تومان|toman/i.test(raw) || unit === 'toman') return n * 10;
  return n;
}
function calcCommission({ fifoProfit=0, commissionRate=0.18, withoutLeadCount=0, leadPenaltyRial=0 } = {}) {
  const raw = Math.round(Math.max(0, Number(fifoProfit||0)) * Number(commissionRate||0));
  const leadPenalty = Math.max(0, Number(withoutLeadCount||0)) * Math.max(0, Number(leadPenaltyRial||0));
  const final = Math.max(0, raw - leadPenalty);
  return { rawCommission:raw, leadPenalty, finalCommission:final };
}

// 0.9.19.22: Sale invoice allowed extras/additions (Expense[]) governance.
const SALE_ALLOWED_EXTRAS_KEY = 'sale.allowedInvoiceExtras';
function normalizeAllowedInvoiceExtra(x = {}) {
  const accountNumber = String(x.accountNumber || x.AccountNumber || '').trim();
  const accountName = String(x.accountName || x.AccountName || '').trim();
  const accountGuid = String(x.accountGuid || x.AccountGuId || x.AccountGUID || x.guId || x.GuId || '').trim();
  const type = String(x.type || x.kind || 'extra').trim() || 'extra';
  return { accountNumber, accountName, accountGuid, type, isActive: x.isActive !== false };
}
async function getAllowedSaleInvoiceExtras(db) {
  const doc = await db.collection('settings').findOne({ key: SALE_ALLOWED_EXTRAS_KEY });
  return (Array.isArray(doc?.value) ? doc.value : []).map(normalizeAllowedInvoiceExtra).filter(x => x.accountNumber && x.isActive !== false);
}
function normalizeRequestedInvoiceExtras(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((x, idx) => {
    const accountNumber = String(x.accountNumber || x.AccountNumber || '').trim();
    const amountRaw = x.amount ?? x.InvExpRowAmount ?? x.value ?? 0;
    const amount = Math.max(0, Number(parseMoneyInput(amountRaw) ?? 0));
    return { accountNumber, amount, order: idx + 1, description: String(x.description || x.InvExpRowDesc || '').trim() };
  }).filter(x => x.accountNumber && x.amount > 0);
}
async function validateSaleInvoiceExtras(db, requested = []) {
  const allowed = await getAllowedSaleInvoiceExtras(db);
  const byNo = new Map(allowed.map(x => [String(x.accountNumber), x]));
  const cleaned = [];
  for (const r of normalizeRequestedInvoiceExtras(requested)) {
    const a = byNo.get(String(r.accountNumber));
    if (!a) throw new Error(`حساب افزودنی فاکتور مجاز نیست: ${r.accountNumber}`);
    cleaned.push({
      accountNumber: a.accountNumber,
      accountName: a.accountName,
      accountGuid: a.accountGuid,
      type: a.type,
      amount: r.amount,
      description: r.description || a.accountName,
      rate: 1
    });
  }
  return cleaned;
}
function saleInvoiceExtrasTotal(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, x) => sum + Math.max(0, Number(x.amount || x.InvExpRowAmount || 0)), 0);
}

function normalizeManualLeadId(v = '') {
  return String(v || '')
    .trim()
    .replace(/[‌‏‪-‮]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}
function manualLeadMeta(body = {}, mapping = {}, user = {}) {
  const leadId = normalizeManualLeadId(body.leadId || body.leadCode || body.leadID || '');
  const withoutLead = !leadId;
  return {
    leadId,
    entryMode: 'manual',
    invoiceWithoutLead: withoutLead,
    leadPenaltyEligible: withoutLead,
    closerUsername: mapping.username || user.username || body.mappingUsername || body.username || '',
    closerFullName: mapping.fullName || user.fullName || body.username || '',
    closerStoreName: mapping.storeName || '',
    capturedAt: new Date()
  };
}

function getLeadIdBaseUrl() {
  return String(process.env.LEAD_ID_BASE_URL || process.env.LEAD_BASE_URL || '').trim().replace(/\/+$/, '');
}
async function postLeadIdCloseSale(payload = {}) {
  const base = getLeadIdBaseUrl();
  const leadCode = normalizeManualLeadId(payload.leadId || payload.leadCode || '');
  if (!base || !leadCode) return { ok:false, skipped:true, status:'not_required', error: !base ? 'LEAD_ID_BASE_URL is empty' : 'leadId is empty' };
  const timeoutMs = Number(process.env.LEAD_ID_TIMEOUT_MS || 2500);
  const apiKey = String(process.env.LEAD_ID_API_KEY || process.env.LEAD_API_KEY || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/integration/lead/${encodeURIComponent(leadCode)}/close-sale`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', ...(apiKey ? { 'x-lead-api-key': apiKey } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok || !json || !json.ok) return { ok:false, status:'failed', httpStatus:res.status, error: json?.error || text.slice(0, 500) || `HTTP ${res.status}`, response: json || text };
    return { ok:true, status:'success', httpStatus:res.status, response:json };
  } catch (e) {
    return { ok:false, status:'failed', error:String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function diviPrint(a,b){ return Math.floor(a/b); }
function gregorianToJalali(gy, gm, gd) {
  gy = Number(gy); gm = Number(gm); gd = Number(gd);
  const g_d_m = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy = (gy <= 1600) ? 0 : 979;
  gy -= (gy <= 1600) ? 621 : 1600;
  let gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = (365 * gy) + diviPrint(gy2 + 3, 4) - diviPrint(gy2 + 99, 100) + diviPrint(gy2 + 399, 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * diviPrint(days, 12053);
  days %= 12053;
  jy += 4 * diviPrint(days, 1461);
  days %= 1461;
  if (days > 365) { jy += diviPrint(days - 1, 365); days = (days - 1) % 365; }
  const jm = (days < 186) ? 1 + diviPrint(days, 31) : 7 + diviPrint(days - 186, 30);
  const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
  return [jy, jm, jd];
}
function toJalaliDatePrint(v) {
  const x = String(v || '').trim();
  let m = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m && /^\d{8}$/.test(x)) m = [x, x.slice(0,4), x.slice(4,6), x.slice(6,8)];
  if (!m) return x;
  if (String(m[1]).startsWith('13') || String(m[1]).startsWith('14')) return `${m[1]}/${m[2]}/${m[3]}`;
  const [jy,jm,jd] = gregorianToJalali(m[1], m[2], m[3]);
  return `${jy}/${String(jm).padStart(2,'0')}/${String(jd).padStart(2,'0')}`;
}
function extractSerialText(line) {
  const arr = Array.isArray(line?.Serials) ? line.Serials : [];
  const serials = arr.map(s => s.SerialNumber || s.serialNumber || s.Serial || '').filter(Boolean);
  if (line?.SerialNumber) serials.push(line.SerialNumber);
  if (line?.DeviceSerialNumber) serials.push(line.DeviceSerialNumber);
  return [...new Set(serials.map(String))].join('، ');
}
async function resolveStoreNameForInvoice(inv = {}) {
  try {
    const db = await connectMongo();
    const acc = String(inv.AccountNumber || '').trim();
    const sacc = String(inv.SAccountNumber || '').trim();
    const q = [];
    if (acc && sacc) q.push({ cashboxAccountNumber: acc, employeeAccountNumber: sacc, isActive:{ $ne:false } });
    if (acc) q.push({ cashboxAccountNumber: acc, isActive:{ $ne:false } });
    if (sacc) q.push({ employeeAccountNumber: sacc, isActive:{ $ne:false } });
    let mapping = null;
    for (const cond of q) { mapping = await db.collection('userShayganMappings').findOne(cond); if (mapping?.storeName) break; }
    return mapping?.storeName || mapping?.fullName || 'مشهد کالا';
  } catch(e) { return 'مشهد کالا'; }
}
function purchaseStatusFa(status='draft') {
  return ({ draft:'پیش‌نویس', issuing:'در حال ثبت در شایگان', issued:'ثبت‌شده در شایگان', failed:'خطای ثبت', pending_verify:'در انتظار بررسی', cancelled:'لغوشده' }[String(status||'draft')] || String(status||'draft'));
}
function purchaseDraftPrintHtml(draft) {
  const items = Array.isArray(draft.items) ? draft.items : [];
  const rows = items.map((x,i) => `<tr><td>${i+1}</td><td>${esc(x.itemCode||'')}</td><td>${esc(x.itemDescription||'')}</td><td>${esc(x.stockNumber||'')}</td><td>${esc(x.stockName||'')}</td><td>${fmtRial(x.quantity||0)}</td><td>${fmtRial(x.price||0)}</td><td>${fmtRial(Number(x.quantity||0)*Number(x.price||0))}</td></tr>`).join('');
  const totalQty = items.reduce((s,x)=>s+Number(x.quantity||0),0);
  const total = items.reduce((s,x)=>s+Number(x.quantity||0)*Number(x.price||0),0);
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>چاپ پیش‌نویس خرید ${esc(draft.purchaseDraftNo||'')}</title><style>body{font-family:tahoma,arial;margin:24px;color:#111}.head{display:flex;justify-content:space-between;border-bottom:2px solid #1d4ed8;padding-bottom:10px;margin-bottom:16px}.brand{font-size:22px;font-weight:bold;color:#1d4ed8}.meta{line-height:2}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{border:1px solid #999;padding:7px;text-align:right;font-size:12px}th{background:#eaf2ff}.sum{margin-top:15px;font-weight:bold}.print{margin-bottom:12px}@media print{.print{display:none}}</style></head><body><button class="print" onclick="window.print()">چاپ</button><div class="head"><div><div class="brand">مشهد کالا</div><div>پیش‌نویس فاکتور خرید</div></div><div class="meta"><div>شماره پیش‌نویس: ${esc(draft.purchaseDraftNo||'')}</div><div>وضعیت: ${esc(purchaseStatusFa(draft.status))}</div><div>شماره شایگان: ${esc(draft.shayganInvoiceNumber||'')}</div><div>تاریخ: ${esc(jalaliSafe(draft.createdAt))}</div></div></div><div class="meta"><div>تأمین‌کننده: ${esc(draft.supplierNumber||'')} - ${esc(draft.supplierName||'')}</div><div>کاربر ثبت‌کننده: ${esc(draft.createdByName||draft.createdBy||'')}</div><div>توضیحات: ${esc(draft.description||'')}</div></div><table><thead><tr><th>#</th><th>کد کالا</th><th>نام کالا</th><th>کد انبار</th><th>انبار</th><th>تعداد</th><th>قیمت واحد - ریال</th><th>مبلغ - ریال</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">جمع تعداد: ${fmtRial(totalQty)} | جمع کل: ${fmtRial(total)} ریال</div></body></html>`;
}
function purchaseInvoicePrintHtml(inv) {
  const items = Array.isArray(inv.Body) ? inv.Body : [];
  const rows = items.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.ItemNumber||'')}</td><td>${esc(x.ItemDescription||'')}</td><td>${esc(x.STNumber||'')}</td><td>${esc(x.STDesc||'')}</td><td>${fmtRial(x.Quan||0)}</td><td>${fmtRial(x.Price||0)}</td><td>${fmtRial(x.Amount||0)}</td></tr>`).join('');
  const totalQty = items.reduce((s,x)=>s+Number(x.Quan||0),0);
  const total = items.reduce((s,x)=>s+Number(x.Amount||0),0);
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>چاپ فاکتور خرید ${esc(inv.InvNo||'')}</title><style>body{font-family:tahoma,arial;margin:24px;color:#111}.head{display:flex;justify-content:space-between;border-bottom:2px solid #1d4ed8;padding-bottom:10px;margin-bottom:16px}.brand{font-size:22px;font-weight:bold;color:#1d4ed8}.meta{line-height:2}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{border:1px solid #999;padding:7px;text-align:right;font-size:12px}th{background:#eaf2ff}.sum{margin-top:15px;font-weight:bold}.print{margin-bottom:12px}@media print{.print{display:none}}</style></head><body><button class="print" onclick="window.print()">چاپ</button><div class="head"><div><div class="brand">مشهد کالا</div><div>فاکتور خرید ثبت‌شده در شایگان</div></div><div class="meta"><div>شماره شایگان: ${esc(inv.InvNo||'')}</div><div>نوع: ${esc(inv.InvTyp||'')}</div><div>تاریخ: ${esc(inv.InvDate||'')}</div><div>GUID: ${esc(inv.GuId||'')}</div></div></div><div class="meta"><div>تأمین‌کننده: ${esc(inv.AccountNumber||'')} - ${esc(inv.AccountName||'')}</div><div>ثبت‌کننده: ${esc(inv.FirstIssuerUsername||'')}</div><div>توضیحات: ${esc(inv.InvDescription||'')}</div></div><table><thead><tr><th>#</th><th>کد کالا</th><th>نام کالا</th><th>کد انبار</th><th>انبار</th><th>تعداد</th><th>قیمت واحد - ریال</th><th>مبلغ - ریال</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">جمع تعداد: ${fmtRial(totalQty)} | جمع کل: ${fmtRial(total)} ریال</div></body></html>`;
}


const sessions = new Map();
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

async function normalizeUserLinks(db, username) {
  username = String(username || '').trim();
  if (!username) return { mappings:0, access:0 };
  const maps = await db.collection('userShayganMappings').find({ username }).sort({ updatedAt:-1, _id:-1 }).toArray();
  let keptMap = null;
  if (maps.length) {
    keptMap = maps.find(m => m.isActive !== false && m.cashboxAccountNumber && m.employeeAccountNumber) || maps.find(m => m.isActive !== false) || maps[0];
    await db.collection('userShayganMappings').deleteMany({ username, _id:{ $ne: keptMap._id } });
  }
  const accesses = await db.collection('userAccountAccesses').find({ username }).sort({ updatedAt:-1, _id:-1 }).toArray();
  const seen = new Set();
  let accessDeleted = 0;
  for (const a of accesses) {
    const key = String(a.accountNumber || '').trim();
    if (!key || seen.has(key)) { await db.collection('userAccountAccesses').deleteOne({ _id:a._id }); accessDeleted++; }
    else seen.add(key);
  }
  return { mappings: Math.max(0, maps.length - (keptMap ? 1 : 0)), access: accessDeleted };
}

async function renameUserLinksSafely(db, originalUsername, username, fullName, role) {
  originalUsername = String(originalUsername || '').trim();
  username = String(username || '').trim();
  if (!username) return;
  if (originalUsername && originalUsername !== username) {
    const oldMaps = await db.collection('userShayganMappings').find({ username: originalUsername }).sort({ updatedAt:-1, _id:-1 }).toArray();
    const targetMaps = await db.collection('userShayganMappings').find({ username }).toArray();
    if (targetMaps.length) await db.collection('userShayganMappings').deleteMany({ username }); // orphan cleanup; /api/users already blocks real duplicate users
    if (oldMaps.length) {
      const primary = oldMaps.find(m => m.isActive !== false && m.cashboxAccountNumber && m.employeeAccountNumber) || oldMaps.find(m => m.isActive !== false) || oldMaps[0];
      await db.collection('userShayganMappings').updateOne({ _id: primary._id }, { $set:{ username, fullName, role, updatedAt:new Date() } });
      await db.collection('userShayganMappings').deleteMany({ username: originalUsername });
    }
    await db.collection('userAccountAccesses').deleteMany({ username }); // orphan cleanup before moving old accesses
    await db.collection('userAccountAccesses').updateMany({ username: originalUsername }, { $set:{ username, updatedAt:new Date() } });
  }
  await db.collection('userShayganMappings').updateOne(
    { username },
    { $setOnInsert: { username, fullName, role, storeName:'', cashboxAccountNumber:'', employeeAccountNumber:'', allowedAccountNumbers:[], isActive:true, createdAt:new Date() }, $set:{ fullName, role, updatedAt:new Date() } },
    { upsert:true }
  );
  await normalizeUserLinks(db, username);
}


async function userIssuedActivityStats(db, username) {
  username = String(username || '').trim();
  if (!username) return { issuedCount:0, hasIssued:false };
  const q = { $or: [
    { mappingUsername: username },
    { username: username },
    { user: username },
    { createdBy: username },
    { convertedBy: username },
    { 'mapping.username': username },
    { 'request.username': username },
    { 'request.createdBy': username },
    { 'request.mappingUsername': username }
  ] };
  const [audit, locks, reservations, proformas] = await Promise.all([
    db.collection('invoiceAuditLogs').countDocuments({ ...q, ok:true }).catch(()=>0),
    db.collection('saleIssueLocks').countDocuments({ status:'issued', $or:[ { 'mapping.username': username }, { mappingUsername: username }, { username: username } ] }).catch(()=>0),
    db.collection('invoiceReservations').countDocuments({ status:'used', mappingUsername: username }).catch(()=>0),
    db.collection('proformas').countDocuments({ status:'converted', $or:[ { createdBy: username }, { convertedBy: username }, { mappingUsername: username } ] }).catch(()=>0)
  ]);
  const issuedCount = Number(audit||0) + Number(locks||0) + Number(reservations||0) + Number(proformas||0);
  return { issuedCount, hasIssued: issuedCount > 0 };
}

function onlyAllowedLockedUserChange(existing, body) {
  // Users with issued invoices must keep identity/username/role/mapping stable.
  // Admin is still allowed to reset password and activate/deactivate the user.
  return existing &&
    String(body.username || '').trim() === String(existing.username || '').trim() &&
    String(body.firstName || '').trim() === String(existing.firstName || '').trim() &&
    String(body.lastName || '').trim() === String(existing.lastName || '').trim() &&
    String(body.role || 'seller') === String(existing.role || 'seller') &&
    normalizeMobile(body.mobile || '') === normalizeMobile(existing.mobile || '');
}

function makeSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user, createdAt: Date.now(), lastSeenAt: Date.now() });
  return token;
}
function getSession(req) {
  const token = parseCookies(req).MKCRM_SESSION;
  if (!token) return null;
  const s = sessions.get(token);
  if (s) s.lastSeenAt = Date.now();
  return s || null;
}
function clearSession(req, res) {
  const token = parseCookies(req).MKCRM_SESSION;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'MKCRM_SESSION=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `MKCRM_SESSION=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
}
function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.json' ? 'application/json; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
}

async function applyFiscalDatabaseSetting() {
  // 0.9.19.17→WS: fiscal DB selection فقط در MongoDB ذخیره می‌شود؛ SQL حذف شد
}

async function ensureInit() {
  try { await initMongo(); } catch (e) { console.error('Mongo init warning:', e.message); }
  await applyFiscalDatabaseSetting();
}

function extractQuery(url) {
  const u = new URL(url, 'http://127.0.0.1');
  return { pathname: u.pathname, query: Object.fromEntries(u.searchParams.entries()) };
}

// 0.9.19.3: Active warehouses governance restored for SQL-read inventory/kardex/aging.
// Empty list means unrestricted fallback to avoid blocking operations before admin configuration.
function extractStockNumber(row = {}) {
  return String(row.stockNumber || row.STNumber || row.StoreNumber || row.StockNumber || row.raw?.StoreNumber || row.raw?.STNumber || '').trim();
}
async function getActiveWarehouseNumbers(db) {
  try {
    const doc = await db.collection('settings').findOne({ key: 'inventory.activeWarehouseNumbers' });
    const v = doc ? doc.value : [];
    const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[،,\s]+/) : []);
    return [...new Set(arr.map(x => String(x || '').trim()).filter(Boolean))];
  } catch (_) { return []; }
}
function activeWarehouseSet(list = []) {
  const arr = (list || []).map(x => String(x || '').trim()).filter(Boolean);
  return arr.length ? new Set(arr) : null;
}
function filterRowsByActiveWarehouses(rows = [], activeList = []) {
  const set = activeWarehouseSet(activeList);
  if (!set) return rows || [];
  return (rows || []).filter(x => set.has(extractStockNumber(x)));
}
function isWarehouseAllowed(stockNumber = '', activeList = []) {
  const set = activeWarehouseSet(activeList);
  if (!set) return true;
  return set.has(String(stockNumber || '').trim());
}
async function getActiveWarehouseNumbersFromDb() {
  const db = await connectMongo();
  return await getActiveWarehouseNumbers(db);
}




const ROLE_PERMISSIONS = {
  admin: 'all',
  seller: ['dashboard','sale','proforma','stocks','cardex','turnover','customers','leads','reservations','tablo'],
  accounting: ['dashboard','sale','proforma','proforma-list','buy','purchase-drafts','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','supplier-aging','stock-sleep','seller-profit','reports','app-logs','tablo'],
  warehouse: ['dashboard','sale','proforma','proforma-list','buy','purchase-drafts','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','reports','app-logs','tablo'],
  purchase: ['dashboard','sale','proforma','proforma-list','buy','purchase-drafts','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','supplier-aging','stock-sleep','seller-profit','reports','app-logs','tablo'],
  seller_buyer: ['dashboard','sale','proforma','proforma-list','buy','purchase-drafts','stocks','cardex','turnover','customers','leads','reservations','tablo']
};
function currentUser(req) {
  const s = getSession(req);
  return s ? s.user : null;
}
function roleOf(req) {
  return String(currentUser(req)?.role || '').trim() || 'guest';
}
function isAdmin(req) { return roleOf(req) === 'admin'; }
function canPageRole(role, page) {
  if (role === 'admin') return true;
  const allowed = ROLE_PERMISSIONS[role] || [];
  return allowed.includes(page);
}
function deny(res, msg='دسترسی شما به این بخش مجاز نیست') {
  return sendJson(res, 403, { ok:false, error: msg });
}
function needLogin(req, res) {
  if (currentUser(req)) return true;
  sendJson(res, 401, { ok:false, error:'برای دسترسی باید وارد شوید' });
  return false;
}
function requireRole(req, res, roles) {
  if (!needLogin(req, res)) return false;
  if (isAdmin(req)) return true;
  const role = roleOf(req);
  if (roles.includes(role)) return true;
  deny(res);
  return false;
}
function requirePage(req, res, page) {
  if (!needLogin(req, res)) return false;
  if (canPageRole(roleOf(req), page)) return true;
  deny(res);
  return false;
}

function canUsePurchase(req, res) {
  if (!needLogin(req, res)) return false;
  const u = currentUser(req) || {};
  if (['admin','accounting','warehouse','purchase','seller_buyer'].includes(String(u.role))) return true;
  if (String(u.role) === 'seller' && u.canPurchase === true) return true;
  deny(res, 'دسترسی خرید برای این کاربر فعال نیست');
  return false;
}

function canUseSalesFlow(req, res) {
  if (!needLogin(req, res)) return false;
  const role = String(roleOf(req));
  if (['admin','seller','seller_buyer','accounting','warehouse','purchase'].includes(role)) return true;
  deny(res, 'دسترسی صدور فاکتور/پیش‌فاکتور برای این کاربر فعال نیست');
  return false;
}
function canUseSupplierAging(req, res) {
  if (!needLogin(req, res)) return false;
  const role = String(roleOf(req));
  if (['admin','accounting','purchase'].includes(role)) return true;
  deny(res, 'دسترسی خواب کالا/تأمین‌کننده فقط برای مدیر، حسابداری و بازرگانی مجاز است');
  return false;
}
function canUseSellerPerformance(req, res) {
  if (!needLogin(req, res)) return false;
  const role = String(roleOf(req));
  if (['admin','accounting','purchase'].includes(role)) return true;
  deny(res, 'دسترسی عملکرد فروشنده فقط برای مدیر، حسابداری و بازرگانی مجاز است');
  return false;
}


function normalizeDate8Input(v='') {
  const x = String(v || '').replace(/[^0-9]/g, '').slice(0, 8);
  return x.length === 8 ? x : '';
}

function normalizeFa(v = '') {
  return normalizeText(v)
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/‌/g, ' ')
    .replace(/[_\-\/\|.,؛:()\[\]{}+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokensOf(q) {
  return normalizeFa(q)
    .replace(/[^0-9a-zA-Zآ-ی]+/g,' ')
    .split(/\s+/).map(x=>x.trim()).filter(Boolean);
}
function matchTokens(searchText, tokens) {
  const hay = normalizeFa(searchText);
  return tokens.every(t => hay.includes(t));
}
function scoreMatch(searchText, tokens, itemCode = '') {
  const hay = normalizeFa(searchText);
  const code = normalizeFa(itemCode);
  const uniqueTokens = [...new Set(tokens.map(normalizeFa).filter(Boolean))];
  if (!uniqueTokens.length) return 0;
  if (!uniqueTokens.every(t => hay.includes(t) || code.includes(t))) return -Infinity;

  // Order-independent scoring: "60 موذنی" and "موذنی 60" must return the same candidates.
  let score = 0;
  const qCanonical = uniqueTokens.slice().sort().join(' ');
  const hayWords = hay.split(/\s+/).filter(Boolean);
  const codeWords = code.split(/\s+/).filter(Boolean);
  const hayCanonical = hayWords.slice().sort().join(' ');
  const codeCanonical = codeWords.slice().sort().join(' ');

  if (code === qCanonical || codeCanonical === qCanonical) score += 10000;
  if (hayCanonical.includes(qCanonical)) score += 2500;

  for (const t of uniqueTokens) {
    const idxHay = hay.indexOf(t);
    const idxCode = code.indexOf(t);
    const idx = idxCode >= 0 ? idxCode : idxHay;
    if (idxCode === 0) score += 1200;
    else if (idxCode > 0) score += 700;
    if (idxHay === 0) score += 800;
    else if (idxHay > 0) score += Math.max(0, 350 - idxHay);
    if (hayWords.includes(t) || codeWords.includes(t)) score += 250;
    if (idx >= 0) score += Math.max(0, 120 - idx);
  }

  // Prefer compact, more specific names but do not depend on token order.
  score -= Math.min(hay.length, 400) / 20;
  return score;
}
function rowSearchText(x) { return `${x.itemCode||''} ${x.itemDescription||''} ${x.stockNumber||''} ${x.stockName||''}`; }
function toOldStockRow(x, idx=0) {
  return {
    ItemId: x.itemCode || idx,
    ItemCode: x.itemCode,
    ItemDesc: x.itemDescription,
    RemainQ: Number(x.quantity || 0),
    Price: Number(x.averageCost || 0),
    STNumber: x.stockNumber,
    StDesc: x.stockName,
    STGuId: x.stockGuid,
    ItemGuId: x.itemGuid,
    raw: x.raw || x
  };
}
function toProductNameRow(x, idx=0) {
  return { ItemId: x.itemCode || idx, ItemCode: x.itemCode, ItemDesc: x.itemDescription, ItemGuId: x.itemGuid, raw: x.raw || x };
}

async function upsertInventoryRows(db, rows, meta = {}) {
  // 0.9.19.52: unified positive-evidence upsert.
  // Any positive row from Global, Stock-filter, Live item or Kardex is preserved.
  // Auto sync sources are collectors/reconcilers; they are not allowed to erase positive evidence.
  const now = new Date();
  let arr = (rows || []).filter(x => x && x.itemCode && x.stockNumber && Number(x.quantity ?? x.Quantity1 ?? 0) > 0);
  // 0.9.19.53: after a successful local sale deduction, auto/stock sync must not immediately revive
  // the same item-stock from a stale WebService response. Exact live item refresh can still verify/revive.
  const sourceProbe = String(meta.source || arr[0]?.syncSource || arr[0]?.refreshSource || arr[0]?.source || '').toLowerCase();
  const isAutoPositiveSource = /auto|global|getremain|stock-filter|reconciliation|inventory-stock/.test(sourceProbe) && !/live|exact|item-refresh|kardex|debug/.test(sourceProbe);
  if (isAutoPositiveSource && arr.length) {
    const keys = arr.map(x => ({ itemCode:String(x.itemCode||'').trim(), stockNumber:String(x.stockNumber||'').trim() })).filter(x=>x.itemCode&&x.stockNumber);
    const existing = await db.collection('itemInventoryCatalog').find({ $or:keys.slice(0,150).map(k=>({ itemCode:k.itemCode, stockNumber:k.stockNumber })) }, { projection:{ itemCode:1, stockNumber:1, quantity:1, pendingShayganConfirm:1, lastLocalSaleDeductAt:1 } }).toArray().catch(()=>[]);
    const blocked = new Set();
    const ttlMs = Number(process.env.LOCAL_SALE_DEDUCT_PROTECT_MS || 30*60*1000);
    for (const e of existing) {
      const t = e.lastLocalSaleDeductAt ? new Date(e.lastLocalSaleDeductAt).getTime() : 0;
      if (e.pendingShayganConfirm === true && Number(e.quantity||0) <= 0 && t && (Date.now()-t) <= ttlMs) blocked.add(`${e.itemCode}::${e.stockNumber}`);
    }
    if (blocked.size) {
      const before = arr.length;
      arr = arr.filter(x => !blocked.has(`${String(x.itemCode||'').trim()}::${String(x.stockNumber||'').trim()}`));
      await db.collection('appLogs').insertOne({ type:'inventory_auto_positive_skipped_after_local_sale_deduct', skipped:before-arr.length, source:sourceProbe, at:now }).catch(()=>{});
    }
  }
  const ops = arr.map(x => {
    const searchText = normalizeFa(rowSearchText(x));
    const srcRaw = String(x.syncSource || x.refreshSource || x.source || meta.source || 'inventory-positive-evidence').trim();
    const src = srcRaw || 'inventory-positive-evidence';
    const set = { ...x, searchText, syncedAt: now, updatedAt: now, lastPositiveSeenAt: now, inventoryConfidence: x.inventoryConfidence || 'positive-evidence' };
    if (/global/i.test(src)) { set.lastGlobalSeenAt = now; set.globalSyncBatchId = x.syncBatchId || meta.batchId || ''; }
    if (/stock|warehouse/i.test(src)) { set.lastStockSeenAt = now; set.stockSyncBatchId = x.syncBatchId || meta.batchId || ''; }
    if (/live|refresh|kardex|item/i.test(src)) { set.lastLiveVerifiedAt = now; set.liveVerifyReason = x.refreshReason || meta.reason || src; }
    set.missingInGlobalSync = false;
    set.missingInStockSync = false;
    set.needsLiveVerify = false;
    set.protectedFromAutoSyncStale = false;
    return { updateOne: { filter: { itemCode: x.itemCode, stockNumber: x.stockNumber }, update: { $set: set, $addToSet: { sourceEvidence: src } }, upsert: true } };
  });
  if (ops.length) await db.collection('itemInventoryCatalog').bulkWrite(ops, { ordered:false }).catch(()=>{});
  const itemMap = new Map();
  arr.forEach(x => { if (x.itemCode && !itemMap.has(x.itemCode)) itemMap.set(x.itemCode, x); });
  const itemOps = [...itemMap.values()].map(x => ({ updateOne: { filter: { itemCode: x.itemCode }, update: { $set: { itemCode:x.itemCode, itemDescription:x.itemDescription, itemGuid:x.itemGuid, searchText: normalizeFa(`${x.itemCode} ${x.itemDescription}`), syncedAt: now, updatedAt: now } }, upsert:true } }));
  if (itemOps.length) await db.collection('itemCatalog').bulkWrite(itemOps, { ordered:false }).catch(()=>{});
}



function activePositiveRows(rows = []) {
  return (rows || []).filter(x => Number(x.quantity ?? x.Quantity1 ?? x.RemainQ ?? 0) > 0);
}
function refreshOptions(reason = 'manual-refresh', options = {}) {
  if (reason && typeof reason === 'object') return { reason: reason.reason || 'manual-refresh', ...reason };
  return { reason: String(reason || 'manual-refresh'), ...options };
}
async function readInventoryRowsForItem(db, itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) return [];
  return await db.collection('itemInventoryCatalog').find({ itemCode:code }).sort({ stockNumber:1 }).toArray().catch(()=>[]);
}

async function refreshInventoryCacheForItem(db, itemCode, reason = 'manual-refresh', options = {}) {
  // 0.9.19.51: Safe authoritative item refresh.
  // Live GetRemain for one item is trusted for positive rows, but zero/error responses never delete healthy cache blindly.
  const opts = refreshOptions(reason, options);
  const reasonText = String(opts.reason || 'manual-refresh');
  const code = String(itemCode || '').trim();
  if (!code) return { ok:false, itemCode:code, error:'itemCode is empty', refreshed:false, rows:[] };

  const oldRows = await readInventoryRowsForItem(db, code);
  const inv = await shaygan.getInventoryByItemCode(code).catch(e => ({ ok:false, list:[], error:String(e.message||e) }));
  if (!inv.ok || !Array.isArray(inv.list)) {
    const err = inv.error || 'خواندن موجودی از شایگان ناموفق بود';
    await db.collection('appLogs').insertOne({ type:'inventory_item_cache_refresh_error', itemCode:code, reason:reasonText, oldRowCount:oldRows.length, error:err, ok:false, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
    return { ok:false, itemCode:code, error:err, refreshed:false, rows:oldRows, oldRowCount:oldRows.length, source:'safe-authoritative-item-refresh-error-preserved-cache' };
  }

  const rows = activePositiveRows(inv.list).map(x => ({ ...x, itemCode:String(x.itemCode || x.ItemCode || code).trim() || code, stockNumber:String(x.stockNumber || x.STNumber || x.StoreNumber || '').trim(), refreshReason:reasonText, refreshSource:'live-item-refresh', lastLiveVerifiedAt:new Date(), inventoryConfidence:'live-item-positive' })).filter(x => x.itemCode && x.stockNumber);
  const oldStocks = new Set(oldRows.map(x => String(x.stockNumber || '').trim()).filter(Boolean));
  const newStocks = new Set(rows.map(x => String(x.stockNumber || '').trim()).filter(Boolean));
  const addedStocks = [...newStocks].filter(x => !oldStocks.has(x));
  const reducedStocks = [...oldStocks].filter(x => !newStocks.has(x));

  if (!rows.length) {
    const allowZeroReplace = opts.allowZeroReplace === true || opts.confirmZero === true;
    if (allowZeroReplace) {
      await db.collection('itemInventoryCatalog').updateMany({ itemCode:code }, { $set:{ quantity:0, refreshReason:reasonText, refreshZeroConfirmed:true, lastSeenInItemRefresh:false, updatedAt:new Date(), syncedAt:new Date() } }).catch(()=>{});
      await db.collection('appLogs').insertOne({ type:'inventory_item_cache_refresh_zero_confirmed', itemCode:code, reason:reasonText, oldRowCount:oldRows.length, rowCount:0, ok:true, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
      return { ok:true, itemCode:code, refreshed:true, zeroConfirmed:true, rows:[], rowCount:0, oldRowCount:oldRows.length, source:'safe-authoritative-item-refresh-zero-confirmed' };
    }
    await db.collection('appLogs').insertOne({ type:'inventory_item_cache_refresh_zero_untrusted', itemCode:code, reason:reasonText, oldRowCount:oldRows.length, rowCount:0, ok:true, preserved:true, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
    return { ok:true, itemCode:code, refreshed:false, zeroUntrusted:true, preserved:true, rows:oldRows, rowCount:oldRows.length, liveRowCount:0, oldRowCount:oldRows.length, source:'safe-authoritative-item-refresh-zero-preserved-cache' };
  }

  await upsertInventoryRows(db, rows);
  let zeroedCount = 0;
  if ((opts.allowStockReduction === true || opts.confirmReduction === true) && reducedStocks.length) {
    const upd = await db.collection('itemInventoryCatalog').updateMany(
      { itemCode:code, stockNumber:{ $in:reducedStocks } },
      { $set:{ quantity:0, refreshReason:reasonText, lastSeenInItemRefresh:false, refreshReducedAt:new Date(), syncedAt:new Date(), zeroConfirmedBy:'live-item-refresh' } }
    ).catch(()=>({ modifiedCount:0 }));
    zeroedCount = upd.modifiedCount || 0;
  } else if (reducedStocks.length) {
    await db.collection('itemInventoryCatalog').updateMany(
      { itemCode:code, stockNumber:{ $in:reducedStocks } },
      { $set:{ missingInLiveRefresh:true, needsLiveVerify:true, protectedFromAutoSyncStale:true, refreshReducedAt:new Date(), refreshReason:reasonText }, $inc:{ missingInLiveCount:1 } }
    ).catch(()=>({ modifiedCount:0 }));
  }
  await db.collection('appLogs').insertOne({ type:'inventory_item_cache_refresh', itemCode:code, reason:reasonText, rowCount:rows.length, oldRowCount:oldRows.length, addedStocks, reducedStocks, zeroedCount, ok:true, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
  const finalRows = await readInventoryRowsForItem(db, code);
  return { ok:true, itemCode:code, refreshed:true, rows:finalRows.filter(x=>Number(x.quantity||0)>0), rowCount:rows.length, oldRowCount:oldRows.length, addedStocks, reducedStocks, zeroedCount, source:'safe-authoritative-item-refresh' };
}
async function refreshInventoryCacheForItems(db, itemCodes = [], reason = 'batch-refresh', options = {}) {
  const unique = [...new Set((itemCodes || []).map(x => String(x || '').trim()).filter(Boolean))];
  const out = [];
  for (const code of unique) out.push(await refreshInventoryCacheForItem(db, code, reason, options));
  return out;
}

async function authoritativeLiveReconcileItem(db, itemCode, reason = 'authoritative-live-reconcile') {
  // 0.9.19.58: exact item GetRemain is authoritative for active warehouses.
  // Positive rows are upserted; previously-positive active rows absent from the successful live response are zeroed.
  const code = String(itemCode || '').trim();
  const reasonText = String(reason || 'authoritative-live-reconcile');
  if (!code) return { ok:false, itemCode:code, error:'itemCode is empty', rows:[] };
  const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const activeSet = new Set((active || []).map(x=>String(x||'').trim()).filter(Boolean));
  const inv = await shaygan.getInventoryByItemCode(code).catch(e => ({ ok:false, list:[], error:String(e.message||e) }));
  if (!inv.ok || !Array.isArray(inv.list)) {
    const error = inv.error || 'خواندن live موجودی از شایگان ناموفق بود';
    await db.collection('appLogs').insertOne({ type:'inventory_authoritative_live_reconcile_error', itemCode:code, reason:reasonText, error, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
    return { ok:false, itemCode:code, error, rows:[], activeWarehouseNumbers:active };
  }
  const liveRows = activePositiveRows(inv.list).map(x => ({
    ...x,
    itemCode:String(x.itemCode || x.ItemCode || code).trim() || code,
    stockNumber:String(x.stockNumber || x.STNumber || x.StoreNumber || '').trim(),
    refreshReason:reasonText,
    refreshSource:'authoritative-live-item-refresh',
    lastLiveVerifiedAt:new Date(),
    inventoryConfidence:'authoritative-live'
  })).filter(x => x.itemCode && x.stockNumber && (!activeSet.size || activeSet.has(String(x.stockNumber))));
  await upsertInventoryRows(db, liveRows, { source:'authoritative-live-item-refresh', reason:reasonText });
  const liveStockSet = new Set(liveRows.map(x=>String(x.stockNumber||'').trim()).filter(Boolean));
  const staleFind = { itemCode:code, quantity:{ $gt:0 } };
  if (activeSet.size) staleFind.stockNumber = { $in:[...activeSet] };
  const staleRows = await db.collection('itemInventoryCatalog').find(staleFind, { projection:{ stockNumber:1, quantity:1 } }).toArray().catch(()=>[]);
  const missingStocks = staleRows.map(x=>String(x.stockNumber||'').trim()).filter(st=>st && !liveStockSet.has(st));
  let zeroedCount = 0;
  if (missingStocks.length) {
    const upd = await db.collection('itemInventoryCatalog').updateMany(
      { itemCode:code, stockNumber:{ $in:[...new Set(missingStocks)] } },
      { $set:{ quantity:0, quantity2:0, missingInLiveRefresh:false, missingInStockSync:false, needsLiveVerify:false, protectedFromAutoSyncStale:false, pendingShayganConfirm:false, zeroConfirmedBy:'authoritative-live-item-refresh', refreshReason:reasonText, lastLiveVerifiedAt:new Date(), syncedAt:new Date(), updatedAt:new Date() }, $addToSet:{ sourceEvidence:'authoritative-live-zero' } }
    ).catch(()=>({ modifiedCount:0 }));
    zeroedCount = Number(upd.modifiedCount || 0);
  }
  const finalRows = await readInventoryRowsForItem(db, code);
  await db.collection('appLogs').insertOne({ type:'inventory_authoritative_live_reconcile', itemCode:code, reason:reasonText, livePositiveCount:liveRows.length, missingStocks:[...new Set(missingStocks)], zeroedCount, activeWarehouseNumbers:active, ok:true, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
  return { ok:true, itemCode:code, rows:finalRows.filter(x=>Number(x.quantity||0)>0 && (!activeSet.size || activeSet.has(String(x.stockNumber)))), livePositiveCount:liveRows.length, missingStocks:[...new Set(missingStocks)], zeroedCount, activeWarehouseNumbers:active, source:'authoritative-live-item-reconcile' };
}

async function verifyMissingStockRowsLive(db, stockNumber, batchId, reason = 'stock-sync-missing-live-verify') {
  const st = String(stockNumber || '').trim();
  const limit = Math.max(1, Number(process.env.INVENTORY_MISSING_LIVE_VERIFY_LIMIT || 100));
  const candidates = await db.collection('itemInventoryCatalog').find(
    { stockNumber:st, quantity:{ $gt:0 }, stockSyncBatchId:{ $ne:batchId } },
    { projection:{ itemCode:1 } }
  ).limit(limit).toArray().catch(()=>[]);
  const codes = [...new Set(candidates.map(x=>String(x.itemCode||'').trim()).filter(Boolean))];
  const results = [];
  for (const code of codes) {
    const r = await authoritativeLiveReconcileItem(db, code, `${reason}-stock-${st}`).catch(e=>({ ok:false, itemCode:code, error:String(e.message||e) }));
    results.push({ itemCode:code, ok:!!r.ok, zeroedCount:Number(r.zeroedCount||0), missingStocks:r.missingStocks||[], error:r.error||'' });
  }
  const remaining = await db.collection('itemInventoryCatalog').updateMany(
    { stockNumber:st, quantity:{ $gt:0 }, stockSyncBatchId:{ $ne:batchId } },
    { $set:{ missingInStockSync:true, needsLiveVerify:true, protectedFromAutoSyncStale:false, lastMissingInStockAt:new Date() }, $inc:{ missingInStockCount:1 } }
  ).catch(()=>({ modifiedCount:0 }));
  return { checked:codes.length, zeroedCount:results.reduce((s,x)=>s+Number(x.zeroedCount||0),0), failed:results.filter(x=>!x.ok).length, remainingQueued:Number(remaining.modifiedCount||0), results };
}
async function ensureItemInventoryFresh(db, itemCode, reason = 'ensure-item-inventory', options = {}) {
  return await refreshInventoryCacheForItem(db, itemCode, reason, { allowZeroReplace:false, ...options });
}
async function validateSaleInventoryLines(db, items = [], reason = 'sale-issue-validate') {
  const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const activeSet = new Set((active || []).map(x => String(x || '').trim()).filter(Boolean));
  const lines = (Array.isArray(items) ? items : []).map((x, idx) => ({
    idx,
    itemCode:String(x.itemCode || x.ItemCode || x.ItemNumber || '').trim(),
    itemGuid:String(x.itemGuid || x.ItemGuId || x.ItemGuid || '').trim(),
    stockNumber:String(x.stockNumber || x.STNumber || x.stNumber || '').trim(),
    stockGuid:String(x.stockGuid || x.STGuId || x.stockGuId || '').trim(),
    quantity:Number(x.quantity || x.Quan || x.qty || 0)
  })).filter(x => x.itemCode || x.stockNumber || x.quantity);
  const codes = [...new Set(lines.map(x => x.itemCode).filter(Boolean))];
  const refresh = [];
  for (const code of codes) refresh.push(await ensureItemInventoryFresh(db, code, reason).catch(e => ({ ok:false, itemCode:code, error:String(e.message||e) })));
  const refreshByCode = new Map(refresh.map(x => [String(x.itemCode || '').trim(), x]));
  const errors = [];
  const checked = [];
  for (const l of lines) {
    if (!l.itemCode || !l.stockNumber || !(l.quantity > 0)) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, error:'کد کالا، انبار و تعداد معتبر الزامی است' }); continue; }
    const rf = refreshByCode.get(l.itemCode);
    if (rf && rf.ok === false) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, error:'خواندن live موجودی کالا قبل از صدور ناموفق بود', refreshError:rf.error||'' }); continue; }
    if (rf && rf.zeroUntrusted) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, error:'پاسخ live refresh برای این کالا صفر/مشکوک بود؛ برای جلوگیری از فروش با موجودی نامطمئن فاکتور متوقف شد' }); continue; }
    if (activeSet.size && !activeSet.has(l.stockNumber)) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, error:'انبار انتخاب‌شده در لیست انبارهای فعال نیست' }); continue; }
    const row = await db.collection('itemInventoryCatalog').findOne({ itemCode:l.itemCode, stockNumber:l.stockNumber }).catch(()=>null);
    if (!row || Number(row.quantity || 0) <= 0) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, stockGuid:l.stockGuid, error:'موجودی مثبت برای همین کالا و همین انبار در CRM پیدا نشد' }); continue; }
    if (l.stockGuid && row.stockGuid && String(row.stockGuid).toLowerCase() !== String(l.stockGuid).toLowerCase()) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, selectedStockGuid:l.stockGuid, cacheStockGuid:row.stockGuid, error:'StockGuid انتخاب‌شده با انبار ذخیره‌شده در CRM همخوان نیست' }); continue; }
    if (Number(row.quantity || 0) < l.quantity) { errors.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, requestedQty:l.quantity, availableQty:Number(row.quantity||0), error:'تعداد درخواستی از موجودی همین انبار بیشتر است' }); continue; }
    checked.push({ idx:l.idx, itemCode:l.itemCode, stockNumber:l.stockNumber, stockGuid:l.stockGuid || row.stockGuid || '', requestedQty:l.quantity, availableQty:Number(row.quantity||0), itemGuid:l.itemGuid || row.itemGuid || '', ok:true });
  }
  const ok = !errors.length;
  await db.collection('appLogs').insertOne({ type:'sale_inventory_validation', reason, ok, lineCount:lines.length, checkedCount:checked.length, errorCount:errors.length, errors, at:new Date(), atTehran:time.formatTehranDateTime(new Date()) }).catch(()=>{});
  return { ok, checked, errors, refresh, activeWarehouseNumbers:active, source:'server-side-item-stock-validation' };
}
function looksLikeItemCode(q = '') {
  const x = String(q || '').trim();
  return /^[0-9A-Za-z_-]{5,}$/.test(x) && !/\s/.test(x);
}

// 0.9.19.23: Targeted repair for Shaygan GetRemain stock-list gaps.
// Normal searches remain Mongo-first. Live fallback is only used when snapshot has no result.
const liveInventoryRepairNegativeCache = new Map();
function liveRepairCacheKey(q, filters = {}) {
  return normalizeFa(`${q||''}|stock:${filters.stockNumber||''}|main:${filters.itemMainGroupCode||''}|grp:${filters.itemGroupCode||''}`);
}
function shouldRunLiveInventoryRepair(q, snapshotCount = 0) {
  if (!config.liveSearchFallbackEnabled) return false;
  const x = String(q || '').trim();
  if (snapshotCount > 0) return false;
  if (looksLikeItemCode(x)) return true;
  return normalizeFa(x).replace(/\s+/g, '').length >= Number(config.liveSearchFallbackMinLen || 8);
}
function liveRepairNegativeBlocked(q, filters = {}) {
  const key = liveRepairCacheKey(q, filters);
  const until = liveInventoryRepairNegativeCache.get(key);
  if (until && until > Date.now()) return true;
  if (until) liveInventoryRepairNegativeCache.delete(key);
  return false;
}
function markLiveRepairNegative(q, filters = {}) {
  const ttl = Number(config.liveSearchFallbackNegativeTtlMs || 300000);
  if (ttl > 0) liveInventoryRepairNegativeCache.set(liveRepairCacheKey(q, filters), Date.now() + ttl);
}
function escapeRe(s='') { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function findCatalogItemCodesByQuery(db, q, max = 5) {
  const tokens = tokensOf(q);
  if (!tokens.length) return [];
  const first = tokens.sort((a,b)=>b.length-a.length)[0];
  if (!first || first.length < 3) return [];
  const rx = new RegExp(escapeRe(first), 'i');
  const cols = ['itemCatalog', 'itemCatalogAll', 'itemInventoryCatalog'];
  const seen = new Set();
  const candidates = [];
  for (const col of cols) {
    const docs = await db.collection(col).find({ $or:[ { itemCode: rx }, { ItemCode: rx }, { itemDescription: rx }, { ItemDescription: rx }, { searchText: rx } ] }).limit(500).toArray().catch(()=>[]);
    for (const d of docs) {
      const code = String(d.itemCode || d.ItemCode || d.code || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      candidates.push({ code, score: scoreMatch(d.searchText || `${d.itemCode||d.ItemCode||''} ${d.itemDescription||d.ItemDescription||''}`, tokens, code) });
    }
  }
  return candidates.filter(x => x.score > -Infinity).sort((a,b)=>b.score-a.score).slice(0, Number(max||5)).map(x=>x.code);
}
async function targetedLiveInventoryRepair(db, q, filters = {}, reason = 'targeted-live-search-repair') {
  const query = String(q || '').trim();
  if (!shouldRunLiveInventoryRepair(query, 0)) return { ok:true, skipped:true, reason:'not-eligible', rows:[], rowCount:0 };
  if (liveRepairNegativeBlocked(query, filters)) return { ok:true, skipped:true, negativeCached:true, rows:[], rowCount:0 };
  const codes = looksLikeItemCode(query) ? [query.toUpperCase()] : await findCatalogItemCodesByQuery(db, query, Number(config.liveSearchFallbackMaxCatalogCandidates || 5));
  const allRows = [];
  const results = [];
  const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const activeSet = new Set((active || []).map(String));
  for (const code of [...new Set(codes)]) {
    const rr = await authoritativeLiveReconcileItem(db, code, reason).catch(e => ({ ok:false, itemCode:code, rows:[], error:String(e.message||e) }));
    results.push({ itemCode:code, ok:!!rr.ok, rowCount:(rr.rows||[]).length, error:rr.error||'' });
    for (const row of (rr.rows || [])) {
      if (filters.stockNumber && String(row.stockNumber) !== String(filters.stockNumber)) continue;
      if (!filters.stockNumber && activeSet.size && !activeSet.has(String(row.stockNumber))) continue;
      allRows.push(row);
    }
  }
  if (!allRows.length) markLiveRepairNegative(query, filters);
  await db.collection('appLogs').insertOne({ type:'inventory_live_search_repair', query, filters, codes, resultCount:allRows.length, results, at:new Date() }).catch(()=>{});
  return { ok:true, skipped:false, rows:allRows, rowCount:allRows.length, codes, results, source:'targeted-live-getremain-repair' };
}
async function repairInventorySnapshotFromKardex(db, code, stockNumber, kardexResult) {
  const rows = kardexResult && Array.isArray(kardexResult.rows) ? kardexResult.rows : [];
  const hasPositiveRemain = rows.some(x => Number(x.remainQty || 0) > 0);
  if (!hasPositiveRemain) return { ok:true, skipped:true, reason:'no-positive-remain' };
  return refreshInventoryCacheForItem(db, code, `kardex-positive-balance-repair${stockNumber ? '-stock-' + stockNumber : ''}`);
}

async function buildActiveInventoryFind(db, filters = {}) {
  // 0.9.19.21: یک منبع واحد برای search موجودی و search فاکتور فروش.
  // فقط موجودی مثبت انبارهای فعال قابل نمایش است؛ زمان مبنا سرور است.
  const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const find = { quantity: { $gt: 0 } };
  const requestedStock = String(filters.stockNumber || '').trim();
  if (requestedStock) {
    if (active.length && !active.map(String).includes(requestedStock)) return { find:null, active, blockedStock:true };
    find.stockNumber = requestedStock;
  } else if (active.length) {
    find.stockNumber = { $in: active.map(String) };
  }
  if (filters.itemMainGroupCode) find['raw.ItemMainGroupCode'] = String(filters.itemMainGroupCode);
  if (filters.itemGroupCode) find['raw.ItemGroupCode'] = String(filters.itemGroupCode);
  return { find, active, blockedStock:false };
}

async function searchActiveInventorySnapshot(q, limit = 50, filters = {}) {
  const db = await connectMongo();
  const tokens = tokensOf(q);
  const { find, active, blockedStock } = await buildActiveInventoryFind(db, filters);
  if (blockedStock || !find) return { ok:true, list:[], groups:[], source:'active-inventory-snapshot-blocked-stock', activeWarehouseNumbers:active, cacheCount:0 };
  if (!tokens.length && !filters.stockNumber) return { ok:true, list:[], groups:[], source:'active-inventory-snapshot-empty', activeWarehouseNumbers:active, cacheCount:0 };
  const docs = await db.collection('itemInventoryCatalog').find(find).limit(120000).toArray();
  const ranked = docs
    .map(x => ({ ...x, _score: tokens.length ? scoreMatch(x.searchText || rowSearchText(x), tokens, x.itemCode || '') : 0 }))
    .filter(x => !tokens.length || x._score > -Infinity)
    .sort((a,b) => b._score - a._score || String(a.itemDescription||'').localeCompare(String(b.itemDescription||''),'fa') || String(a.stockNumber||'').localeCompare(String(b.stockNumber||''),'fa'));
  const cap = Number(limit || 50);
  const list = cap > 0 ? ranked.slice(0, Math.max(cap, 5000)) : ranked;
  const groups = saleInventoryGroups(ranked, cap || 40);
  return { ok:true, list: cap > 0 ? ranked.slice(0, cap) : ranked, groups, source:'active-inventory-snapshot-unified', activeWarehouseNumbers:active, cacheCount:docs.length };
}

async function searchInventoryCatalog(q, limit = 30, filters = {}) {
  const r = await searchActiveInventorySnapshot(q, limit, filters);
  return r.list || [];
}

async function searchSaleInventorySnapshot(q, limit = 40, filters = {}) {
  // 0.9.19.21: سرچ فروش دقیقاً از همان موتور سرچ موجودی انبارها استفاده می‌کند.
  // وابستگی به maxAge باعث حذف کاذب کالاهای تازه sync شده می‌شد؛ cache فعال همیشه مرجع UI است و قبل از صدور live check انجام می‌شود.
  const db = await connectMongo();
  const tokens = tokensOf(q);
  if (!tokens.length) return { ok:true, list:[], groups:[], source:'sale-inventory-unified-empty', cacheCount:0, stale:false };

  let exactRefresh = null;
  if (looksLikeItemCode(q)) {
    exactRefresh = await authoritativeLiveReconcileItem(db, String(q || '').trim().toUpperCase(), 'sale-search-exact-code-refresh').catch(e => ({ ok:false, error:String(e.message||e) }));
  }

  let preTextRefresh = null;
  if (!looksLikeItemCode(q) && normalizeFa(String(q||'')).replace(/\s+/g,'').length >= 4) {
    preTextRefresh = await targetedLiveInventoryRepair(db, q, filters, 'sale-text-search-targeted-refresh-before-filter').catch(e => ({ ok:false, rows:[], error:String(e.message||e) }));
  }
  let r = await searchActiveInventorySnapshot(q, Number(limit || 40), filters);
  let groups = r.groups || [];
  let list = groups.flatMap(g => (g.stocks || []).map(st => ({ ...st, totalQty:g.totalQty })));

  // 0.9.19.23/52: اگر snapshot نتیجه نداد، repair هدفمند بزن؛ سرچ‌های مدل‌محور هم قبل از فیلتر refresh شدند.
  if (!groups.length && shouldRunLiveInventoryRepair(q, 0)) {
    const liveInfo = await targetedLiveInventoryRepair(db, q, filters, 'sale-search-targeted-live-repair');
    if ((liveInfo.rows || []).length) {
      // بعد از upsert fallback، دوباره از موتور واحد snapshot بخوان تا active warehouse و group key یکی باشد.
      r = await searchActiveInventorySnapshot(q, Number(limit || 40), filters);
      groups = r.groups || [];
      list = groups.flatMap(g => (g.stocks || []).map(st => ({ ...st, totalQty:g.totalQty })));
      if (groups.length) return { ok:true, list, groups, source:'sale-inventory-unified-targeted-live-repair', cacheCount:r.cacheCount||0, stale:false, exactRefresh, preTextRefresh, fallback:liveInfo, activeWarehouseNumbers:r.activeWarehouseNumbers||[] };
    }
  }
  return { ok:true, list, groups, source: exactRefresh ? 'sale-inventory-unified-snapshot-exact-refreshed' : (preTextRefresh ? 'sale-inventory-unified-snapshot-text-refreshed' : 'sale-inventory-unified-snapshot'), cacheCount:r.cacheCount||0, stale:false, exactRefresh, preTextRefresh, activeWarehouseNumbers:r.activeWarehouseNumbers||[] };
}


// 0.9.19.32: inventory stocktaking/export must mirror Shaygan GetRemain by StoreNumber+ItemCode.
// Some CRM UI paths used live scans and could render the same positive remain row twice when a
// WebService page was appended/re-read. This guard keeps one authoritative row per store+item.
function normStockKey(v='') { return String(v || '').trim().replace(/[^0-9A-Za-z]/g,'').toUpperCase(); }
function normItemKey(v='') { return String(v || '').trim().toUpperCase(); }
function remainUniqueKey(row = {}) {
  const store = normStockKey(row.stockNumber || row.STNumber || row.StoreNumber || row.warehouseNo || '');
  const code = normItemKey(row.itemCode || row.ItemCode || row.ItemNumber || '');
  const guid = normItemKey(row.itemGuid || row.ItemGuId || row.ItemGuid || '');
  return `${store}::${code || guid}`;
}
function dedupeRemainRows(rows = []) {
  const map = new Map();
  const duplicates = [];
  const conflicts = [];
  for (const row of rows || []) {
    const key = remainUniqueKey(row);
    if (!key || key === '::') continue;
    if (!map.has(key)) { map.set(key, row); continue; }
    const prev = map.get(key);
    const q1 = Number(prev.quantity ?? prev.RemainQ ?? prev.Quantity1 ?? 0);
    const q2 = Number(row.quantity ?? row.RemainQ ?? row.Quantity1 ?? 0);
    const c1 = Number(prev.averageCost ?? prev.Price ?? prev.RemainUnit1Price ?? 0);
    const c2 = Number(row.averageCost ?? row.Price ?? row.RemainUnit1Price ?? 0);
    const r1 = Number(prev.remainCost ?? prev.RemainCost ?? 0);
    const r2 = Number(row.remainCost ?? row.RemainCost ?? 0);
    duplicates.push({ key, itemCode: row.itemCode || row.ItemCode || '', stockNumber: row.stockNumber || row.STNumber || '', qty:q2, averageCost:c2 });
    if (Math.abs(q1-q2) > 1e-9 || Math.abs(c1-c2) > 0.001 || Math.abs(r1-r2) > 0.001) {
      conflicts.push({ key, prevQty:q1, nextQty:q2, prevAverageCost:c1, nextAverageCost:c2, prevRemainCost:r1, nextRemainCost:r2 });
      // Keep the WebService/latest row if it has a newer sync timestamp, otherwise keep first.
      const pt = prev.syncedAt ? new Date(prev.syncedAt).getTime() : 0;
      const nt = row.syncedAt ? new Date(row.syncedAt).getTime() : 0;
      if (nt > pt) map.set(key, row);
    }
  }
  return { list:[...map.values()], duplicates, conflicts, rawCount:(rows||[]).length, uniqueCount:map.size };
}

async function liveScanInventorySearch(q, limit = 30, maxPages = config.inventorySearchLivePages, filters = {}) {
  const db = await connectMongo();
  const tokens = tokensOf(q);
  const found = [];
  let scanned = 0;
  const hardLimit = Number(limit || 0);
  for (let rowStart = 0; scanned < maxPages; scanned++, rowStart += 100) {
    const res = await shaygan.getInventoryPage(rowStart, 100, filters);
    if (!res.ok) return { ok:false, list:found, rows:found, error:res.error, source:'inventory-live', scannedPages:scanned };
    if (!res.list.length) break;
    await upsertInventoryRows(db, res.list);
    for (const row of res.list) {
      if ((!tokens.length || matchTokens(rowSearchText(row), tokens)) && (!filters.stockNumber || String(row.stockNumber) === String(filters.stockNumber))) found.push(row);
      if (hardLimit > 0 && found.length >= hardLimit) break;
    }
    if (hardLimit > 0 && found.length >= hardLimit) break;
    if (res.list.length < 100) break;
  }
  const sortedRaw = found
    .map(x => ({ ...x, _score: scoreMatch(rowSearchText(x), tokens, x.itemCode || '') }))
    .sort((a,b) => b._score - a._score || String(a.itemDescription||'').localeCompare(String(b.itemDescription||''),'fa'));
  const dd = dedupeRemainRows(sortedRaw);
  return { ok:true, list:dd.list, rows:dd.list, source:'inventory-live-deduped-store-item', scannedPages:scanned, rawCount:dd.rawCount, uniqueCount:dd.uniqueCount, duplicateCount:dd.duplicates.length, duplicateConflicts:dd.conflicts };
}

async function searchInventoryRows(q, limit = 50, maxPages = config.inventorySearchLivePages, filters = {}) {
  // 0.9.19.17→WS: SQL حذف شد؛ MongoDB snapshot استفاده می‌شود
  const tokens = tokensOf(q);
  if (tokens.length < 1 && !filters.stockNumber) return { ok:true, list:[], source:'empty' };

  // 0.9.13.4 rule: the Stocks menu is itself an inventory view, so search results must be
  // only positive-stock rows from the local inventory snapshot. Do NOT call Shaygan while typing.
  // Live Shaygan remains only for final sale verification and single-item inventory detail.
  const cacheLimit = limit > 0 ? Math.max(limit, 5000) : 80000;
  let exactRefresh = null;
  if (looksLikeItemCode(q)) {
    const db = await connectMongo();
    exactRefresh = await authoritativeLiveReconcileItem(db, String(q || '').trim().toUpperCase(), 'inventory-search-exact-code-refresh').catch(e => ({ ok:false, error:String(e.message||e) }));
  }
  let fallback = null;
  let source = 'inventory-snapshot-positive';
  // 0.9.19.52: for strong text/model searches, identify candidate itemCodes first, refresh them, then apply stock filter.
  // This fixes cases like q=m100a + stock=11 where snapshot is missing one stock row.
  if (!looksLikeItemCode(q) && normalizeFa(String(q||'')).replace(/\s+/g,'').length >= 4) {
    const db = await connectMongo();
    fallback = await targetedLiveInventoryRepair(db, q, filters, 'inventory-text-search-targeted-refresh-before-filter').catch(e => ({ ok:false, rows:[], error:String(e.message||e) }));
    if ((fallback.rows || []).length) source = 'inventory-snapshot-positive-text-targeted-refreshed';
  }
  let rows = await searchInventoryCatalog(q, cacheLimit, filters);
  // 0.9.19.23/52: if still empty, try repair for eligible exact/long search.
  if (!rows.length && shouldRunLiveInventoryRepair(q, 0)) {
    const db = await connectMongo();
    fallback = await targetedLiveInventoryRepair(db, q, filters, 'inventory-search-targeted-live-repair');
    if ((fallback.rows || []).length) {
      rows = await searchInventoryCatalog(q, cacheLimit, filters);
      source = 'inventory-snapshot-positive-targeted-live-repair';
    } else if (fallback.negativeCached) {
      source = 'inventory-snapshot-positive-negative-cache';
    }
  }
  return { ok:true, list: limit > 0 ? rows.slice(0, limit) : rows, source: exactRefresh ? source + '-exact-refreshed' : source, scannedPages:0, exactRefresh, fallback, error:'' };
}

function deriveMainGroup(row) {
  const raw = row.raw || row;
  const code = raw.ItemMainGroupCode || raw.MainGroupCode || raw.ProductMainGroupCode || String(row.itemCode || '').slice(0,2);
  const name = raw.ItemMainGroupName || raw.MainGroupName || raw.ProductMainGroupName || (code ? `گروه اصلی ${code}` : 'نامشخص');
  return { code: String(code || ''), name: String(name || '') };
}

function inventoryGroups(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const g = deriveMainGroup(r);
    if (!g.code) continue;
    if (!m.has(g.code)) m.set(g.code, { code:g.code, name:g.name, count:0, quantity:0 });
    const x = m.get(g.code); x.count += 1; x.quantity += Number(r.quantity || 0);
  }
  return [...m.values()].sort((a,b)=>String(a.code).localeCompare(String(b.code),'fa'));
}

function saleInventoryGroups(rows, limit = 40) {
  const m = new Map();
  for (const r of rows || []) {
    const code = String(r.itemCode || r.ItemCode || '').trim();
    const guid = String(r.itemGuid || r.ItemGuId || r.ItemGuid || '').trim();
    if (!code) continue;
    // 0.9.19.53: display/search grouping must not duplicate the same itemCode after multi-source sync.
    // The authoritative sale line still carries itemGuid from the selected row, but UI grouping is by itemCode.
    const key = code;
    if (!m.has(key)) {
      if (m.size >= Number(limit || 40)) continue;
      m.set(key, { itemCode:code, itemDescription:r.itemDescription||r.ItemDesc||'', itemGuid:guid, totalQty:0, stocks:[], bestScore:Number(r._score||0), lastSyncAt:null, duplicateSafeKey:key });
    }
    const g = m.get(key);
    const qty = Number(r.quantity || r.RemainQ || 0);
    g.totalQty += qty;
    if (Number(r._score || 0) > Number(g.bestScore || 0)) g.bestScore = Number(r._score || 0);
    g.stocks.push({ itemCode:code, itemDescription:r.itemDescription||r.ItemDesc||g.itemDescription, itemGuid:guid, stockNumber:r.stockNumber||r.STNumber||'', stockName:r.stockName||r.StDesc||'', stockGuid:r.stockGuid||'', quantity:qty, averageCost:Number(r.averageCost||r.Price||0), remainCost:Number(r.remainCost||r.RemainR||0), syncedAt:r.syncedAt||null });
    if (!g.lastSyncAt || (r.syncedAt && new Date(r.syncedAt) > new Date(g.lastSyncAt))) g.lastSyncAt = r.syncedAt;
  }
  return [...m.values()].map(g => {
    const dd = dedupeRemainRows(g.stocks || []);
    const stocks = dd.list.sort((a,b)=>Number(b.quantity||0)-Number(a.quantity||0) || String(a.stockNumber||'').localeCompare(String(b.stockNumber||''),'fa'));
    return { ...g, stocks, totalQty:stocks.reduce((s,x)=>s+Number(x.quantity||0),0), duplicateCount:dd.duplicates.length };
  }).sort((a,b)=>Number(b.bestScore||0)-Number(a.bestScore||0) || String(a.itemDescription||'').localeCompare(String(b.itemDescription||''),'fa'));
}

async function searchItems(q, limit = 20, maxPages = config.inventorySearchLivePages) {
  const rowsRes = await searchInventoryRows(q, Math.max(limit*3, 50), maxPages);
  if (!rowsRes.ok) return { ok:false, list:[], source:rowsRes.source, error:rowsRes.error };
  const map = new Map();
  for (const r of rowsRes.list) if (!map.has(r.itemCode)) map.set(r.itemCode, toProductNameRow(r));
  return { ok:true, list:[...map.values()].slice(0, limit), source:rowsRes.source, scannedPages:rowsRes.scannedPages || 0 };
}


async function upsertAllItemRows(db, items) {
  const now = new Date();
  const ops = (items || []).filter(x => x.itemCode).map(x => ({
    updateOne: {
      filter: { itemCode: x.itemCode },
      update: { $set: { itemCode: x.itemCode, itemDescription: x.itemDescription, itemGuid: x.itemGuid, groupNumber: x.groupNumber || '', groupGuid: x.groupGuid || '', searchText: normalizeFa(`${x.itemCode || ''} ${x.itemDescription || ''}`), syncedAt: now, raw: x.raw || x } },
      upsert: true
    }
  }));
  if (ops.length) await db.collection('itemCatalogAll').bulkWrite(ops, { ordered:false }).catch(()=>{});
}

async function searchAllItems(q, limit = 50, maxPages = config.inventoryCatalogSyncPages, opts = {}) {
  const db = await connectMongo();
  const tokens = tokensOf(q);
  if (!tokens.length) return { ok:true, list:[], source:'empty', scannedPages:0, note:'' };
  const cap = Number(limit || 50);

  // 1) Fast path: local full item catalog cache. This is the only path used for live dropdown.
  const cached = await db.collection('itemCatalogAll').find({}).limit(50000).toArray();
  let found = cached
    .map(x => ({ ...x, _score: scoreMatch(`${x.itemCode || ''} ${x.itemDescription || ''}`, tokens, x.itemCode || '') }))
    .filter(x => x._score > -Infinity)
    .sort((a,b) => b._score - a._score || String(a.itemDescription || '').length - String(b.itemDescription || '').length || String(a.itemCode || '').localeCompare(String(b.itemCode || ''), 'fa'));

  // 2) If cache is not enough, enrich from in-stock inventory cache first; this is fast and helps common searches.
  if (found.length < cap) {
    const inv = await db.collection('itemInventoryCatalog').find({ quantity: { $gt: 0 } }).limit(50000).toArray();
    const byCode = new Map(found.map(x => [x.itemCode, x]));
    for (const r of inv) {
      const score = scoreMatch(`${r.itemCode || ''} ${r.itemDescription || ''}`, tokens, r.itemCode || '');
      if (score > -Infinity && !byCode.has(r.itemCode)) {
        byCode.set(r.itemCode, { itemCode:r.itemCode, itemDescription:r.itemDescription, itemGuid:r.itemGuid, searchText:normalizeFa(`${r.itemCode||''} ${r.itemDescription||''}`), _score:score, sourceStock:true });
      }
    }
    found = [...byCode.values()].sort((a,b) => b._score - a._score || String(a.itemDescription || '').length - String(b.itemDescription || '').length || String(a.itemCode || '').localeCompare(String(b.itemCode || ''), 'fa'));
  }

  // 3) Do NOT scan 300 pages during typing. A heavy scan made Kardex search slow.
  // If cache is empty/incomplete, run only a small bounded live scan unless forceLive=1 is explicitly requested.
  const forceLive = opts.forceLive === true;
  const quickPages = forceLive ? Number(maxPages || 300) : Math.min(Number(maxPages || 20), Number(config.itemSearchQuickPages || 25));
  let scanned = 0;
  if (found.length < cap && quickPages > 0) {
    const map = new Map(found.map(x => [x.itemCode, x]));
    for (let rowStart = 0; scanned < quickPages; scanned++, rowStart += 100) {
      const res = await shaygan.getItemsPage(rowStart, 100);
      if (!res.ok) return { ok:false, list:[...map.values()].slice(0, cap).map(toProductNameRow), source:'all-items-live', scannedPages:scanned, error:res.error };
      if (!res.list.length) break;
      await upsertAllItemRows(db, res.list);
      for (const item of res.list) {
        const score = scoreMatch(`${item.itemCode || ''} ${item.itemDescription || ''}`, tokens, item.itemCode || '');
        if (item.itemCode && score > -Infinity && !map.has(item.itemCode)) map.set(item.itemCode, { ...item, _score: score });
      }
      if (res.list.length < 100) break;
    }
    found = [...map.values()].sort((a,b) => b._score - a._score || String(a.itemDescription || '').length - String(b.itemDescription || '').length || String(a.itemCode || '').localeCompare(String(b.itemCode || ''), 'fa'));
  }

  const source = cached.length ? 'all-items-cache-ranked' : (scanned ? 'all-items-quick-live' : 'all-items-empty-cache');
  const note = found.length ? '' : 'کاتالوگ کامل کالا هنوز sync نشده یا نتیجه‌ای در صفحات سریع پیدا نشد. از ابزار Sync All Items Catalog استفاده کنید.';
  return { ok:true, list:found.slice(0, cap).map(toProductNameRow), source, scannedPages:scanned, cacheCount:cached.length, note };
}

async function syncAllItemsCatalog(pages = config.inventoryCatalogSyncPages, opts = {}) {
  const db = await connectMongo();
  const pageSize = 100;
  const requested = Number(pages || 0);
  const maxPages = requested > 0 ? Math.min(requested, 20000) : 20000;
  const jobId = opts.jobId || `JOB-ALLITEMS-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
  let total = 0, upserted = 0, page = 0, emptyPages = 0;
  const errors = [];
  await db.collection('appJobs').updateOne({ jobId }, { $set:{ jobId, type:'all-items-catalog-sync', status:'running', startedAt:new Date(), updatedAt:new Date(), pageSize, maxPages, currentPage:0, total:0, upserted:0 } }, { upsert:true }).catch(()=>{});
  for (let rowStart = 0; page < maxPages; page++, rowStart += pageSize) {
    const res = await shaygan.getItemsPage(rowStart, pageSize);
    if (!res.ok) {
      errors.push({ page, rowStart, error:res.error || 'GetProductList failed' });
      await db.collection('appJobs').updateOne({ jobId }, { $set:{ status:'failed', updatedAt:new Date(), finishedAt:new Date(), currentPage:page, total, upserted, errors } }).catch(()=>{});
      return { ok:false, jobId, total, upserted, page, rowStart, error:res.error, errors };
    }
    const list = res.list || [];
    if (!list.length) { emptyPages++; break; }
    await upsertAllItemRows(db, list);
    total += list.length; upserted += list.filter(x=>x && x.itemCode).length;
    if (page % 5 === 0) await db.collection('appJobs').updateOne({ jobId }, { $set:{ status:'running', updatedAt:new Date(), currentPage:page+1, rowStart, total, upserted, lastBatchCount:list.length } }).catch(()=>{});
    // Do NOT stop on list.length < pageSize. Shaygan can return short pages before the real end.
  }
  const completedAtEnd = emptyPages > 0;
  await db.collection('appJobs').updateOne({ jobId }, { $set:{ status: completedAtEnd ? 'completed' : 'max_pages_reached', updatedAt:new Date(), finishedAt:new Date(), currentPage:page, total, upserted, emptyPages, completedAtEnd, errors } }, { upsert:true }).catch(()=>{});
  await db.collection('appLogs').insertOne({ type:'all_items_catalog_sync', jobId, total, upserted, pages:page, emptyPages, completedAtEnd, errors, at:new Date() }).catch(()=>{});
  return { ok:true, jobId, total, upserted, pages:page, emptyPages, completedAtEnd, mode:'all-items-catalog-full-paging-no-short-stop', note: completedAtEnd ? 'تا صفحه خالی ادامه داده شد.' : 'به سقف صفحات رسید؛ برای ادامه pages را بیشتر بگذارید.' };
}

function accountKey(a = {}) {
  const guId = String(a.guId || a.accountGuid || a.GuId || a.AccountGuId || a.raw?.GuId || '').trim();
  const num = String(a.accountNumber || a.AccountNumber || '').trim();
  const name = String(a.accountName || a.AccountName || '').trim();
  const moin = String(a.moinNumber || a.MoinNumber || '').trim();
  if (guId) return `guid:${guId}`;
  return `acct:${num}|${moin}|${name}`;
}
async function upsertAccountRows(db, rows = []) {
  const now = new Date();
  const ops = (rows || []).filter(a => a && (a.accountNumber || a.accountName)).map(a => {
    const key = accountKey(a);
    return {
      updateOne: {
        filter: { accountKey: key },
        update: { $set: { accountKey:key, accountNumber:String(a.accountNumber||''), accountName:a.accountName||'', moinNumber:a.moinNumber||'', accountTypeId:a.accountTypeId||0, mobile:a.mobile||'', guId:a.guId||a.accountGuid||'', searchText: normalizeFa(`${a.accountNumber||''} ${a.accountName||''} ${a.moinNumber||''} ${a.mobile||''}`), syncedAt: now, raw:a.raw||a } },
        upsert: true
      }
    };
  });
  if (ops.length) await db.collection('accountCatalog').bulkWrite(ops, { ordered:false }).catch(()=>{});
}
function accountSearchText(a) { return `${a.accountNumber||''} ${a.accountName||''} ${a.moinNumber||''} ${a.mobile||''}`; }
async function searchAccountCatalog(q, limit = 50) {
  const db = await connectMongo();
  const tokens = tokensOf(q);
  if (!tokens.length) return [];
  // Ignore legacy cached rows without accountKey. They were keyed only by AccountNumber and caused wrong account identity.
  const docs = await db.collection('accountCatalog').find({ accountKey: { $exists:true } }).limit(80000).toArray();
  return docs.map(a => ({ ...a, accountKey: a.accountKey || accountKey(a), _score: scoreMatch(a.searchText || accountSearchText(a), tokens, a.accountNumber || '') }))
    .filter(a => a._score > -Infinity)
    .sort((a,b) => b._score - a._score || String(a.accountName||'').localeCompare(String(b.accountName||''),'fa') || String(a.accountNumber||'').localeCompare(String(b.accountNumber||'')))
    .slice(0, Number(limit||50));
}
const accountLiveMemoryCache = new Map();
function primaryAccountToken(q='') {
  const toks = tokensOf(q);
  if (!toks.length) return '';
  const nonNum = toks.filter(t => !/^\d+$/.test(String(t)));
  return (nonNum.sort((a,b)=>String(b).length-String(a).length)[0] || toks[0] || '').trim();
}
async function searchAccountsFast(q = '', limit = 50, pages = config.accountSearchPages || 220) {
  // 0.9.19.17→WS: SQL حذف شد؛ catalog و live WebService استفاده می‌شود
  const db = await connectMongo();
  const tokens = tokensOf(q);
  if (!tokens.length) return { ok:true, list:[], source:'empty-query', scannedPages:0 };

  // First try the normalized Mongo account catalog. This fixes cases where live/SQL search misses
  // a Persian prefix but the cached account text can match it (e.g. ماتریس only showing with ریس).
  const catalogHit = await searchAccountCatalog(q, Math.max(limit, 80)).catch(()=>[]);
  if (catalogHit && catalogHit.length) {
    return { ok:true, list: catalogHit.slice(0, Number(limit||50)), source:'account-catalog-normalized', scannedPages:0, cacheCount:catalogHit.length };
  }

  // Identity-safe account search: use live Shaygan results keyed by GUID, not the old Mongo cache keyed by AccountNumber.
  // Optimization: cache by the primary word (e.g. موذنی) in memory and filter locally when user adds 60 / صندوق / etc.
  const key = primaryAccountToken(q);
  const now = Date.now();
  const cached = key && accountLiveMemoryCache.get(key);
  if (cached && (now - cached.at) < 10 * 60 * 1000) {
    const ranked = (cached.list || [])
      .map(a => ({ ...a, accountKey: accountKey(a), _score: scoreMatch(accountSearchText(a), tokens, a.accountNumber || '') }))
      .filter(a => a._score > -Infinity)
      .sort((a,b) => b._score - a._score || String(a.accountName||'').localeCompare(String(b.accountName||''),'fa'))
      .slice(0, Number(limit||50));
    if (ranked.length) return { ok:true, list:ranked, source:'account-live-memory-filter', scannedPages:0, cacheKey:key };
  }

  const live = await shaygan.searchAccounts(key || q, Math.max(limit, 120), pages);
  const liveList = (live.list || []).map(a => ({ ...a, accountKey: accountKey(a) }));
  if (live.ok && liveList.length) {
    accountLiveMemoryCache.set(key || q, { at: now, list: liveList });
    await upsertAccountRows(db, liveList);
  }
  const ranked = liveList
    .map(a => ({ ...a, _score: scoreMatch(accountSearchText(a), tokens, a.accountNumber || '') }))
    .filter(a => a._score > -Infinity)
    .sort((a,b) => b._score - a._score || String(a.accountName||'').localeCompare(String(b.accountName||''),'fa') || String(a.accountNumber||'').localeCompare(String(b.accountNumber||'')))
    .slice(0, Number(limit||50));
  if (ranked.length || liveList.length) return { ok:live.ok, list: ranked.length ? ranked : liveList.slice(0, limit), source:'account-live-identity-safe', scannedPages:live.scannedPages||0, error:live.error||'' };
  // Last resort: if a full word failed, search by a suffix token. This handles Shaygan text/search quirks
  // without changing the official Shaygan data.
  const nonNum = tokens.filter(t=>!/^[0-9]+$/.test(t));
  const long = nonNum.sort((a,b)=>String(b).length-String(a).length)[0] || '';
  if (long.length > 3) {
    const suffix = long.slice(1);
    const live2 = await shaygan.searchAccounts(suffix, Math.max(limit, 120), pages).catch(e=>({ok:false,list:[],error:String(e.message||e)}));
    const live2List = (live2.list || []).map(a => ({ ...a, accountKey: accountKey(a) }));
    if (live2.ok && live2List.length) {
      await upsertAccountRows(db, live2List);
      const ranked2 = live2List.map(a => ({ ...a, _score: scoreMatch(accountSearchText(a), tokens, a.accountNumber || '') }))
        .filter(a => a._score > -Infinity)
        .sort((a,b) => b._score - a._score || String(a.accountName||'').localeCompare(String(b.accountName||''),'fa'))
        .slice(0, Number(limit||50));
      return { ok:true, list: ranked2.length ? ranked2 : live2List.slice(0, Number(limit||50)), source:'account-live-suffix-fallback', scannedPages:live2.scannedPages||0, fallbackQuery:suffix };
    }
  }
  return { ok:live.ok, list: [], source:'account-search-empty', scannedPages:live.scannedPages||0, error:live.error||'' };
}
async function syncAccountsCatalog(pages = config.accountSearchPages || 220) {
  const db = await connectMongo();
  let total = 0, page = 0;
  for (let rowStart = 0; page < pages; page++, rowStart += 100) {
    const res = await shaygan.getAccountsPage(rowStart, 100);
    if (!res.ok) return { ok:false, total, pages:page, error:res.error };
    if (!res.list.length) break;
    const rows = res.list.map(a => ({...a, accountKey:accountKey(a)}));
    await upsertAccountRows(db, rows);
    total += rows.length;
    if (res.list.length < 100) break;
  }
  await db.collection('appLogs').insertOne({ type:'account_catalog_sync', total, pages:page, mode:'identity-safe', at:new Date() }).catch(()=>{});
  return { ok:true, total, pages:page, mode:'account-catalog-identity-safe' };
}

let inventorySyncRunning = false;
let autoInventoryStockCursor = 0;
let autoInventoryTimer = null;
let autoInventoryLastStatus = { enabled:false, running:false, lastRunAt:null, lastStockNumber:'', nextStockNumber:'', lastResult:null, lastError:'', serverNow:null };

async function saveAutoInventoryStatus(patch = {}) {
  const now = new Date();
  autoInventoryLastStatus = { ...autoInventoryLastStatus, ...patch, serverNow: now, updatedAt: now };
  try {
    const db = await connectMongo();
    await db.collection('settings').updateOne(
      { key:'inventory.autoSyncStatus' },
      { $set:{ key:'inventory.autoSyncStatus', value:autoInventoryLastStatus, updatedAt:now, updatedBy:'system' } },
      { upsert:true }
    );
  } catch (_) {}
  return autoInventoryLastStatus;
}

async function readAutoInventoryStatus() {
  const now = new Date();
  let persisted = null;
  try {
    const db = await connectMongo();
    persisted = await db.collection('settings').findOne({ key:'inventory.autoSyncStatus' });
  } catch (_) {}
  const value = persisted && persisted.value ? persisted.value : {};
  const active = await getActiveWarehouseNumbersFromDb().catch(()=>[]);
  const nextStockNumber = active.length ? String(active[autoInventoryStockCursor % active.length] || '') : '';
  return {
    ok:true,
    enabled:Boolean(config.autoInventorySyncEnabled),
    running:Boolean(inventorySyncRunning),
    intervalMs:Number(config.autoInventorySyncIntervalMs || 300000),
    serverNowUtc:now.toISOString(),
    serverNowTehran:time.formatTehranDateTime(now),
    stocksPerTick:Number(config.autoInventorySyncStocksPerTick || 1),
    pageLimit:Number(config.autoInventorySyncPageLimit || 300),
    activeWarehouseNumbers:active,
    cursor:autoInventoryStockCursor,
    nextStockNumber,
    serverNow:now,
    ...value,
    enabled:Boolean(config.autoInventorySyncEnabled),
    running:Boolean(inventorySyncRunning),
    nextStockNumber: value.nextStockNumber || nextStockNumber
  };
}

async function syncInventoryStock(stockNumber, pages = config.autoInventorySyncPageLimit, opts = {}) {
  const db = await connectMongo();
  const st = String(stockNumber || '').trim();
  if (!st) return { ok:false, stockNumber:st, error:'stockNumber required', completed:false };
  const safePages = Math.max(1, Number(pages || config.autoInventorySyncPageLimit || 300));
  const batchId = `${opts.batchPrefix || 'stock'}-${st}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = new Date();
  await saveAutoInventoryStatus({ enabled:Boolean(config.autoInventorySyncEnabled), running:true, lastStockNumber:st, lastStartedAt:startedAt, lastError:'', lastResult:null });
  let total = 0, page = 0, endedNaturally = false;
  try {
    for (let rowStart = 0; page < safePages; page++, rowStart += 100) {
      const res = await shaygan.getInventoryPage(rowStart, 100, { stockNumber:st });
      if (!res.ok) {
        const result = { ok:false, stockNumber:st, total, pages:page, error:res.error, batchId, completed:false, mode:'inventory-stock-positive-snapshot' };
        await db.collection('appLogs').insertOne({ type:'inventory_stock_sync_error', stockNumber:st, total, pages:page, error:res.error || '', batchId, at:new Date(), source:opts.source || 'manual' }).catch(()=>{});
        await saveAutoInventoryStatus({ running:false, lastRunAt:new Date(), lastStockNumber:st, lastResult:result, lastError:res.error || '' });
        return result;
      }
      if (!res.list.length) { endedNaturally = true; break; }
      const rows = (res.list || []).map(x => ({ ...x, stockNumber:String(x.stockNumber || st), syncBatchId:batchId, syncStockNumber:st, syncSource:opts.source || 'stock-filter-positive-sync' }));
      await upsertInventoryRows(db, rows);
      total += rows.length;
      if (res.list.length < 100) { endedNaturally = true; break; }
    }
    const completed = Boolean(endedNaturally && page < safePages);
    let removedStale = 0;
    let protectedFromStale = 0;
    let queuedForLiveVerify = 0;
    let liveMissingVerify = { checked:0, zeroedCount:0, failed:0, remainingQueued:0, results:[] };
    // 0.9.19.58: when a previously-positive row is absent from a completed warehouse sync,
    // exact live item GetRemain becomes authoritative. Missing active-warehouse rows are zeroed.
    if (completed) {
      liveMissingVerify = await verifyMissingStockRowsLive(db, st, batchId, 'completed-stock-sync-missing-row').catch(e => ({ checked:0, zeroedCount:0, failed:1, remainingQueued:0, results:[], error:String(e.message||e) }));
      removedStale = Number(liveMissingVerify.zeroedCount || 0);
      queuedForLiveVerify = Number(liveMissingVerify.remainingQueued || 0);
    }
    const result = { ok:true, stockNumber:st, total, pages:page, completed, endedNaturally, removedStale, protectedFromStale, queuedForLiveVerify, liveMissingVerify, batchId, durationMs:Date.now()-startedAt.getTime(), mode:'inventory-stock-authoritative-missing-live-reconcile' };
    await db.collection('appLogs').insertOne({ type:'inventory_stock_sync', stockNumber:st, total, pages:page, completed, endedNaturally, removedStale, batchId, at:new Date(), source:opts.source || 'manual', durationMs:result.durationMs }).catch(()=>{});
    await saveAutoInventoryStatus({ running:false, lastRunAt:new Date(), lastStockNumber:st, lastResult:result, lastError:'' });
    return result;
  } catch (e) {
    const err = String(e.message || e);
    const result = { ok:false, stockNumber:st, total, pages:page, error:err, batchId, completed:false, durationMs:Date.now()-startedAt.getTime(), mode:'inventory-stock-positive-snapshot-exception' };
    await db.collection('appLogs').insertOne({ type:'inventory_stock_sync_exception', stockNumber:st, total, pages:page, error:err, batchId, at:new Date(), source:opts.source || 'manual' }).catch(()=>{});
    await saveAutoInventoryStatus({ running:false, lastRunAt:new Date(), lastStockNumber:st, lastResult:result, lastError:err });
    return result;
  }
}


async function syncInventoryGlobal(pages = config.inventoryCatalogSyncPages, opts = {}) {
  const db = await connectMongo();
  const safePages = Math.max(1, Number(pages || config.inventoryCatalogSyncPages || config.autoInventorySyncPageLimit || 5000));
  const batchId = `${opts.batchPrefix || 'inv-global'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = new Date();
  await saveAutoInventoryStatus({
    enabled:Boolean(config.autoInventorySyncEnabled), running:true, mode:'global-getremain-no-stock-filter',
    lastStartedAt:startedAt, currentStockNumber:'ALL', lastStockNumber:'ALL', lastError:'', lastResult:null
  });
  let total = 0, page = 0, endedNaturally = false;
  const stocksTouched = new Set();
  try {
    for (let rowStart = 0; page < safePages; page++, rowStart += 100) {
      const res = await shaygan.getInventoryPage(rowStart, 100, {});
      if (!res.ok) {
        const result = { ok:false, total, pages:page, error:res.error || '', batchId, completed:false, mode:'global-getremain-no-stock-filter' };
        await db.collection('appLogs').insertOne({ type:'inventory_global_sync_error', total, pages:page, error:res.error || '', batchId, at:new Date(), source:opts.source || 'manual' }).catch(()=>{});
        await saveAutoInventoryStatus({ running:false, lastRunAt:new Date(), lastStockNumber:'ALL', lastResult:result, lastError:res.error || '' });
        return result;
      }
      if (!res.list.length) { endedNaturally = true; break; }
      const rows = (res.list || []).map(x => {
        const stockNumber = String(x.stockNumber || x.STNumber || x.StoreNumber || '').trim();
        if (stockNumber) stocksTouched.add(stockNumber);
        return { ...x, stockNumber, syncBatchId:batchId, syncStockNumber:stockNumber || 'UNKNOWN', syncSource:opts.source || 'global-getremain-no-stock-filter' };
      }).filter(x => x.itemCode && Number(x.quantity || 0) > 0);
      await upsertInventoryRows(db, rows);
      total += rows.length;
      if (page % 10 === 0) await saveAutoInventoryStatus({ running:true, mode:'global-getremain-no-stock-filter', currentPage:page+1, rowStart, total, stocksTouched:[...stocksTouched].slice(0,200) });
      if (res.list.length < 100) { endedNaturally = true; break; }
    }
    const completed = Boolean(endedNaturally && total > 0 && page < safePages);
    let removedStale = 0;
    // Global GetRemain is the most complete inventory source for Shaygan in this installation.
    // Stale delete is only allowed after a natural complete scan; otherwise old healthy rows remain untouched.
    let staleDeleteBlocked = false;
    let staleDeleteReason = '';
    let previousCompletedTotal = 0;
    const prevStatus = await readAutoInventoryStatus().catch(()=>({}));
    previousCompletedTotal = Number(prevStatus?.lastResult?.completed ? prevStatus.lastResult.total || 0 : 0);
    const minSafeTotal = previousCompletedTotal ? Math.floor(previousCompletedTotal * 0.70) : 0;
    let protectedFromStale = 0;
    let queuedForLiveVerify = 0;
    if (completed) {
      // 0.9.19.52: Global GetRemain is not fully authoritative in production tests.
      // Missing rows are marked for verification, never deleted/zeroed by Global alone.
      staleDeleteBlocked = true;
      staleDeleteReason = 'global sync is collector-only; positive rows not seen in this batch are protected and queued for live verify';
      const upd = await db.collection('itemInventoryCatalog').updateMany(
        { syncBatchId:{ $ne:batchId }, quantity:{ $gt:0 } },
        { $set:{ missingInGlobalSync:true, needsLiveVerify:true, protectedFromAutoSyncStale:true, lastMissingInGlobalAt:new Date() }, $inc:{ missingInGlobalCount:1 } }
      ).catch(()=>({ modifiedCount:0 }));
      protectedFromStale = upd.modifiedCount || 0;
      queuedForLiveVerify = protectedFromStale;
    }
    const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
    const result = { ok:true, total, pages:page, completed, endedNaturally, removedStale, protectedFromStale, queuedForLiveVerify, staleDeleteBlocked, staleDeleteReason, previousCompletedTotal, minSafeTotal, batchId, activeWarehouseNumbers:active, stocksTouched:[...stocksTouched], stocksTouchedCount:stocksTouched.size, durationMs:Date.now()-startedAt.getTime(), mode:'global-getremain-collector-no-delete-positive-protection' };
    await db.collection('appLogs').insertOne({ type:'inventory_global_sync', ...result, at:new Date(), source:opts.source || 'manual' }).catch(()=>{});
    await saveAutoInventoryStatus({ enabled:Boolean(config.autoInventorySyncEnabled), running:false, mode:result.mode, lastRunAt:new Date(), lastStockNumber:'ALL', currentStockNumber:'', nextStockNumber:'ALL', lastResult:result, lastError:'' });
    return result;
  } catch (e) {
    const err = String(e.message || e);
    const result = { ok:false, total, pages:page, error:err, batchId, completed:false, durationMs:Date.now()-startedAt.getTime(), mode:'global-getremain-no-stock-filter-exception' };
    await db.collection('appLogs').insertOne({ type:'inventory_global_sync_exception', total, pages:page, error:err, batchId, at:new Date(), source:opts.source || 'manual' }).catch(()=>{});
    await saveAutoInventoryStatus({ running:false, lastRunAt:new Date(), lastStockNumber:'ALL', lastResult:result, lastError:err });
    return result;
  }
}

async function syncCatalog(pages = config.inventoryCatalogSyncPages) {
  // 0.9.19.48: Swagger/GetRemain with STNumber filter omits a few rows per warehouse in this installation.
  // Manual catalog sync therefore uses one global GetRemain scan and trusts StoreNumber from each row.
  if (inventorySyncRunning) return { ok:false, error:'Sync موجودی در حال اجراست؛ چند دقیقه بعد دوباره تلاش کنید', mode:'global-getremain-no-stock-filter', running:true };
  inventorySyncRunning = true;
  try { return await syncInventoryReconciliation(pages || config.inventoryCatalogSyncPages, { source:'manual-catalog-sync-reconciliation', batchPrefix:'manual-recon-inv' }); }
  finally { inventorySyncRunning = false; }

  // Legacy fallback retained below but intentionally unreachable unless this function is manually edited.
  let total = 0, page = 0;
  let endedNaturally = false;
  const batchId = `inv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let rowStart = 0; page < pages; page++, rowStart += 100) {
    const res = await shaygan.getInventoryPage(rowStart, 100);
    if (!res.ok) return { ok:false, total, page, error:res.error, batchId, completed:false };
    if (!res.list.length) { endedNaturally = true; break; }
    const rows = (res.list || []).map(x => ({ ...x, syncBatchId:batchId }));
    await upsertInventoryRows(db, rows);
    total += rows.length;
    if (res.list.length < 100) { endedNaturally = true; break; }
  }
  const completed = Boolean(endedNaturally && total > 0 && page < Number(pages || 0));
  let removedStale = 0;
  if (completed) {
    const del = await db.collection('itemInventoryCatalog').deleteMany({ syncBatchId: { $ne: batchId } }).catch(()=>({ deletedCount:0 }));
    removedStale = del.deletedCount || 0;
  }
  await db.collection('appLogs').insertOne({ type:'inventory_catalog_sync', total, pages:page, completed, endedNaturally, removedStale, batchId, at:new Date() }).catch(()=>{});
  return { ok:true, total, pages:page, completed, endedNaturally, removedStale, batchId, mode:'inventory-catalog-positive-snapshot-safe-delete' };
}

async function syncInventoryReconciliation(pages = config.inventoryCatalogSyncPages, opts = {}) {
  // 0.9.19.53: Operational Auto Sync is reverted to active-warehouse stock-filter sync only.
  // Global GetRemain is kept out of auto sync because it produced duplicate/unstable merges in production.
  // Stock sync is positive-evidence only; no auto source may delete positive/local-sale rows.
  const db = await connectMongo();
  const startedAt = new Date();
  const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const batchId = `${opts.batchPrefix || 'active-stock-inv'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await saveAutoInventoryStatus({ enabled:Boolean(config.autoInventorySyncEnabled), running:true, mode:'active-stock-sync-positive-only', lastStartedAt:startedAt, currentStockNumber:'ACTIVE', lastError:'', lastResult:null, activeWarehouseNumbers:active });
  const stockResults = [];
  let stockTotal = 0;
  let stockCompleted = 0;
  let protectedFromStale = 0;
  for (const st of active || []) {
    await saveAutoInventoryStatus({ running:true, mode:'active-stock-sync-positive-only', currentStockNumber:String(st), lastStockNumber:String(st) });
    const r = await syncInventoryStock(st, Number(config.autoInventorySyncPageLimit || 300), { source:'auto-active-stock-filter-positive', batchPrefix:`${batchId}-stock` });
    stockTotal += Number(r.total || 0);
    if (r.completed) stockCompleted += 1;
    protectedFromStale += Number(r.protectedFromStale || 0);
    stockResults.push({ stockNumber:String(st), ok:r.ok, total:r.total||0, pages:r.pages||0, completed:!!r.completed, protectedFromStale:r.protectedFromStale||0, error:r.error||'' });
    const delay = Number(config.autoInventorySyncDelayBetweenStocksMs || 1000);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  const result = { ok:true, batchId, globalSkipped:true, stockResults, activeWarehouseNumbers:active, stockRows:stockTotal, stockCompleted, protectedFromStale, queuedForLiveVerify:protectedFromStale, durationMs:Date.now()-startedAt.getTime(), mode:'active-stock-sync-positive-only-no-global-no-delete', atTehran:time.formatTehranDateTime(new Date()) };
  await db.collection('appLogs').insertOne({ type:'inventory_active_stock_sync', ...result, at:new Date(), source:opts.source || 'auto' }).catch(()=>{});
  await saveAutoInventoryStatus({ enabled:Boolean(config.autoInventorySyncEnabled), running:false, mode:result.mode, lastRunAt:new Date(), lastStockNumber:'ACTIVE', currentStockNumber:'', nextStockNumber:'ACTIVE', lastResult:result, lastError:'' });
  return result;
}

async function runAutoInventorySyncTick() {
  const db = await connectMongo().catch(()=>null);
  if (!config.autoInventorySyncEnabled) {
    await saveAutoInventoryStatus({ enabled:false, running:false, lastSkippedAt:new Date(), lastSkipReason:'disabled' });
    return { ok:true, skipped:true, reason:'disabled' };
  }
  if (inventorySyncRunning) {
    await saveAutoInventoryStatus({ enabled:true, running:true, lastSkippedAt:new Date(), lastSkipReason:'previous-sync-running' });
    return { ok:true, skipped:true, reason:'previous sync still running' };
  }
  inventorySyncRunning = true;
  try {
    const result = await syncInventoryReconciliation(Number(config.autoInventorySyncPageLimit || config.inventoryCatalogSyncPages || 5000), { source:'auto-reconciliation-sync', batchPrefix:'auto-recon-inv' });
    if (db) await db.collection('appLogs').insertOne({ type:'auto_inventory_reconciliation_sync', ...result, at:new Date() }).catch(()=>{});
    return result;
  } catch (e) {
    const err = String(e.message || e);
    if (db) await db.collection('appLogs').insertOne({ type:'auto_inventory_sync_global_error', error:err, at:new Date() }).catch(()=>{});
    await saveAutoInventoryStatus({ enabled:true, running:false, lastRunAt:new Date(), lastError:err, lastResult:{ ok:false, error:err, mode:'auto-reconciliation-error' } });
    return { ok:false, error:err };
  } finally {
    inventorySyncRunning = false;
  }
}

function startAutoInventorySyncWorker() {
  saveAutoInventoryStatus({ enabled:Boolean(config.autoInventorySyncEnabled), running:false, workerStartedAt:new Date() }).catch(()=>{});
  if (!config.autoInventorySyncEnabled || autoInventoryTimer) return;
  const interval = Math.max(60000, Number(config.autoInventorySyncIntervalMs || 300000));
  // اجرای اولیه با تأخیر کوتاه؛ منتظر اولین ۵ دقیقه نمی‌مانیم.
  setTimeout(() => runAutoInventorySyncTick().catch(e => console.error('auto inventory sync initial warning:', e.message)), 15000);
  autoInventoryTimer = setInterval(() => {
    runAutoInventorySyncTick().catch(e => console.error('auto inventory sync warning:', e.message));
  }, interval);
  console.log(`auto inventory sync enabled: reconciliation cycle every ${interval}ms, pageLimit=${config.autoInventorySyncPageLimit}`);
}


async function getNextAvailableInvoiceNumber(invType = 2, startFrom = 0, maxAttempts = 10) {
  const last = await shaygan.getLastInvoiceNumber(invType);
  if (!last.ok) return { ok:false, error:last.error || `خواندن آخرین شماره فاکتور نوع ${invType} از شایگان ناموفق بود`, last };
  let candidate = Math.max(Number(last.last || 0), Number(startFrom || 0)) + 1;
  const checked = [];
  for (let i = 0; i < maxAttempts; i++, candidate++) {
    const g = await shaygan.getInvoice(candidate, invType).catch(e => ({ ok:false, error:String(e.message||e), list:[] }));
    checked.push({ invoiceNumber:candidate, ok:g.ok, exists:Array.isArray(g.list) && g.list.length > 0, error:g.error||'' });
    if (!g.ok) return { ok:false, error:g.error || 'بررسی وجود شماره فاکتور در شایگان ناموفق بود', checked, last };
    if (!Array.isArray(g.list) || g.list.length === 0) return { ok:true, invoiceNumber:candidate, lastShaygan:Number(last.last||0), checked, source:'shaygan-final-moment' };
  }
  return { ok:false, error:'شماره آزاد فاکتور در بازه تلاش پیدا نشد', checked, last };
}
function isDuplicateInvoiceError(msg='') {
  const x = String(msg || '');
  return /duplicate key|UniqueInvNo|IX_AC_4101_N_UniqueInvNo|شماره.*تکراری|تکراری/i.test(x);
}

async function reserveInvoiceNumber(reqBody) {
  const db = await connectMongo();
  const invType = Number(reqBody.invType || config.defaultSaleInvType);

  // Critical rule learned in purchase phase:
  // Sale and purchase invoice numbers are independent in Shaygan.
  // The old implementation always read getLastSaleInvoiceNumber(), even when invType=3,
  // which caused purchase invoices to be issued with the latest SALE number.
  const last = await shaygan.getLastInvoiceNumber(invType);
  if (!last.ok) return { ok:false, error:last.error || `خواندن آخرین شماره فاکتور نوع ${invType} از شایگان ناموفق بود`, last };
  const lastShaygan = Number(reqBody.lastShayganNumber || last.last || 0);

  const now = new Date();
  await db.collection('invoiceReservations').updateMany(
    { invType, status:'reserved', expiresAt:{ $lt: now } },
    { $set:{ status:'expired', expiredAt:now } }
  ).catch(()=>{});

  const active = await db.collection('invoiceReservations')
    .find({ invType, status:'reserved', expiresAt:{ $gt: now } })
    .sort({ invoiceNumber:-1 })
    .limit(1)
    .toArray();
  const activeMax = active.length ? Number(active[0].invoiceNumber || 0) : 0;

  // For purchase (InvTyp=3), never trust an old local counter if it is higher than Shaygan.
  // A polluted counter from sale numbering must not be allowed to dictate purchase numbers.
  const base = Math.max(lastShaygan, activeMax);
  if (invType === 3) {
    await db.collection('invoiceCounters').updateOne(
      { invType },
      { $set:{ invType, currentNumber:base, baseFromShaygan:lastShaygan, activeReservationMax:activeMax, resetReason:'purchase-number-authoritative-shaygan', updatedAt:now } },
      { upsert:true }
    );
  } else {
    const counter = await db.collection('invoiceCounters').findOne({ invType });
    if (!counter || Number(counter.currentNumber || 0) < base) {
      await db.collection('invoiceCounters').updateOne(
        { invType },
        { $set:{ invType, currentNumber:base, baseFromShaygan:lastShaygan, activeReservationMax:activeMax, updatedAt:now } },
        { upsert:true }
      );
    }
  }

  const updated = await db.collection('invoiceCounters').findOneAndUpdate(
    { invType },
    { $inc:{ currentNumber:1 }, $set:{ updatedAt:new Date(), lastReserveBy:reqBody.username || 'anonymous' } },
    { upsert:true, returnDocument:'after' }
  );
  const number = Number(updated.currentNumber);
  const doc = {
    invType,
    invoiceNumber:number,
    status:'reserved',
    userId:reqBody.userId || 'anonymous',
    username:reqBody.username || 'anonymous',
    draftId:reqBody.draftId || null,
    lastShaygan,
    activeReservationMax:activeMax,
    reservedAt:new Date(),
    expiresAt:new Date(Date.now() + config.invoiceReservationMinutes * 60000)
  };
  await db.collection('invoiceReservations').insertOne(doc);
  return { ok:true, reservation:doc, lastShaygan, activeReservationMax:activeMax, source:last };
}



async function markPurchaseIssueFailed(db, draftId, message, extra = {}) {
  try {
    await db.collection('purchaseDrafts').updateOne(
      { _id: draftId, status: { $ne: 'issued' } },
      { $set: { status: 'failed', lastIssueError: String(message || 'خطای ثبت خرید'), lastIssueAt: new Date(), updatedAt: new Date(), ...extra } }
    );
  } catch (e) { console.error('markPurchaseIssueFailed warning:', e.message); }
}

async function getUserMapping(username) {
  const db = await connectMongo();
  if (!username) return null;
  return await db.collection('userShayganMappings').findOne({ username, isActive: { $ne:false } });
}

async function resolveInvoiceMapping(body, user = null) {
  const db = await connectMongo();
  const isAdminUser = user && String(user.role || '') === 'admin';
  const username = isAdminUser
    ? String(body.mappingUsername || body.username || body.createdBy || user.username || 'admin').trim()
    : String(user?.username || body.mappingUsername || body.username || body.createdBy || '').trim();
  if (!username) throw new Error('کاربر صادرکننده مشخص نیست؛ از سیستم خارج و دوباره وارد شوید');
  let mapping = await getUserMapping(username);
  // Manual account fallback فقط برای مدیر مجاز است. فروشنده/بازرگانی نباید بتواند با body یا state قدیمی صندوق کاربر دیگر را استفاده کند.
  if (!mapping && isAdminUser && body.accountNumber && body.sAccountNumber) {
    mapping = { username, cashboxAccountNumber: body.accountNumber, employeeAccountNumber: body.sAccountNumber, fullName: body.username || username, role:'manual' };
  }
  if (!mapping) throw new Error('برای کاربر صادرکننده، اتصال صندوق و نماینده فروش در تنظیمات تعریف نشده است');
  if (!mapping.cashboxAccountNumber || !mapping.employeeAccountNumber) throw new Error(`اتصال شایگان کاربر ${username} ناقص است: صندوق یا حساب جاری/نماینده تعریف نشده`);
  return mapping;
}


// 0.9.19.24: Fast sale issue helpers. Shaygan Invoice/Put with InvNo=0 returns GuId and often Number=0;
// never trust Result[0].Number when it is 0. Resolve the real InvNo before enabling print.
function extractIssuedInvoiceMeta(issueResponse = {}) {
  const candidates = [];
  if (Array.isArray(issueResponse.result)) candidates.push(...issueResponse.result);
  if (Array.isArray(issueResponse.Result)) candidates.push(...issueResponse.Result);
  if (Array.isArray(issueResponse.raw?.Result)) candidates.push(...issueResponse.raw.Result);
  if (Array.isArray(issueResponse.raw?.result)) candidates.push(...issueResponse.raw.result);
  if (issueResponse.raw && typeof issueResponse.raw === 'object') candidates.push(issueResponse.raw);
  if (issueResponse && typeof issueResponse === 'object') candidates.push(issueResponse);
  let picked = null;
  for (const x of candidates) {
    if (!x || typeof x !== 'object') continue;
    const invoiceNumber = Number(x.Number || x.InvNo || x.InvoiceNumber || x.invoiceNumber || x.No || 0);
    const invoiceGuid = String(x.GuId || x.Guid || x.GUID || x.InvoiceGuId || x.invoiceGuid || '').trim();
    if (invoiceNumber > 0) { picked = { result:x, invoiceNumber, invoiceGuid }; break; }
  }
  if (!picked) picked = { result:candidates.find(x => x && typeof x === 'object') || {}, invoiceNumber:0, invoiceGuid:'' };
  const result = { ...(picked.result || {}) };
  if (picked.invoiceNumber > 0) result.Number = picked.invoiceNumber;
  if (picked.invoiceGuid && !result.GuId) result.GuId = picked.invoiceGuid;
  return { invoiceNumber:picked.invoiceNumber, invoiceGuid:picked.invoiceGuid || String(result.GuId || ''), result };
}
function invoicePrintUrl(invoiceNumber) {
  const n = Number(invoiceNumber || 0);
  return n > 0 ? `/print/invoice/${encodeURIComponent(String(n))}` : '';
}
function normInvDate8(v='') {
  const x = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0,10).replace(/-/g,'');
  const d = x.replace(/[^0-9]/g,'').slice(0,8);
  return d.length === 8 ? d : '';
}
function invoiceBodyAmount(inv = {}) {
  return (Array.isArray(inv.Body) ? inv.Body : []).reduce((s,x)=>s + Number(x.Amount || (Number(x.Quan||0) * Number(x.Price||0)) || 0), 0);
}
function saleRequestAmount(body = {}) {
  const rows = Array.isArray(body.items) ? body.items : [];
  const gross = rows.reduce((s,x)=>s + Number(x.quantity || x.Quan || 0) * Number(x.price || x.Price || 0) - Number(x.discountAmount || x.LineDiscAmount || 0), 0);
  return gross - Number(body.discountAmount || body.DiscAmount || 0) + saleInvoiceExtrasTotal(body.invoiceExtras || []);
}
function saleRequestLines(body = {}) {
  return (Array.isArray(body.items) ? body.items : []).map(x => ({
    itemCode:String(x.itemCode || x.ItemNumber || x.itemNumber || '').trim(),
    stockNumber:String(x.stockNumber || x.STNumber || x.stNumber || '').trim(),
    quantity:Number(x.quantity || x.Quan || 0),
    price:Number(x.price || x.Price || 0),
    amount:Number(x.amount || x.Amount || 0) || (Number(x.quantity || x.Quan || 0) * Number(x.price || x.Price || 0) - Number(x.discountAmount || x.LineDiscAmount || 0))
  })).filter(x => x.itemCode && x.stockNumber && x.quantity > 0);
}
function scoreIssuedInvoiceCandidate(inv = {}, body = {}, mapping = {}, putGuid = '', crmId = '') {
  let score = 0;
  const reasons = [];
  const invNo = Number(inv.InvNo || inv.Number || inv.InvoiceNumber || 0);
  if (invNo > 0) { score += 5; reasons.push('has-number'); }
  const invGuid = String(inv.GuId || inv.Guid || inv.InvGuId || inv.InvHeaderGuId || '').trim().toLowerCase();
  const pg = String(putGuid || '').trim().toLowerCase();
  if (pg && invGuid && pg === invGuid) { score += 10000; reasons.push('guid'); }
  const acc = String(inv.AccountNumber || '').trim();
  const sacc = String(inv.SAccountNumber || '').trim();
  if (mapping.cashboxAccountNumber && acc === String(mapping.cashboxAccountNumber)) { score += 900; reasons.push('account'); }
  if (mapping.employeeAccountNumber && sacc === String(mapping.employeeAccountNumber)) { score += 600; reasons.push('saccount'); }
  const reqDate = normInvDate8(body.invDate || shaygan.formatDate8(new Date()));
  const gotDate = normInvDate8(inv.InvDate || inv.InvoiceDate || '');
  if (reqDate && gotDate && reqDate === gotDate) { score += 400; reasons.push('date'); }
  const reqAmount = saleRequestAmount(body);
  const invAmount = Number(inv.SourceTotalAmount || inv.TotalAmount || 0) || invoiceBodyAmount(inv);
  if (reqAmount > 0 && invAmount > 0 && Math.abs(reqAmount - invAmount) <= 1) { score += 1200; reasons.push('amount'); }
  const desc = String(inv.InvDescription || inv.Description || '');
  if (crmId && desc.includes(String(crmId))) { score += 2500; reasons.push('crmId'); }
  const reqLines = saleRequestLines(body);
  const gotLines = Array.isArray(inv.Body) ? inv.Body : [];
  let lineHits = 0;
  for (const r of reqLines) {
    if (gotLines.some(g => String(g.ItemNumber||'').trim() === r.itemCode && String(g.STNumber||'').trim() === r.stockNumber && Math.abs(Number(g.Quan||0)-r.quantity) < 0.0001 && (!r.price || Math.abs(Number(g.Price||0)-r.price) <= 1))) lineHits++;
  }
  if (reqLines.length && lineHits === reqLines.length) { score += 1500; reasons.push('lines-all'); }
  else if (lineHits > 0) { score += lineHits * 250; reasons.push(`lines-${lineHits}`); }
  if (String(inv.FirstIssuerUsername||'') && String(mapping.fullName||'') && String(inv.FirstIssuerUsername).includes(String(mapping.fullName))) { score += 150; reasons.push('issuer'); }
  return { score, reasons, invNo, invGuid, reqAmount, invAmount };
}
async function resolveIssuedInvoiceAfterPut({ issueResponse = {}, body = {}, mapping = {}, invoiceType = 2, crmId = '' } = {}) {
  const issuedMeta = extractIssuedInvoiceMeta(issueResponse);
  const putGuid = issuedMeta.invoiceGuid || String(issueResponse?.raw?.Result?.[0]?.GuId || issueResponse?.result?.[0]?.GuId || '').trim();
  const out = { ok:false, invoiceNumber:issuedMeta.invoiceNumber || 0, invoiceGuid:putGuid || issuedMeta.invoiceGuid || '', result:issuedMeta.result || {}, method:'put-response', attempts:[] };
  if (out.invoiceNumber > 0) { out.ok = true; return out; }
  if (putGuid && typeof shaygan.getInvoiceByGuid === 'function') {
    const gr = await shaygan.getInvoiceByGuid(putGuid, invoiceType).catch(e => ({ ok:false, list:[], error:String(e.message||e) }));
    out.attempts.push({ method:'guid', ok:gr.ok, count:(gr.list||[]).length, error:gr.error||'' });
    const doc = (gr.list || []).find(x => Number(x.InvNo || x.Number || 0) > 0);
    if (doc) return { ok:true, invoiceNumber:Number(doc.InvNo || doc.Number), invoiceGuid:String(doc.GuId || putGuid || ''), result:{ ...doc, Number:Number(doc.InvNo || doc.Number), GuId:String(doc.GuId || putGuid || '') }, method:'guid', attempts:out.attempts };
  }
  const date = normInvDate8(body.invDate || shaygan.formatDate8(new Date())) || shaygan.formatDate8(new Date());
  const maxPages = Math.max(1, Math.min(Number(process.env.INVOICE_RESOLVE_MAX_PAGES || 40), 100));
  const candidates = [];
  for (let page = 0, rowStart = 0; page < maxPages; page++, rowStart += 20) {
    const r = await shaygan.getInvoicePageByDate(rowStart, invoiceType, date, date, 20);
    out.attempts.push({ method:'date-page', page, rowStart, ok:r.ok, count:(r.result||[]).length, error:r.error||'' });
    if (!r.ok) break;
    const list = r.result || [];
    if (!list.length) break;
    for (const inv of list) {
      const sc = scoreIssuedInvoiceCandidate(inv, body, mapping, putGuid, crmId);
      if (sc.invNo > 0 && sc.score >= 1700) candidates.push({ inv, sc });
    }
    if (list.length < 20) break;
  }
  candidates.sort((a,b) => b.sc.score - a.sc.score || Number(b.inv.InvNo||0) - Number(a.inv.InvNo||0));
  const best = candidates[0];
  if (best) {
    const n = Number(best.inv.InvNo || best.inv.Number || 0);
    const g = String(best.inv.GuId || putGuid || '');
    return { ok:true, invoiceNumber:n, invoiceGuid:g, result:{ ...best.inv, Number:n, GuId:g }, method:'date-search', matchScore:best.sc.score, matchReasons:best.sc.reasons, attempts:out.attempts };
  }
  out.method = 'unresolved';
  out.error = 'فاکتور صادر شد اما شماره واقعی با GUID/جستجوی امروز پیدا نشد';
  return out;
}

async function applyLocalSaleInventoryDeductAfterSuccess({ db, body, invoiceNumber, invoiceGuid, saleIssueKey }) {
  const now = new Date();
  const lines = (Array.isArray(body.items) ? body.items : []).map(x => ({
    itemCode:String(x.itemCode || x.ItemCode || x.ItemNumber || x.itemNumber || '').trim(),
    itemDescription:String(x.itemDescription || x.ItemDescription || x.ItemDesc || '').trim(),
    stockNumber:String(x.stockNumber || x.STNumber || x.stNumber || '').trim(),
    stockName:String(x.stockName || x.STDesc || x.stockName || '').trim(),
    stockGuid:String(x.stockGuid || x.STGuId || x.StockGuId || '').trim(),
    itemGuid:String(x.itemGuid || x.ItemGuId || x.ItemGuid || '').trim(),
    quantity:Number(x.quantity || x.Quan || 0)
  })).filter(x => x.itemCode && x.stockNumber && x.quantity > 0);
  const out = [];
  for (const line of lines) {
    const cur = await db.collection('itemInventoryCatalog').findOne({ itemCode:line.itemCode, stockNumber:line.stockNumber }).catch(()=>null);
    const beforeQty = Number(cur?.quantity || 0);
    const afterQty = Math.max(0, beforeQty - Number(line.quantity || 0));
    const set = {
      itemCode:line.itemCode,
      itemDescription:cur?.itemDescription || line.itemDescription,
      itemGuid:cur?.itemGuid || line.itemGuid,
      stockNumber:line.stockNumber,
      stockName:cur?.stockName || line.stockName,
      stockGuid:cur?.stockGuid || line.stockGuid,
      quantity:afterQty,
      lastLocalSaleDeductAt:now,
      lastSaleInvoiceNo:Number(invoiceNumber||0) || String(invoiceNumber||''),
      lastSaleInvoiceGuid:String(invoiceGuid||''),
      lastSaleIssueKey:String(saleIssueKey||''),
      pendingShayganConfirm:true,
      inventoryConfidence:'local-sale-deduct',
      updatedAt:now,
      syncedAt:now,
      searchText: normalizeFa(`${line.itemCode} ${cur?.itemDescription || line.itemDescription} ${line.stockNumber} ${cur?.stockName || line.stockName}`)
    };
    await db.collection('itemInventoryCatalog').updateOne(
      { itemCode:line.itemCode, stockNumber:line.stockNumber },
      { $set:set, $addToSet:{ sourceEvidence:'local-sale-deduct' } },
      { upsert:true }
    ).catch(()=>{});
    out.push({ itemCode:line.itemCode, stockNumber:line.stockNumber, soldQty:line.quantity, beforeQty, afterQty });
  }
  await db.collection('appLogs').insertOne({ type:'sale_issue_local_inventory_deduct', invoiceNumber, invoiceGuid, saleIssueKey, lines:out, at:now, atTehran:time.formatTehranDateTime(now) }).catch(()=>{});
  return { ok:true, lines:out, lineCount:out.length };
}

async function activeQtyForItemFromMongo(db, itemCode) {
  const activeWarehouseNumbers = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const activeSet = new Set((activeWarehouseNumbers || []).map(x => String(x || '').trim()).filter(Boolean));
  const find = { itemCode:String(itemCode||'').trim(), quantity:{ $gt:0 } };
  if (activeSet.size) find.stockNumber = { $in:[...activeSet] };
  const rows = await db.collection('itemInventoryCatalog').find(find).toArray().catch(()=>[]);
  const totalQty = rows.reduce((s,x)=>s + Number(x.quantity || 0), 0);
  return { totalQty, rows, activeWarehouseNumbers };
}

async function runSaleIssuePostProcessing({ db, body, result, invoiceNumber, invoiceGuid, saleIssueKey, leadManual, mappingView, user }) {
  const timings = {};
  const started = Date.now();
  try {
    const invoiceTotal = saleRequestAmount(body);
    let t = Date.now();
    const localInventoryDeduct = await applyLocalSaleInventoryDeductAfterSuccess({ db, body, invoiceNumber, invoiceGuid, saleIssueKey }).catch(e => ({ ok:false, error:String(e.message||e), lines:[] }));
    timings.localInventoryDeductMs = Date.now() - t;
    await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ localInventoryDeduct } }).catch(()=>{});
    t = Date.now();
    const boardStockOut = await createStockOutBoardEventsAfterSale({ db, body, result, mapping:mappingView, user:user||{}, invoiceNumber, invoiceGuid, localInventoryDeduct, saleIssueKey, source:'sale_invoice_issue_local_snapshot_after_deduct' }).catch(e => [{ ok:false, error:String(e.message||e) }]);
    timings.boardMs = Date.now() - t;
    await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ boardStockOut } }).catch(()=>{});
    t = Date.now();
    const customer = await upsertCustomerForSale(body, { invoiceNumber:String(invoiceNumber||''), invoiceType:2, invoiceDate:new Date(), totalAmount:invoiceTotal, leadId:leadManual.leadId, sellerUsername:mappingView.username, sellerName:mappingView.fullName, sellerStore:mappingView.storeName||'', cashboxAccountNumber:mappingView.cashboxAccountNumber||'' });
    timings.customerMs = Date.now() - t;
    let leadSync = { ok:false, status: leadManual.leadId ? 'pending' : 'not_required' };
    if (leadManual.leadId) {
      t = Date.now();
      leadSync = await postLeadIdCloseSale({
        leadId: leadManual.leadId, leadCode: leadManual.leadId,
        invoiceNo: String(invoiceNumber || ''), mkcrmInvoiceNo: String(invoiceNumber || ''), shayganInvoiceNo: String(invoiceNumber || ''), mkcrmInvoiceId: saleIssueKey, saleIssueKey,
        shayganGuid: String(invoiceGuid || ''), invoiceDate: new Date().toISOString(), invoiceTotal,
        closerUsername: mappingView.username || '', closerFullName: mappingView.fullName || '', closerStoreName: mappingView.storeName || '', sellerName: mappingView.fullName || '',
        customerName: String(body.customerName || body.customerFullName || body.name || ''), customerMobile: String(body.customerMobile || body.mobile || body.phone || ''), source: 'mkcrm'
      });
      timings.leadMs = Date.now() - t;
    }
    await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ customerId: customer?._id || null, leadSyncStatus: leadSync.status || (leadSync.ok?'success':'failed'), leadSyncOk: Boolean(leadSync.ok), leadSyncError: leadSync.ok ? '' : String(leadSync.error || ''), leadSyncedAt: leadSync.ok ? new Date() : null, leadSyncResponse: leadSync.response || null } }).catch(()=>{});
    await db.collection('leadSyncLogs').insertOne({ type:'sale_issue_lead_sync', saleIssueKey, leadId:leadManual.leadId, invoiceNo:String(invoiceNumber||''), ok:Boolean(leadSync.ok), status:leadSync.status || '', error:leadSync.error || '', response:leadSync.response || null, at:new Date(), mapping:mappingView }).catch(()=>{});
    await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ postProcessingStatus:'done', postProcessingDoneAt:new Date(), postProcessingTimings:{ ...timings, totalMs:Date.now()-started } } }).catch(()=>{});
  } catch (e) {
    await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ postProcessingStatus:'failed', postProcessingError:String(e.message||e), postProcessingFailedAt:new Date(), postProcessingTimings:{ ...timings, totalMs:Date.now()-started } } }).catch(()=>{});
    await db.collection('appLogs').insertOne({ type:'sale_issue_post_processing_error', saleIssueKey, error:String(e.message||e), at:new Date() }).catch(()=>{});
  }
}

function stableSaleIssueKey(body, mapping) {
  const explicit = String(body.saleIssueKey || body.issueKey || '').trim();
  if (explicit) return `sale:${explicit}`;
  const items = Array.isArray(body.items) ? body.items.map(x => ({
    itemNumber: String(x.itemNumber || x.itemCode || '').trim(),
    stNumber: String(x.stockNumber || x.STNumber || x.stNumber || '').trim(),
    quantity: Number(x.quantity || x.Quan || 0),
    price: Number(x.price || x.Price || 0),
    serials: x.serials || x.Serials || []
  })) : [];
  const core = {
    mappingUsername: mapping?.username || body.mappingUsername || '',
    invoiceNumber: Number(body.invoiceNumber || 0) || null,
    customerName: String(body.customerName || '').trim(),
    mobile: String(body.mobile || '').trim(),
    nationalCode: String(body.nationalCode || '').trim(),
    discountAmount: Number(body.discountAmount || body.DiscAmount || 0),
    items
  };
  return 'sale:auto:' + crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 32);
}

async function beginSaleIssueLock(db, issueKey, body, mapping) {
  const now = new Date();
  const staleBefore = new Date(Date.now() - 3 * 60 * 1000);
  const existing = await db.collection('saleIssueLocks').findOne({ _id: issueKey });
  if (existing) {
    if (existing.status === 'issued') return { ok:false, duplicate:true, issued:true, existing };
    if (existing.status === 'issuing' && existing.startedAt && new Date(existing.startedAt) > staleBefore) return { ok:false, inProgress:true, existing };
  }
  await db.collection('saleIssueLocks').updateOne(
    { _id: issueKey },
    { $set:{ status:'issuing', startedAt:now, updatedAt:now, invoiceNumber:Number(body.invoiceNumber || 0) || null, mappingUsername:mapping.username, requestPreview:{ customerName:body.customerName||'', mobile:body.mobile||'', itemsCount:Array.isArray(body.items)?body.items.length:0, discountAmount:Number(body.discountAmount||0) } }, $setOnInsert:{ createdAt:now } },
    { upsert:true }
  );
  return { ok:true };
}


async function upsertCustomerForSale(body = {}, meta = {}) {
  const db = await connectMongo();
  const fullName = String(body.customerName || body.fullName || body.name || '').trim();
  const mobile = normalizeMobile(body.mobile || '');
  const nationalCode = normalizeNationalCode(body.nationalCode || '');
  if (!fullName && !mobile && !nationalCode) return null;

  const key = mobile ? `mobile:${mobile}` : nationalCode ? `nc:${nationalCode}` : `name:${normalizeFa(fullName)}`;
  const ors = [{ customerKey:key }];
  if (mobile) ors.push({ mobile }, { mobiles: mobile });
  if (nationalCode) ors.push({ nationalCode });
  if (!mobile && !nationalCode && fullName) ors.push({ fullName });
  const existing = await db.collection('customers').findOne({ $or: ors });
  const filter = existing ? { _id: existing._id } : { customerKey:key };

  const items = Array.isArray(body.items) ? body.items : [];
  const invoiceTotal = Number(meta.totalAmount || body.totalAmount || items.reduce((s,x)=>s + Number(x.quantity||x.Quan||0)*Number(x.price||x.Price||0),0) || 0);
  const invoiceNumber = String(meta.invoiceNumber || body.invoiceNumber || '').trim();
  const invoiceType = Number(meta.invoiceType || 2);
  const invoiceKey = invoiceNumber ? `${invoiceType}:${invoiceNumber}` : '';
  const previousKeys = Array.isArray(existing?.invoiceKeys) ? existing.invoiceKeys : [];
  const isNewInvoiceForCustomer = invoiceKey && !previousKeys.includes(invoiceKey);
  const now = new Date();
  const invoiceDate = meta.invoiceDate || now;
  const leadId = normalizeManualLeadId(body.leadId || body.leadCode || body.leadID || meta.leadId || '');

  const purchaseCount = Number(existing?.purchaseCount || 0) + (isNewInvoiceForCustomer ? 1 : (!existing && invoiceKey ? 1 : 0));
  const totalPurchaseAmount = Number(existing?.totalPurchaseAmount || 0) + (isNewInvoiceForCustomer ? invoiceTotal : (!existing && invoiceKey ? invoiceTotal : 0));
  const firstPurchaseDate = existing?.firstPurchaseDate || invoiceDate;
  const lastPurchaseDate = invoiceDate;
  const qinfo = customerDataQuality({ fullName, mobile, nationalCode });
  const channel = classifyCustomerChannel({ cashboxAccountNumber: meta.cashboxAccountNumber || body.accountNumber || '', cashboxName: meta.cashboxName || '', sellerStore: meta.sellerStore || meta.storeName || '' });
  const searchText = normalizeFa([fullName, mobile, nationalCode, leadId, channel.sourceStore, channel.channelLabel].filter(Boolean).join(' '));

  if (invoiceKey) {
    await db.collection('customerInvoiceHistory').updateOne(
      { customerKey:key, invTyp:invoiceType, invNo:Number(invoiceNumber)||invoiceNumber },
      { $set:{ customerKey:key, invTyp:invoiceType, invNo:Number(invoiceNumber)||invoiceNumber, invDate:invoiceDate, totalAmount:invoiceTotal, leadId, source:'crm-sale', sellerUsername:meta.sellerUsername||'', sellerName:meta.sellerName||'', sellerStore:meta.sellerStore||meta.storeName||'', cashboxAccountNumber:meta.cashboxAccountNumber||body.accountNumber||'', salesChannel:channel.salesChannel, businessUnit:channel.businessUnit, channelLabel:channel.channelLabel, sourceStore:channel.sourceStore, updatedAt:now }, $setOnInsert:{ createdAt:now } },
      { upsert:true }
    ).catch(()=>{});
  }

  const setDoc = {
    customerKey:key,
    fullName: fullName || existing?.fullName || existing?.customerName || '',
    mobile: mobile || existing?.mobile || '',
    nationalCode: nationalCode || existing?.nationalCode || '',
    searchText,
    purchaseCount,
    totalPurchaseAmount,
    repeatedCustomer: purchaseCount >= 2,
    firstPurchaseDate,
    lastPurchaseDate,
    lastInvoiceNo: invoiceNumber || existing?.lastInvoiceNo || '',
    lastInvoiceType: invoiceType,
    lastLeadId: leadId || existing?.lastLeadId || '',
    lastSellerUsername: meta.sellerUsername || existing?.lastSellerUsername || '',
    lastSellerName: meta.sellerName || existing?.lastSellerName || '',
    lastSellerStore: meta.sellerStore || meta.storeName || existing?.lastSellerStore || '',
    lastSalesChannel: channel.salesChannel,
    lastBusinessUnit: channel.businessUnit,
    lastSourceStore: channel.sourceStore,
    lastSource:'crm-sale',
    dataQualityStatus:qinfo.status,
    dataQualityFlags:qinfo.flags,
    trustScore:qinfo.trustScore,
    updatedAt:now
  };
  const update = {
    $set:setDoc,
    $setOnInsert:{ createdAt:now, firstSource:'crm-sale' }
  };
  if (mobile) update.$addToSet = { ...(update.$addToSet||{}), mobiles: mobile };
  if (invoiceKey) update.$addToSet = { ...(update.$addToSet||{}), invoiceKeys: invoiceKey };
  await db.collection('customers').updateOne(filter, update, { upsert:true });
  return await db.collection('customers').findOne(filter);
}

async function logAction(type, payload = {}) {
  try { const db = await connectMongo(); await db.collection('appLogs').insertOne({ type, ...payload, at:new Date() }); } catch(e) { console.error('logAction warning:', e.message); }
}

function normalizeProformaQuery(query = {}) {
  const filter = {};
  if (query.status) filter.status = String(query.status);
  if (query.mobile) filter.mobile = new RegExp(String(query.mobile).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
  if (query.customerName) filter.customerName = new RegExp(String(query.customerName).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
  if (query.q) {
    const q = String(query.q).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    filter.$or = [{ customerName:new RegExp(q,'i') }, { mobile:new RegExp(q,'i') }, { leadId:new RegExp(q,'i') }];
    if (/^\d+$/.test(String(query.q))) filter.$or.push({ proformaNo:Number(query.q) });
  }
  return filter;
}

async function visibleProformaFilter(req, query = {}) {
  const user = currentUser(req);
  const filter = normalizeProformaQuery(query);
  if (!user) return { ...filter, _never:true };
  if (!['admin','accounting','warehouse','purchase'].includes(user.role)) filter.createdBy = user.username;
  return filter;
}



// --- 0.9.6 Customer bank from Shaygan sales invoices ---
function faDigitsToEn(v='') {
  return String(v || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}
function normalizePhone09(v='') {
  let x = faDigitsToEn(v).replace(/[^0-9]/g, '');
  if (x.startsWith('0098')) x = '0' + x.slice(4);
  if (x.startsWith('98')) x = '0' + x.slice(2);
  if (x.length === 10 && x.startsWith('9')) x = '0' + x;
  return x;
}
function extractMobiles(text='') {
  const t = faDigitsToEn(text);
  const out = [];
  const seen = new Set();
  const re = /(?:\+?98|0098|0)?9\d{9}/g;
  let m;
  while ((m = re.exec(t))) {
    const x = normalizePhone09(m[0]);
    if (/^09\d{9}$/.test(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}
function extractNationalCode(text='') {
  const t = faDigitsToEn(text);
  const candidates = t.match(/\b\d{10}\b/g) || [];
  for (const c of candidates) {
    if (/^09/.test(c)) continue;
    if (/^(\d)\1{9}$/.test(c)) continue;
    return c;
  }
  return '';
}
function cleanCustomerName(text='') {
  let s = String(text || '');
  s = s.replace(/خریدار\s*[:：]/g,' ')
       .replace(/موبایل\s*[:：]/g,' ')
       .replace(/کد\s*ملی\s*[:：]?/g,' ')
       .replace(/Lead\s*[:：]?/gi,' ')
       .replace(/CRM\s*[:：]?/gi,' ');
  s = faDigitsToEn(s).replace(/(?:\+?98|0098|0)?9\d{9}/g,' ').replace(/\b\d{10}\b/g,' ');
  s = s.replace(/[|،,;؛:\-_/\\()\[\]{}]+/g,' ').replace(/\s+/g,' ').trim();
  const stop = ['فاکتور','فروش','شماره','رفرنس','کارت','ش','ک','ک م','کد','ملی','نقدی'];
  let parts = s.split(' ').filter(x => x && !stop.includes(x));
  if (parts.length > 5) parts = parts.slice(0,5);
  return parts.join(' ').trim();
}

function normalizeNationalCode(v='') {
  return faDigitsToEn(v).replace(/[^0-9]/g,'').slice(0, 10);
}
function isValidIranNationalCode(code='') {
  const c = normalizeNationalCode(code);
  if (!/^\d{10}$/.test(c)) return false;
  if (/^(\d)\1{9}$/.test(c)) return false;
  const check = Number(c[9]);
  const sum = c.slice(0,9).split('').reduce((a,d,i)=>a + Number(d) * (10 - i), 0);
  const r = sum % 11;
  return r < 2 ? check === r : check === 11 - r;
}
function isSuspiciousMobile(mobile='') {
  const m = normalizePhone09(mobile);
  if (!m) return false;
  if (!/^09\d{9}$/.test(m)) return true;
  if (/^09(\d)\1{8}$/.test(m.slice(0,11))) return true;
  if (['09000000000','09111111111','09222222222','09333333333','09123456789','09012345678','09999999999'].includes(m)) return true;
  return false;
}
function isGenericCustomerName(name='') {
  const n = normalizeFa(name).replace(/\s+/g,' ').trim();
  if (!n) return true;
  const bad = ['مشتری','مشتری نقدی','نقدی','عمومی','متفرقه','نامشخص','test','تست','خریدار'];
  return bad.includes(n) || n.length < 3;
}
function customerDataQuality({ fullName='', mobile='', nationalCode='' } = {}) {
  const m = normalizePhone09(mobile);
  const nc = normalizeNationalCode(nationalCode);
  const flags = [];
  if (!m) flags.push('missing_mobile');
  else if (isSuspiciousMobile(m)) flags.push('invalid_mobile');
  if (!nc) flags.push('missing_national_code');
  else if (!isValidIranNationalCode(nc)) flags.push('invalid_national_code');
  if (isGenericCustomerName(fullName)) flags.push('generic_or_missing_name');
  let status = 'valid';
  if (flags.some(x=>x.startsWith('invalid'))) status = 'invalid';
  else if (flags.includes('missing_mobile') && flags.includes('missing_national_code')) status = 'incomplete';
  else if (flags.length) status = 'partial';
  let score = 100;
  if (flags.includes('missing_mobile')) score -= 25;
  if (flags.includes('invalid_mobile')) score -= 45;
  if (flags.includes('missing_national_code')) score -= 15;
  if (flags.includes('invalid_national_code')) score -= 45;
  if (flags.includes('generic_or_missing_name')) score -= 20;
  return { status, flags, trustScore: Math.max(0, score), mobile:m, nationalCode:nc };
}

function isCashboxAccount(accountNumber='', accountName='') {
  const n = String(accountNumber || '');
  const name = String(accountName || '');
  return n.startsWith('11001') || name.includes('صندوق');
}
function classifyCustomerChannel({ accountNumber='', accountName='', cashboxAccountNumber='', cashboxName='', sellerStore='' } = {}) {
  const raw = normalizeFa([accountNumber, accountName, cashboxAccountNumber, cashboxName, sellerStore].filter(Boolean).join(' '));
  if (isSiteCashboxText(raw)) {
    return { salesChannel:'site', businessUnit:'site', channelLabel:'سایت', sourceStore:String(accountName || cashboxName || sellerStore || 'سایت / صندوق مشهد کالا') };
  }
  if (isConsoleCashboxText(raw)) {
    return { salesChannel:'store', businessUnit:'console', channelLabel:'کنسول', sourceStore:String(accountName || cashboxName || sellerStore || 'بخش کنسول') };
  }
  if (sellerStore) return { salesChannel:'store', businessUnit:'retail', channelLabel:'حضوری', sourceStore:String(sellerStore||'') };
  if (isCashboxAccount(accountNumber || cashboxAccountNumber, accountName || cashboxName)) {
    return { salesChannel:'store', businessUnit:'cashbox', channelLabel:'صندوق', sourceStore:String(accountName || cashboxName || 'صندوق') };
  }
  return { salesChannel:'unknown', businessUnit:'unknown', channelLabel:'نامشخص', sourceStore:'' };
}
function isSiteCashboxText(text='') {
  const raw = normalizeFa(String(text || ''));
  return raw.includes('صندوق مشهد کالا') || raw.includes('صندوق مشهد كالا') || raw.includes('صندوق سایت') || raw.includes('صندوق سايت') || raw.includes('سایت مشهد کالا') || raw.includes('سايت مشهد كالا');
}
function isConsoleCashboxText(text='') {
  const raw = normalizeFa(String(text || ''));
  return raw.includes('صندوق کنسول') || raw.includes('صندوق كنسول') || raw.includes('بخش کنسول') || raw.includes('بخش كنسول');
}
function siteHistoryFilter() {
  const rx = /(صندوق\s*مشهد\s*[کك]الا|صندوق\s*سایت|صندوق\s*سايت|سایت\s*مشهد\s*[کك]الا|سايت\s*مشهد\s*[کك]الا)/i;
  return { $or:[
    { salesChannel:'site' }, { businessUnit:'site' }, { channelLabel:'سایت' },
    { accountName:{ $regex:rx } }, { sourceStore:{ $regex:rx } }, { cashboxName:{ $regex:rx } }, { description:{ $regex:rx } }
  ] };
}
function consoleHistoryFilter() {
  const rx = /(صندوق\s*[کك]نسول|بخش\s*[کك]نسول)/i;
  return { $or:[
    { businessUnit:'console' }, { channelLabel:'کنسول' },
    { accountName:{ $regex:rx } }, { sourceStore:{ $regex:rx } }, { cashboxName:{ $regex:rx } }, { description:{ $regex:rx } }
  ] };
}
async function repairCustomerChannelTagsFromHistory(db) {
  const now = new Date();
  const site = siteHistoryFilter();
  const consoleF = consoleHistoryFilter();
  const siteRes = await db.collection('customerInvoiceHistory').updateMany(site, { $set:{ salesChannel:'site', businessUnit:'site', channelLabel:'سایت', updatedAt:now } }).catch(e=>({ modifiedCount:0, error:e.message }));
  const consoleRes = await db.collection('customerInvoiceHistory').updateMany(consoleF, { $set:{ salesChannel:'store', businessUnit:'console', channelLabel:'کنسول', updatedAt:now } }).catch(e=>({ modifiedCount:0, error:e.message }));
  const siteKeys = await db.collection('customerInvoiceHistory').distinct('customerKey', site).catch(()=>[]);
  const consoleKeys = await db.collection('customerInvoiceHistory').distinct('customerKey', consoleF).catch(()=>[]);
  if (siteKeys.length) await db.collection('customers').updateMany({ customerKey:{ $in:siteKeys } }, { $addToSet:{ salesChannels:'site', businessUnits:'site' }, $set:{ lastSalesChannel:'site', updatedAt:now } }).catch(()=>{});
  if (consoleKeys.length) await db.collection('customers').updateMany({ customerKey:{ $in:consoleKeys } }, { $addToSet:{ salesChannels:'store', businessUnits:'console' }, $set:{ lastBusinessUnit:'console', updatedAt:now } }).catch(()=>{});
  return { siteModified:siteRes.modifiedCount||0, consoleModified:consoleRes.modifiedCount||0, siteCustomers:siteKeys.length, consoleCustomers:consoleKeys.length };
}
function invoiceCustomerCandidate(inv={}) {
  const desc = String(inv.InvDescription || inv.Description || '').trim();
  const accountName = String(inv.AccountName || '').trim();
  const accountNumber = String(inv.AccountNumber || '').trim();
  const mobiles = extractMobiles(desc);
  const nationalCode = extractNationalCode(desc);
  let fullName = cleanCustomerName(desc);
  let sourceType = 'description';
  if (!fullName && !isCashboxAccount(accountNumber, accountName) && accountName) { fullName = accountName; sourceType = 'account'; }
  if (!fullName && !mobiles.length && !nationalCode) return null;
  const body = Array.isArray(inv.Body) ? inv.Body : [];
  const totalAmount = body.reduce((s,x)=>s+Number(x.Amount||0),0);
  return { fullName, mobile: mobiles[0] || '', mobiles, nationalCode, sourceType, invoiceNumber:Number(inv.InvNo||0), invoiceType:Number(inv.InvTyp||0), invDate:String(inv.InvDate||''), accountNumber, accountName, totalAmount, itemsCount:body.length, description:desc };
}
function customerKey(c={}) { return c.mobile ? `mobile:${c.mobile}` : c.nationalCode ? `nc:${c.nationalCode}` : `name:${normalizeFa(c.fullName||'')}`; }
async function upsertCustomerFromInvoice(db, c) {
  const key = customerKey(c);
  if (!key || key === 'name:') return null;
  const now = new Date();
  const invoiceKey = `${c.invoiceType}:${c.invoiceNumber}`;
  await db.collection('customerInvoiceHistory').updateOne(
    { customerKey:key, invTyp:c.invoiceType, invNo:c.invoiceNumber },
    { $set:{ customerKey:key, invTyp:c.invoiceType, invNo:c.invoiceNumber, invDate:c.invDate, totalAmount:c.totalAmount, accountNumber:c.accountNumber, accountName:c.accountName, description:c.description, updatedAt:now }, $setOnInsert:{ createdAt:now } },
    { upsert:true }
  );
  const existing = await db.collection('customers').findOne({ customerKey:key });
  const invoices = Array.isArray(existing?.invoiceKeys) ? existing.invoiceKeys : [];
  const already = invoices.includes(invoiceKey);
  const purchaseCount = Number(existing?.purchaseCount || 0) + (already ? 0 : 1);
  const totalPurchaseAmount = Number(existing?.totalPurchaseAmount || 0) + (already ? 0 : Number(c.totalAmount || 0));
  const lastDate = [existing?.lastPurchaseDate || '', c.invDate || ''].sort().pop() || c.invDate || '';
  const firstDate = [existing?.firstPurchaseDate || c.invDate || '', c.invDate || ''].filter(Boolean).sort()[0] || c.invDate || '';
  const fullName = c.fullName || existing?.fullName || '';
  const mobile = c.mobile || existing?.mobile || '';
  const nationalCode = c.nationalCode || existing?.nationalCode || '';
  const searchText = normalizeFa(`${fullName} ${mobile} ${nationalCode} ${(c.mobiles||[]).join(' ')} ${c.accountName||''}`);
  await db.collection('customers').updateOne(
    { customerKey:key },
    { $set:{ customerKey:key, fullName, mobile, mobiles:Array.from(new Set([...(existing?.mobiles||[]), ...(c.mobiles||[]), mobile].filter(Boolean))), nationalCode, searchText, purchaseCount, totalPurchaseAmount, repeatedCustomer:purchaseCount>=2, firstPurchaseDate:firstDate, lastPurchaseDate:lastDate, lastInvoiceNo:c.invoiceNumber, lastInvoiceType:c.invoiceType, lastSource:'shaygan-sales', updatedAt:now }, $setOnInsert:{ createdAt:now, firstSource:'shaygan-sales' }, $addToSet:{ invoiceKeys:invoiceKey } },
    { upsert:true }
  );
  return { key, purchaseCount, repeatedCustomer:purchaseCount>=2 };
}
function date8NDaysAgo(days=365) {
  const d = new Date(); d.setDate(d.getDate() - Number(days||365));
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
async function syncCustomersFromShayganSales({ days=365, pages=80 } = {}) {
  const db = await connectMongo();
  const run = { type:'customer_shaygan_sales_sync', days:Number(days||365), pages:Number(pages||80), startedAt:new Date(), status:'running' };
  const ins = await db.collection('customerSyncRuns').insertOne(run);
  const dateFrom = date8NDaysAgo(days), dateTo = shaygan.formatDate8(new Date());
  const invTypes = [2, 13];
  let scanned=0, candidates=0, upserts=0;
  const errors=[];
  for (const invType of invTypes) {
    for (let page=0, rowStart=0; page<Number(pages||80); page++, rowStart+=20) {
      const r = await shaygan.getInvoicePageByDate(rowStart, invType, dateFrom, dateTo, 20);
      scanned += 1;
      if (!r.ok) { errors.push({ invType, page, error:r.error||'' }); break; }
      const list = r.result || [];
      if (!list.length) break;
      for (const inv of list) {
        const c = invoiceCustomerCandidate(inv);
        if (!c) continue;
        candidates++;
        await upsertCustomerFromInvoice(db, c);
        upserts++;
      }
      if (list.length < 20) break;
    }
  }
  await db.collection('customerSyncRuns').updateOne({ _id:ins.insertedId }, { $set:{ status:'done', finishedAt:new Date(), dateFrom, dateTo, scannedPages:scanned, candidates, upserts, errors } });
  await logAction('customer_shaygan_sales_sync', { dateFrom, dateTo, scannedPages:scanned, candidates, upserts, errorsCount:errors.length });
  return { ok:true, dateFrom, dateTo, scannedPages:scanned, candidates, upserts, errors };
}


async function syncCustomersFromSqlFiscalDbs({ databases=['CY000002','CY000001'], maxRowsPerDb=50000 } = {}) {
  // 0.9.19.17→WS: sync مشتریان از SQL حذف شد؛ از WebService فاکتورهای فروش sync می‌شود
  const db = await connectMongo();
  try {
    const invFetch = await fetchSaleInvoicesFromShayganWebService({ from8:'', to8:'', maxPages: Math.min(Number(maxRowsPerDb/20||2500), 3000) });
    if (!invFetch.ok) return { ok:false, error:invFetch.error, source:'webservice-customer-sync' };
    let synced=0;
    for (const inv of (invFetch.list||[])) {
      const accountNumber = String(inv.AccountNumber||inv.accountNumber||'').trim();
      const accountName = String(inv.AccountName||inv.accountName||'').trim();
      if (!accountNumber) continue;
      const searchText = normalizeFa(`${accountName} ${accountNumber}`);
      await db.collection('accountCatalog').updateOne({ accountNumber }, { $set:{ accountNumber, accountName, searchText, updatedAt:new Date() }, $setOnInsert:{ createdAt:new Date() } }, { upsert:true }).catch(()=>{});
      synced++;
    }
    await db.collection('customerSyncRuns').insertOne({ type:'customer_ws_sync', startedAt:new Date(), finishedAt:new Date(), status:'done', synced, source:'shaygan-webservice-invoice-accounts' }).catch(()=>{});
    return { ok:true, synced, source:'shaygan-webservice-invoice-accounts', invoices:(invFetch.list||[]).length };
  } catch(e) {
    return { ok:false, error:String(e.message||e), source:'webservice-customer-sync-error' };
  }
}

async function customerReportsSummary() {
  const db = await connectMongo();
  const now = new Date();
  const d90 = new Date(Date.now() - 90*86400000);
  const [total, repeated, missingMobile, missingNational, invalid, partial, inactive90, highValue] = await Promise.all([
    db.collection('customers').estimatedDocumentCount().catch(()=>0),
    db.collection('customers').countDocuments({ purchaseCount:{ $gte:2 } }).catch(()=>0),
    db.collection('customers').countDocuments({ $or:[{mobile:''},{mobile:null},{mobile:{$exists:false}}] }).catch(()=>0),
    db.collection('customers').countDocuments({ $or:[{nationalCode:''},{nationalCode:null},{nationalCode:{$exists:false}}] }).catch(()=>0),
    db.collection('customers').countDocuments({ dataQualityStatus:'invalid' }).catch(()=>0),
    db.collection('customers').countDocuments({ dataQualityStatus:{ $in:['partial','incomplete'] } }).catch(()=>0),
    db.collection('customers').countDocuments({ lastPurchaseDate:{ $lt:d90 } }).catch(()=>0),
    db.collection('customers').countDocuments({ totalPurchaseAmount:{ $gte:1000000000 } }).catch(()=>0)
  ]);
  const duplicateMobiles = await db.collection('customers').aggregate([
    { $match:{ mobile:{ $nin:['', null] } } }, { $group:{ _id:'$mobile', count:{ $sum:1 }, names:{ $addToSet:'$fullName' } } }, { $match:{ count:{ $gte:2 } } }, { $count:'n' }
  ]).toArray().catch(()=>[]);
  const duplicateNationalCodes = await db.collection('customers').aggregate([
    { $match:{ nationalCode:{ $nin:['', null] } } }, { $group:{ _id:'$nationalCode', count:{ $sum:1 }, names:{ $addToSet:'$fullName' } } }, { $match:{ count:{ $gte:2 } } }, { $count:'n' }
  ]).toArray().catch(()=>[]);
  const [siteInvoices, consoleInvoices, withoutLeadInvoices] = await Promise.all([
    db.collection('customerInvoiceHistory').countDocuments(siteHistoryFilter()).catch(()=>0),
    db.collection('customerInvoiceHistory').countDocuments(consoleHistoryFilter()).catch(()=>0),
    db.collection('customerInvoiceHistory').countDocuments({ $or:[{leadId:''},{leadId:null},{leadId:{$exists:false}}], source:'crm-sale' }).catch(()=>0)
  ]);
  return { ok:true, total, repeated, missingMobile, missingNational, invalid, partial, inactive90, highValue, siteInvoices, consoleInvoices, withoutLeadInvoices, duplicateMobiles: duplicateMobiles[0]?.n || 0, duplicateNationalCodes: duplicateNationalCodes[0]?.n || 0, generatedAt:now };
}

function reportDateFilter(query={}) {
  const filter = {};
  if (query.from || query.to) {
    filter.invDate = {};
    if (query.from) filter.invDate.$gte = new Date(String(query.from));
    if (query.to) filter.invDate.$lte = new Date(String(query.to));
  }
  return filter;
}
async function customerIntelligenceReport(type='', query={}) {
  const db = await connectMongo();
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const minPurchases = Math.max(Number(query.minPurchases || 2), 1);
  const minAmount = Math.max(Number(query.minAmount || 1000000000), 0);
  if (type === 'frequent') {
    return await db.collection('customers').find({ purchaseCount:{ $gte:minPurchases } }).sort({ purchaseCount:-1, totalPurchaseAmount:-1, lastPurchaseDate:-1 }).limit(limit).toArray();
  }
  if (type === 'high-value') {
    return await db.collection('customers').find({ totalPurchaseAmount:{ $gte:minAmount } }).sort({ totalPurchaseAmount:-1, purchaseCount:-1 }).limit(limit).toArray();
  }
  if (type === 'new') {
    const days = Math.min(Math.max(Number(query.days || 31), 1), 3650);
    const since = new Date(Date.now() - days*86400000);
    return await db.collection('customers').find({ firstPurchaseDate:{ $gte:since } }).sort({ firstPurchaseDate:-1 }).limit(limit).toArray();
  }
  if (type === 'inactive') {
    const days = Math.min(Math.max(Number(query.days || 90), 1), 3650);
    const before = new Date(Date.now() - days*86400000);
    return await db.collection('customers').find({ lastPurchaseDate:{ $lt:before }, purchaseCount:{ $gte:1 } }).sort({ lastPurchaseDate:1, totalPurchaseAmount:-1 }).limit(limit).toArray();
  }
  if (type === 'returned') {
    const rows = await db.collection('customers').find({ fiscalDbs:{ $all:['CY000001','CY000002'] } }).sort({ totalPurchaseAmount:-1 }).limit(limit).toArray();
    return rows;
  }
  return [];
}
async function customerHistoryReport(type='', query={}) {
  const db = await connectMongo();
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  const filter = reportDateFilter(query);
  if (type === 'site') Object.assign(filter, siteHistoryFilter());
  if (type === 'console') Object.assign(filter, consoleHistoryFilter());
  if (type === 'without-lead') { filter.source = 'crm-sale'; filter.$or = [{leadId:''},{leadId:null},{leadId:{$exists:false}}]; }
  if (type === 'store') {
    filter.source = 'crm-sale';
    if (query.store) filter.sellerStore = String(query.store);
  }
  const rows = await db.collection('customerInvoiceHistory').find(filter).sort({ invDate:-1 }).limit(limit).toArray();
  return rows;
}



const DEFAULT_AGING_SUPPLIERS = [
  { accountId:3230, accountName:'بازرگانی ماندگار - بیات', group:'نوت‌بوک / اصلی', paymentMethod:'mixed', manualSettlementDays:10, goodsDelayDays:0, checkDueDays:null, settlementBasis:'inventory_date' },
  { accountId:402, accountName:'شرکت رایان کاوه ایرانیان', group:'نوت‌بوک / اصلی', paymentMethod:'mixed', manualSettlementDays:null, goodsDelayDays:0, checkDueDays:null, settlementBasis:'inventory_date' },
  { accountId:666, accountName:'شرکت ماتریس', group:'نوت‌بوک / اصلی', paymentMethod:'check', manualSettlementDays:null, goodsDelayDays:2, checkDueDays:10, settlementBasis:'purchase_commitment' }
];

async function ensureDefaultAgingSuppliers(db, by='system') {
  const col = db.collection('supplierAgingSuppliers');
  const now = new Date();
  let changed = 0;
  for (const x of DEFAULT_AGING_SUPPLIERS) {
    const existing = await col.findOne({ accountId:x.accountId });
    if (!existing) {
      await col.updateOne({ accountId:x.accountId }, { $set:{ ...x, isActive:true, autoSettlementEnabled:true, minPurchaseRial:0, note:'تأمین‌کننده پیش‌فرض فاز شروع 0.9.15', updatedAt:now, updatedBy:by }, $setOnInsert:{ createdAt:now } }, { upsert:true });
      changed++;
      continue;
    }
    const patch = {};
    for (const k of ['paymentMethod','settlementBasis','goodsDelayDays','checkDueDays']) {
      if (existing[k] === undefined && x[k] !== undefined) patch[k] = x[k];
    }
    if (existing.manualSettlementDays === undefined && x.manualSettlementDays !== undefined) patch.manualSettlementDays = x.manualSettlementDays;
    if (Object.keys(patch).length) {
      patch.updatedAt = now; patch.updatedBy = by; patch.note = existing.note || 'به‌روزرسانی تنظیمات مالی خواب کالا 0.9.15.5';
      await col.updateOne({ accountId:x.accountId }, { $set:patch });
      changed++;
    }
  }
  const count = await col.countDocuments({}).catch(()=>0);
  return { seeded:changed>0, count, changed };
}

async function selectedAgingSuppliers(db, activeOnly=false) {
  await ensureDefaultAgingSuppliers(db);
  const q = activeOnly ? { isActive:{ $ne:false } } : {};
  return await db.collection('supplierAgingSuppliers').find(q).sort({ isActive:-1, accountName:1 }).toArray();
}

function riskLevel(overDueDays=0, ageDays=0, profitPct=null) {
  const o = Number(overDueDays||0), a=Number(ageDays||0), p = profitPct == null ? null : Number(profitPct);
  if (o > 45 || (o > 20 && (p == null || p < 8))) return 'high';
  if (o > 10 || a > 45) return 'medium';
  return 'low';
}
function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampDays(n) {
  if (n == null) return null;
  return Math.max(0, Math.round(Number(n)||0));
}
function supplierTerms(sel={}, ledger={}) {
  const paymentMethod = String(sel.paymentMethod || sel.settlementType || 'mixed');
  const goodsDelayDays = clampDays(numOrNull(sel.goodsDelayDays)) || 0;
  const manualSettlementDays = clampDays(numOrNull(sel.manualSettlementDays));
  const checkDueDays = clampDays(numOrNull(sel.checkDueDays));
  const avgSettlementDays = ledger.avgSettlementDays == null ? null : clampDays(ledger.avgSettlementDays);
  const basis = String(sel.settlementBasis || (paymentMethod === 'check' ? 'purchase_commitment' : 'inventory_date'));
  const rawPaymentTermDays = paymentMethod === 'check' ? (checkDueDays ?? manualSettlementDays ?? avgSettlementDays) : (manualSettlementDays ?? avgSettlementDays);
  let financialGraceDays = rawPaymentTermDays;
  if (basis === 'purchase_commitment' && rawPaymentTermDays != null) financialGraceDays = Math.max(0, rawPaymentTermDays - goodsDelayDays);
  return { paymentMethod, goodsDelayDays, manualSettlementDays, checkDueDays, avgSettlementDays, settlementBasis:basis, rawPaymentTermDays, financialGraceDays };
}
function addDaysIso(iso, days) {
  if (!iso || days == null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(days||0));
  return d.toISOString().slice(0,10);
}
async function buildSupplierAgingReport(opts = {}) {
  const db = await connectMongo();
  const activeWarehouseNumbers = await getActiveWarehouseNumbers(db);

  // 0.9.19.17→WS: SQL calls حذف شدند؛ origin از kardex WS تخمین زده می‌شود
  // supplier aging کامل نیاز به FIFO SQL دارد — در این نسخه WS، داده‌های مالی از GetStatement می‌آید
  const origin = { origins:[], totalInventoryValue:0, totalInventoryQty:0, totalItemCount:0, source:'webservice-inventory-snapshot' };
  const enrichedOrigins = [];
  let originProfit = { map:{} };

  let selected = await selectedAgingSuppliers(db, true);
  const hasOriginAccountFilter = Object.prototype.hasOwnProperty.call(opts, 'originAccountId');
  const originAccountId = hasOriginAccountFilter ? Number(opts.originAccountId || 0) : null;
  const supplierAccountId = Number(opts.supplierAccountId || opts.accountId || 0);
  const selectedFilterId = supplierAccountId || (hasOriginAccountFilter && originAccountId > 0 ? originAccountId : 0);

  if (selectedFilterId) {
    selected = selected.filter(x => Number(x.accountId) === selectedFilterId);
    if (!selected.length) {
      const o = (enrichedOrigins || []).find(x => Number(x.accountId || 0) === Number(selectedFilterId));
      selected = [{
        accountId:selectedFilterId,
        accountNumber:o?.accountNumber || '',
        accountName:o?.accountName || o?.supplierName || `تأمین‌کننده ${selectedFilterId}`,
        isActive:true,
        paymentMethod:'mixed',
        settlementBasis:'inventory_date',
        goodsDelayDays:0
      }];
    }
  }

  const ids = selected.map(x=>Number(x.accountId)).filter(Boolean);
  let purchase = { map:{} }, ledger = { map:{} }, profit = { map:{} }, aging = { bySupplier:{}, list:[] };
  if (ids.length) {
    // 0.9.19.17→WS: getSupplierPurchaseSummary, getSupplierLedgerSummary, getSupplierSalesProfitFifo, getSupplierInventoryAgingApprox
    // همه SQL بودند — از GetStatement شایگان جایگزین می‌شوند
    const stmtResults = await Promise.allSettled(ids.map(async id => {
      const sel = selected.find(x => Number(x.accountId) === id) || {};
      const accountNumber = String(sel.accountNumber || '');
      if (!accountNumber) return [id, null];
      const r = await shaygan.getAccountStatement(accountNumber).catch(() => null);
      return [id, r];
    }));
    for (const res of stmtResults) {
      if (res.status !== 'fulfilled') continue;
      const [id, r] = res.value;
      if (!r || !r.ok) continue;
      const rows = r.list || [];
      const purchaseRial = rows.filter(x => Number(x.debit||0)>0).reduce((s,x)=>s+Number(x.debit||0),0);
      const paidRial = rows.filter(x => Number(x.credit||0)>0).reduce((s,x)=>s+Number(x.credit||0),0);
      const balance = purchaseRial - paidRial;
      purchase.map[String(id)] = { purchaseRial, purchaseInvoiceCount: rows.filter(x=>Number(x.debit||0)>0).length, accountNumber:String(id) };
      ledger.map[String(id)] = { cleanPaidRial: paidRial, totalPaidRial: paidRial, balance, accountNumber:String(id) };
    }
  }

  const bySel = Object.fromEntries(selected.map(x=>[String(x.accountId),x]));
  const suppliers = ids.map(id => {
    const key=String(id), sel=bySel[key]||{}, p=purchase.map[key]||{}, l=ledger.map[key]||{}, pr=profit.map[key]||{}, ag=((enrichedOrigins||[]).find(o=>String(o.accountId)===key) || aging.bySupplier[key] || {});
    const terms = supplierTerms(sel, l);
    const avgAge = Number(ag.averageAgeDays || 0);
    const financialOver = terms.financialGraceDays == null ? null : avgAge - terms.financialGraceDays;
    const oldOver = terms.rawPaymentTermDays == null ? null : avgAge - terms.rawPaymentTermDays;
    return {
      accountId:id,
      accountNumber:p.accountNumber || l.accountNumber || sel.accountNumber || ag.accountNumber || '',
      accountName:sel.accountName || p.accountName || l.accountName || ag.accountName || ag.supplierName || '',
      group:sel.group || '',
      paymentMethod:terms.paymentMethod,
      settlementBasis:terms.settlementBasis,
      goodsDelayDays:terms.goodsDelayDays,
      checkDueDays:terms.checkDueDays,
      manualSettlementDays:terms.manualSettlementDays,
      avgSettlementDays:terms.avgSettlementDays,
      rawPaymentTermDays:terms.rawPaymentTermDays,
      effectiveSettlementDays:terms.financialGraceDays,
      financialGraceDays:terms.financialGraceDays,
      totalPurchaseRial:p.purchaseRial || 0,
      purchaseInvoiceCount:p.purchaseInvoiceCount || 0,
      totalPaidRial:l.cleanPaidRial || l.totalPaidRial || 0,
      grossLedgerDebit:l.totalDebit || 0,
      grossLedgerCredit:l.totalCredit || 0,
      openingDebit:l.openingDebit || 0,
      openingCredit:l.openingCredit || 0,
      canceledCheckDebit:l.canceledCheckDebit || 0,
      canceledCheckCredit:l.canceledCheckCredit || 0,
      adjustmentDebit:l.adjustmentDebit || 0,
      adjustmentCredit:l.adjustmentCredit || 0,
      validCheckPaidRial:l.validCheckPaidRial || 0,
      cashLikePaidRial:l.cashLikePaidRial || 0,
      ledgerConfidence:l.ledgerConfidence || 'unknown',
      payableBalance:l.balance || 0,
      periodCleanBalance:l.periodCleanBalance || 0,
      inventoryValue:ag.inventoryValue || 0,
      inventoryQty:ag.inventoryQty || 0,
      inventoryItemCount:ag.itemCount || 0,
      originSharePct:ag.sharePct || 0,
      averageInventoryAgeDays:avgAge,
      overdueDays:financialOver,
      oldOverdueDays:oldOver,
      saleRial:pr.saleRial || 0,
      estimatedProfit:pr.estimatedProfit || 0,
      estimatedProfitPct:pr.estimatedProfitPct,
      risk:riskLevel(financialOver, avgAge, pr.estimatedProfitPct),
      confidence:'WebService Kardex/Statement approximation؛ گزارش تخمینی بدون SQL مستقیم'
    };
  });

  const profitBy = profit.map || {};
  const originLayersRaw = (origin.layers || []).filter(x => {
    if (hasOriginAccountFilter) return Number(x.accountId || 0) === Number(originAccountId || 0);
    if (supplierAccountId) return Number(x.accountId || 0) === Number(supplierAccountId);
    return true;
  });
  const itemLayers = originLayersRaw.map(x=>{
    const sel=bySel[String(x.accountId)]||{};
    const l=ledger.map[String(x.accountId)]||{};
    const pr=profitBy[String(x.accountId)]||{};
    const terms = supplierTerms(sel, l);
    const overdue = terms.financialGraceDays == null || x.ageDays == null ? null : Number(x.ageDays||0) - terms.financialGraceDays;
    const financialDueDate = addDaysIso(x.purchaseDate, terms.financialGraceDays);
    return { ...x, paymentMethod:terms.paymentMethod, settlementBasis:terms.settlementBasis, goodsDelayDays:terms.goodsDelayDays, checkDueDays:terms.checkDueDays, rawPaymentTermDays:terms.rawPaymentTermDays, effectiveSettlementDays:terms.financialGraceDays, financialGraceDays:terms.financialGraceDays, financialDueDate, overdueDays:overdue, supplierGroup:sel.group||'', estimatedSupplierProfitPct:pr.estimatedProfitPct, risk:riskLevel(overdue, x.ageDays, pr.estimatedProfitPct) };
  }).sort((a,b)=>Number(b.remainingValue||0)-Number(a.remainingValue||0)).slice(0,1000);

  const layerSummary = {
    supplierAccountId: supplierAccountId || null,
    originAccountId: hasOriginAccountFilter ? originAccountId : null,
    layerCount: itemLayers.length,
    totalRemainingQty: Math.round(itemLayers.reduce((a,x)=>a+Number(x.remainingQty||0),0)*1000)/1000,
    totalRemainingValue: Math.round(itemLayers.reduce((a,x)=>a+Number(x.remainingValue||0),0)),
    averagePhysicalAgeDays: (() => { const v=itemLayers.reduce((a,x)=>a+Number(x.remainingValue||0),0); return v ? Math.round(itemLayers.reduce((a,x)=>a+Number(x.remainingValue||0)*Number(x.ageDays||0),0)/v) : 0; })(),
    averageFinancialPressureDays: (() => { const arr=itemLayers.filter(x=>x.overdueDays!=null); return arr.length ? Math.round(arr.reduce((a,x)=>a+Number(x.overdueDays||0),0)/arr.length) : null; })()
  };
  return { ok:true, generatedAt:new Date().toISOString(), suppliers, itemLayers, originSummary:{ totalInventoryValue:origin.totalInventoryValue||0, totalInventoryQty:origin.totalInventoryQty||0, totalItemCount:origin.totalItemCount||0, origins:enrichedOrigins||[], activeWarehouseNumbers }, layerSummary, meta:{ selectedCount:ids.length, supplierAccountId:supplierAccountId||null, originAccountId:hasOriginAccountFilter ? originAccountId : null, source:'sql-read-cy-active-origin-summary', originSource:origin.source||'', profitSource:profit.source||originProfit.source||'fifo', unmatchedSales:(profit.unmatched||[]).length, activeWarehouseNumbers, note:'0.9.19.10: گزارش از کل موجودی انبارهای فعال شروع می‌کند؛ سپس منشا مانده را به تأمین‌کننده یا نامشخص/مانده از قبل تخصیص می‌دهد. جدول منشا مبلغ سود FIFO و درصد سود را نیز نمایش می‌دهد.' } };
}


async function estimateLineCostFromCardex(itemCode, saleDate, qty, salePrice) {
  // 0.9.19.17→WS: shayganSql.getKardexByItemCode → shaygan.getKardexByItemCode
  try {
    if (!itemCode) return { cost:0, profit:null, unknown:Number(qty||0)*Number(salePrice||0), note:'no_item' };
    const kr = await shaygan.getKardexByItemCode(String(itemCode), '', { maxRows: 300, hardMaxRows: 600 });
    const rows = (kr.rows || []).filter(r => Number(r.inQty || r.InQty || 0) > 0 || Number(r.costPrice || r.CostPrice || r.buyPrice || r.inPrice || 0) > 0);
    const saleTs = saleDate ? new Date(saleDate).getTime() : Date.now();
    const candidates = rows.map(r => {
      const dt = new Date(r.date || r.Date || r.invoiceDate || '').getTime();
      const price = Number(r.costPrice || r.CostPrice || r.buyPrice || r.inPrice || r.price || 0);
      return { dt: Number.isFinite(dt) ? dt : 0, price };
    }).filter(x => x.price > 0 && (!x.dt || x.dt <= saleTs)).sort((a,b)=>b.dt-a.dt);
    const unitCost = candidates[0]?.price || 0;
    if (!unitCost) return { cost:0, profit:null, unknown:Number(qty||0)*Number(salePrice||0), note:'no_cost_from_ws_kardex' };
    const cost = unitCost * Number(qty||0);
    const sale = Number(qty||0)*Number(salePrice||0);
    return { cost, profit:sale-cost, unknown:0, unitCost, note:'latest_ws_kardex_cost' };
  } catch(e) { return { cost:0, profit:null, unknown:Number(qty||0)*Number(salePrice||0), note:'cost_error:'+String(e.message||e) }; }
}
function startOfMonthIso(month='') {
  const m = String(month || '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) return `${m}-01`;
  return '';
}
function endOfMonthIso(month='') {
  const m = String(month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) return '';
  const d = new Date(`${m}-01T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0,10);
}
function normalizeDate8ForShaygan(v='', end=false) {
  const iso = normalizeReportDate(v, end);
  if (!iso) return '';
  return iso.slice(0,10).replace(/-/g,'');
}
function extractLeadIdFromInvoiceDoc(inv={}) {
  const txt = [inv.InvDescription, inv.GeneralRef, ...(Array.isArray(inv.Body) ? inv.Body.map(x=>x.LineItemDesc) : [])].filter(Boolean).join(' ');
  const m = String(txt).match(/(?:Lead\s*ID|LeadID|CRM\s*Lead|لید)\s*[:=\- ]\s*([A-Za-z0-9_\-\/\.]+)/i) || String(txt).match(/\bLID[-_A-Za-z0-9]{3,}\b/i);
  return m ? String(m[1] || m[0] || '').trim() : '';
}
function normalizeRepText(v='') {
  return normalizeText(String(v||'')).replace(/نماینده/g,'').replace(/فروش/g,'').trim();
}
function sellerLabelFromInvoice(inv={}, mappingsByEmployee=new Map()) {
  const emp = String(inv.SAccountNumber || inv.SAccount2Number || '').trim();
  const repNameRaw = String(inv.SAccountName || inv.SJobName || inv.LastIssuerUsername || inv.FirstIssuerUsername || '').trim();
  const m = emp ? mappingsByEmployee.get(emp) : null;
  const name = m?.fullName || repNameRaw || (emp ? `نماینده ${emp}` : 'نماینده نامشخص');
  return { employeeAccountNumber:emp, sellerKey: emp || normalizeRepText(name) || 'unknown-rep', sellerName:name, sellerStore:m?.storeName || '' };
}
async function fetchSaleInvoicesFromShayganWebService({ from8='', to8='', maxPages=600 }={}) {
  const list = [];
  let rowStart = 0;
  const pageSize = 20;
  for (let page=0; page<Number(maxPages||600); page++, rowStart += pageSize) {
    const r = await shaygan.getInvoicePageByDate(rowStart, 2, from8, to8, pageSize);
    if (!r.ok) return { ok:false, list, error:r.error || 'خطا در خواندن فاکتورهای فروش از وب سرویس', raw:r.raw };
    const rows = Array.isArray(r.result) ? r.result : [];
    if (!rows.length) break;
    list.push(...rows);
    if (rows.length < pageSize) break;
  }
  return { ok:true, list, source:'shaygan-webservice-invoice-get-date', pages:Math.ceil(list.length/pageSize) };
}

// 0.9.19.17→WS: موتور FIFO بدون SQL — از Kardex وب‌سرویس شایگان می‌خواند
async function getSellerSalesProfitFifoFromSalesWS(saleRows=[], opts={}) {
  const rows = (saleRows || []).map((x, idx) => ({
    sellerKey: String(x.sellerKey || 'unknown').trim() || 'unknown',
    sellerName: String(x.sellerName || x.sellerKey || 'نامشخص').trim() || 'نامشخص',
    sellerStore: String(x.sellerStore || '').trim(),
    invoiceNo: String(x.invoiceNo || '').trim(),
    invoiceDate: x.invoiceDate ? new Date(x.invoiceDate) : new Date(),
    leadId: String(x.leadId || '').trim(),
    customerName: String(x.customerName || '').trim(),
    itemCode: String(x.itemCode || '').trim(),
    itemDescription: String(x.itemDescription || '').trim(),
    qty: Number(x.qty || x.quantity || 0),
    unitSale: Number(x.unitSale || x.price || 0),
    saleRial: Number(x.saleRial || 0),
    _idx: idx
  })).filter(x => x.itemCode && x.qty > 0 && (x.unitSale > 0 || x.saleRial > 0));

  if (!rows.length) return { ok:true, list:[], invoices:[], allocations:[], unmatched:[], source:'seller-profit-ws-empty' };
  for (const r of rows) {
    if (!r.saleRial) r.saleRial = r.qty * r.unitSale;
    if (!r.unitSale) r.unitSale = r.saleRial / r.qty;
  }

  // خواندن kardex به ازای هر کد کالا از WebService
  const codes = [...new Set(rows.map(x => x.itemCode))];
  const batchesByCode = new Map();
  await Promise.allSettled(codes.map(async (code) => {
    try {
      const kr = await shaygan.getKardexByItemCode(code, '', { maxRows: Number(opts.kardexMaxRows || 600), hardMaxRows: Number(opts.kardexHardMaxRows || 1200) });
      const purchaseRows = (kr.rows || []).filter(r => Number(r.inQty || r.InQty || 0) > 0 && Number(r.costPrice || r.CostPrice || r.buyPrice || r.inPrice || r.unitCost || 0) > 0)
        .map(r => {
          const rawDate = r.date || r.Date || r.invoiceDate || r.InvDate || '';
          return { invNo:String(r.invoiceNo||r.InvNo||''), invDate: rawDate ? new Date(rawDate) : null, qty:Number(r.inQty||r.InQty||0), remainingQty:Number(r.inQty||r.InQty||0), unitCost:Number(r.costPrice||r.CostPrice||r.buyPrice||r.inPrice||r.unitCost||0) };
        })
        .sort((a,b) => { if (!a.invDate&&!b.invDate) return 0; if (!a.invDate) return 1; if (!b.invDate) return -1; return a.invDate-b.invDate; });
      batchesByCode.set(code, purchaseRows);
    } catch(e) { batchesByCode.set(code, []); }
  }));

  const sellerMap = new Map(), invoicesMap = new Map(), allocations = [], unmatched = [];
  function ensureSeller(r) {
    const k = r.sellerKey||'unknown';
    if (!sellerMap.has(k)) sellerMap.set(k, { sellerKey:k, sellerName:r.sellerName||k, sellerStore:r.sellerStore||'', invoiceCountSet:new Set(), saleRial:0, fifoCost:0, fifoProfit:0, totalQty:0, allocatedRows:0, unmatchedSaleRial:0, withoutLeadCount:0, withLeadCount:0 });
    const s = sellerMap.get(k);
    if (!s.sellerName||s.sellerName===k) s.sellerName=r.sellerName||k;
    if (!s.sellerStore&&r.sellerStore) s.sellerStore=r.sellerStore;
    return s;
  }
  function ensureInvoice(r) {
    const k=`${r.sellerKey}|${r.invoiceNo||r._idx}`;
    if (!invoicesMap.has(k)) invoicesMap.set(k,{sellerKey:r.sellerKey,sellerName:r.sellerName,sellerStore:r.sellerStore,invoiceNo:r.invoiceNo,invoiceDate:r.invoiceDate?r.invoiceDate.toISOString().slice(0,10):'',customerName:r.customerName||'',leadId:r.leadId||'',saleRial:0,fifoCost:0,fifoProfit:0,unmatchedSaleRial:0,itemCount:0,lines:[],itemCodes:[],hasNotebook:false});
    return invoicesMap.get(k);
  }
  const saleList = [...rows].sort((a,b)=>(a.invoiceDate-b.invoiceDate)||String(a.invoiceNo).localeCompare(String(b.invoiceNo))||a._idx-b._idx);
  for (const sale of saleList) {
    let need=sale.qty;
    const batches=batchesByCode.get(sale.itemCode)||[];
    const ss=ensureSeller(sale), inv=ensureInvoice(sale);
    ss.saleRial+=sale.saleRial; ss.totalQty+=sale.qty; if(sale.invoiceNo) ss.invoiceCountSet.add(sale.invoiceNo); if(sale.leadId) ss.withLeadCount+=1; else ss.withoutLeadCount+=1;
    inv.saleRial+=sale.saleRial; inv.itemCount+=1;
    if (!inv.itemCodes.includes(sale.itemCode)) inv.itemCodes.push(sale.itemCode);
    if (String(sale.itemCode||'').startsWith('1')) inv.hasNotebook=true;
    const invLine={itemCode:sale.itemCode,itemDescription:sale.itemDescription,qty:sale.qty,saleRial:Math.round(sale.saleRial),fifoCost:0,fifoProfit:0,unmatchedSaleRial:0,leadId:sale.leadId||'',invoiceNo:sale.invoiceNo};
    inv.lines.push(invLine);
    for (const b of batches) {
      if (need<=0) break; if (b.remainingQty<=0) continue;
      if (sale.invoiceDate&&b.invDate&&sale.invoiceDate<b.invDate) continue;
      const qty=Math.min(need,b.remainingQty); need-=qty; b.remainingQty-=qty;
      const saleValue=qty*sale.unitSale, cost=qty*b.unitCost, profit=saleValue-cost;
      ss.fifoCost+=cost; ss.fifoProfit+=profit; ss.allocatedRows+=1;
      inv.fifoCost+=cost; inv.fifoProfit+=profit; invLine.fifoCost+=cost; invLine.fifoProfit+=profit;
      allocations.push({sellerKey:sale.sellerKey,sellerName:sale.sellerName,invoiceNo:sale.invoiceNo,itemCode:sale.itemCode,itemDescription:sale.itemDescription,saleQty:qty,saleValue:Math.round(saleValue),purchaseInvNo:b.invNo,unitCost:Math.round(b.unitCost),fifoCost:Math.round(cost),fifoProfit:Math.round(profit)});
    }
    if (need>0.0001) {
      const val=need*sale.unitSale;
      ss.unmatchedSaleRial+=val; inv.unmatchedSaleRial+=val; invLine.unmatchedSaleRial+=val;
      unmatched.push({sellerKey:sale.sellerKey,sellerName:sale.sellerName,invoiceNo:sale.invoiceNo,itemCode:sale.itemCode,itemDescription:sale.itemDescription,unmatchedQty:need,unmatchedSaleRial:Math.round(val),reason:'opening-stock-or-missing-purchase-kardex-ws'});
    }
  }
  const list=[...sellerMap.values()].map(s=>({...s,invoiceCount:s.invoiceCountSet.size,invoiceCountSet:undefined,saleRial:Math.round(s.saleRial),fifoCost:Math.round(s.fifoCost),fifoProfit:Math.round(s.fifoProfit),avgProfitPct:s.saleRial?Math.round((s.fifoProfit/s.saleRial)*10000)/100:null,unmatchedSaleRial:Math.round(s.unmatchedSaleRial),confidence:s.unmatchedSaleRial?'partial-fifo-ws-kardex':'fifo-ws-kardex'})).sort((a,b)=>b.saleRial-a.saleRial);
  const invoiceList=[...invoicesMap.values()].map(x=>({...x,saleRial:Math.round(x.saleRial),fifoCost:Math.round(x.fifoCost),fifoProfit:Math.round(x.fifoProfit),profitPct:x.saleRial?Math.round((x.fifoProfit/x.saleRial)*10000)/100:null,unmatchedSaleRial:Math.round(x.unmatchedSaleRial),lines:(x.lines||[]).map(l=>({...l,saleRial:Math.round(l.saleRial||0),fifoCost:Math.round(l.fifoCost||0),fifoProfit:Math.round(l.fifoProfit||0),unmatchedSaleRial:Math.round(l.unmatchedSaleRial||0),profitPct:l.saleRial?Math.round(((l.fifoProfit||0)/l.saleRial)*10000)/100:null}))})).sort((a,b)=>String(b.invoiceDate).localeCompare(String(a.invoiceDate))||Number(b.invoiceNo)-Number(a.invoiceNo));
  return { ok:true, list, invoices:invoiceList, allocations, unmatched:unmatched.slice(0,1000), source:'shaygan-webservice-kardex-seller-profit-fifo' };
}

async function buildSellerSalesProfitReport(query={}) {
  const db = await connectMongo();
  const seller = String(query.seller || query.employeeAccountNumber || '').trim();
  const store = String(query.store || '').trim();
  const month = String(query.month || '').trim();
  const dateFromNorm = normalizeReportDate(query.dateFrom || query.from || '', false) || normalizeReportDate(startOfMonthIso(month), false);
  const dateToNorm = normalizeReportDate(query.dateTo || query.to || '', true) || normalizeReportDate(endOfMonthIso(month), true);
  const days = Math.min(Math.max(Number(query.days || 31), 1), 366);
  const fromDate = dateFromNorm ? new Date(dateFromNorm) : new Date(Date.now() - days * 86400000);
  const toDate = dateToNorm ? new Date(dateToNorm) : new Date();
  const from8 = dateFromNorm ? dateFromNorm.slice(0,10).replace(/-/g,'') : '';
  const to8 = dateToNorm ? dateToNorm.slice(0,10).replace(/-/g,'') : '';
  const profitUnit = String(query.profitUnit || 'toman');
  const minProfit = parseMoneyInput(query.minProfit, profitUnit);
  const maxProfit = parseMoneyInput(query.maxProfit, profitUnit);
  const commissionRate = query.commissionRate === undefined || query.commissionRate === '' ? 0.18 : Number(query.commissionRate);
  const leadPenaltyRial = parseMoneyInput(query.leadPenaltyRial ?? query.leadPenalty, 'rial') || 0;
  const itemGroup = String(query.itemGroup || query.group || '').trim().toLowerCase();
  const isNotebookOnly = itemGroup === 'notebook' || itemGroup === 'nb' || itemGroup === '1';

  const maps = await db.collection('userShayganMappings').find({ isActive:{ $ne:false } }).toArray().catch(()=>[]);
  const mappingsByEmployee = new Map();
  for (const m of maps) {
    const emp = String(m.employeeAccountNumber || '').trim();
    if (emp && !mappingsByEmployee.has(emp)) mappingsByEmployee.set(emp, m);
  }

  const invFetch = await fetchSaleInvoicesFromShayganWebService({ from8, to8, maxPages:Number(query.maxPages || config.sellerSalesInvoiceMaxPages || 800) });
  if (!invFetch.ok) return { ok:false, error:invFetch.error, source:invFetch.source || 'shaygan-webservice-invoice-get-date' };
  let invDocs = invFetch.list || [];
  const saleRows = [];
  for (const inv of invDocs) {
    const rep = sellerLabelFromInvoice(inv, mappingsByEmployee);
    if (seller && String(rep.employeeAccountNumber || rep.sellerKey) !== seller) continue;
    if (store && !String(rep.sellerStore || '').includes(store)) continue;
    const body = Array.isArray(inv.Body) ? inv.Body : [];
    const invoiceNo = String(inv.InvNo || inv.Number || '').trim();
    const leadId = extractLeadIdFromInvoiceDoc(inv);
    const customerName = String(inv.InvDescription || inv.AccountName || '').trim();
    const invDate = inv.InvDate || inv.CreatedDate || fromDate;
    const discount = Number(inv.DiscAmount || inv.DiscountAmount || 0);
    const rawAmounts = body.map(it => Number(it.Amount || (Number(it.Quan||0)*Number(it.Price||0)) || 0));
    const gross = rawAmounts.reduce((a,b)=>a+b,0) || 1;
    body.forEach((it, idx) => {
      const qty = Number(it.Quan || it.quantity || 0);
      const price = Number(it.Price || it.price || 0);
      const amount = Number(it.Amount || (qty*price) || 0);
      const itemCode = String(it.ItemNumber || it.ItemCode || '').trim();
      if (!qty || !itemCode || (!price && !amount)) return;
      // گروه اصلی نوت‌بوک در حسابداری مشهدکالا: هر کالایی که کد آن با 1 شروع شود.
      // این فیلتر روی ردیف‌های فاکتور اعمال می‌شود؛ در فاکتورهای ترکیبی فقط ردیف‌های نوت‌بوک وارد فروش/سود می‌شوند.
      if (isNotebookOnly && !itemCode.startsWith('1')) return;
      const allocatedDiscount = discount ? (discount * (amount / gross)) : 0;
      saleRows.push({
        sellerKey:rep.sellerKey, sellerName:rep.sellerName, sellerStore:rep.sellerStore, employeeAccountNumber:rep.employeeAccountNumber,
        invoiceNo, invoiceDate:invDate, leadId, customerName,
        itemCode, itemDescription:String(it.ItemDescription || it.ItemDesc || '').trim(),
        qty, unitSale: price || (amount/qty), saleRial: Math.max(0, amount - allocatedDiscount)
      });
    });
  }
  const fifo = await getSellerSalesProfitFifoFromSalesWS(saleRows, { kardexMaxRows: 600, kardexHardMaxRows: 1200 });
  let invoices = fifo.invoices || [];
  if (minProfit != null) invoices = invoices.filter(x => Number(x.fifoProfit || 0) >= minProfit);
  if (maxProfit != null) invoices = invoices.filter(x => Number(x.fifoProfit || 0) <= maxProfit);
  const sellerAgg = new Map();
  for (const inv of invoices) {
    const k = inv.sellerKey || 'unknown';
    const emp = String(k).startsWith('NO_EMPLOYEE:') ? '' : String(k);
    if (!sellerAgg.has(k)) sellerAgg.set(k, { sellerKey:k, sellerName:inv.sellerName||k, sellerStore:inv.sellerStore||'', employeeAccountNumber:emp, invoiceCount:0, saleRial:0, fifoCost:0, fifoProfit:0, unmatchedSaleRial:0, withLeadCount:0, withoutLeadCount:0 });
    const s = sellerAgg.get(k);
    s.invoiceCount += 1;
    s.saleRial += Number(inv.saleRial||0);
    s.fifoCost += Number(inv.fifoCost||0);
    s.fifoProfit += Number(inv.fifoProfit||0);
    s.unmatchedSaleRial += Number(inv.unmatchedSaleRial||0);
    if (inv.leadId) s.withLeadCount += 1; else s.withoutLeadCount += 1;
  }
  const sellers = [...sellerAgg.values()].map(s => {
    const c = calcCommission({ fifoProfit:s.fifoProfit, commissionRate, withoutLeadCount:s.withoutLeadCount, leadPenaltyRial });
    return { ...s, saleRial:Math.round(s.saleRial), fifoCost:Math.round(s.fifoCost), fifoProfit:Math.round(s.fifoProfit), unmatchedSaleRial:Math.round(s.unmatchedSaleRial), avgProfitPct:s.saleRial ? Math.round((s.fifoProfit/s.saleRial)*10000)/100 : null, commissionRate, ...c, suggestedCommission:c.finalCommission, leadStatus:s.withoutLeadCount ? 'needs-review' : 'ok', employeeStatus:s.employeeAccountNumber ? 'ok' : 'missing' };
  }).sort((a,b)=>b.fifoProfit-a.fifoProfit);
  const summary = sellers.reduce((a,s)=>{ a.invoiceCount+=s.invoiceCount; a.saleRial+=s.saleRial; a.fifoCost+=s.fifoCost; a.fifoProfit+=s.fifoProfit; a.unmatchedSaleRial+=s.unmatchedSaleRial; a.rawCommission+=s.rawCommission||0; a.leadPenalty+=s.leadPenalty||0; a.suggestedCommission+=s.suggestedCommission; a.withoutLeadCount+=s.withoutLeadCount; a.missingEmployeeCount += s.employeeStatus === 'missing' ? 1 : 0; return a; }, { invoiceCount:0, saleRial:0, fifoCost:0, fifoProfit:0, unmatchedSaleRial:0, rawCommission:0, leadPenalty:0, suggestedCommission:0, withoutLeadCount:0, missingEmployeeCount:0 });
  summary.avgProfitPct = summary.saleRial ? Math.round((summary.fifoProfit/summary.saleRial)*10000)/100 : null;
  return { ok:true, period:{ from:fromDate.toISOString().slice(0,10), to:toDate.toISOString().slice(0,10), month:month||'' }, seller:seller||'all', store, source:'shaygan-webservice-sales-invoices+shaygan-webservice-kardex-seller-profit-fifo', summary, sellers, invoices:invoices.slice(0,1000), allocations:(fifo.allocations||[]).slice(0,1000), unmatched:(fifo.unmatched||[]).slice(0,1000), meta:{ invoiceRows:invDocs.length, saleRows:saleRows.length, itemGroup:isNotebookOnly?'notebook':'all', itemGroupRule:isNotebookOnly?'ItemCode starts with 1':'all items', minProfit, maxProfit, profitUnit, commissionRate, leadPenaltyRial, note:'عملکرد فروشنده از فاکتورهای فروش شایگان خوانده می‌شود؛ فروشنده از نماینده فاکتور/SAccountNumber استخراج می‌شود، نه صندوق و نه فقط لاگ CRM. فیلتر نوت‌بوک بر اساس شروع کد کالا با رقم 1 اعمال می‌شود.' } };
}


function sellerPerformanceFilterKey(query={}) {
  const keep = {};
  // کلید آرشیو فقط بر اساس فیلتر پایه است؛ فیلترهای سود و نوت‌بوک در UI روی گزارش کش‌شده اعمال می‌شوند.
  ['dateFrom','from','dateTo','to','month','seller','employeeAccountNumber','store','commissionRate','leadPenaltyRial','leadPenalty'].forEach(k => {
    if (query[k] !== undefined && query[k] !== null && String(query[k]).trim() !== '') keep[k] = String(query[k]).trim();
  });
  // Normalize aliases so identical reports reuse the same archive key.
  if (keep.from && !keep.dateFrom) { keep.dateFrom = keep.from; delete keep.from; }
  if (keep.to && !keep.dateTo) { keep.dateTo = keep.to; delete keep.to; }
  if (keep.employeeAccountNumber && !keep.seller) { keep.seller = keep.employeeAccountNumber; delete keep.employeeAccountNumber; }
  return JSON.stringify(Object.keys(keep).sort().reduce((a,k)=>{a[k]=keep[k];return a;},{}));
}
async function saveSellerPerformanceHistory(db, query, report, by='system') {
  const filterKey = sellerPerformanceFilterKey(query);
  const doc = {
    type:'seller-performance',
    filterKey,
    filters: JSON.parse(filterKey || '{}'),
    generatedAt: new Date(),
    generatedBy: by,
    report
  };
  await db.collection('sellerPerformanceHistory').insertOne(doc);
  const old = await db.collection('sellerPerformanceHistory').find({ type:'seller-performance' }).sort({ generatedAt:-1 }).skip(30).project({ _id:1 }).toArray().catch(()=>[]);
  if (old.length) await db.collection('sellerPerformanceHistory').deleteMany({ _id:{ $in: old.map(x=>x._id) } }).catch(()=>{});
  return doc;
}
async function getLatestSellerPerformanceHistory(db, query={}) {
  const filterKey = sellerPerformanceFilterKey(query);
  return await db.collection('sellerPerformanceHistory').findOne({ type:'seller-performance', filterKey }, { sort:{ generatedAt:-1 } });
}


function canViewPurchaseInvoicesUser(req) {
  const u = currentUser(req) || {};
  // تابلو برای همه فعال است؛ اما مرور فاکتور خرید فقط با تیک دسترسی یا ادمین مجاز است.
  return String(u.role || '') === 'admin' || u.canViewPurchaseInvoices === true;
}
function canPostPurchaseToBoardUser(req) {
  const u = currentUser(req) || {};
  // اعلام ورود در تابلو جدا از مشاهده فاکتور خرید کنترل می‌شود.
  return String(u.role || '') === 'admin' || u.canPostPurchaseToBoard === true;
}
function canManageBoardEventsUser(req) {
  const u = currentUser(req) || {};
  // تغییر وضعیت تابلو فقط برای ادمین یا کاربر دارای تیک مدیریت تابلو.
  return String(u.role || '') === 'admin' || u.canManageBoardEvents === true;
}
function boardEventTypeFa(type='') {
  if (type === 'stock_out') return 'اتمام کالا';
  if (type === 'stock_in') return 'ورود کالا';
  return type || '';
}
function normalizeBoardItemLine(x={}) {
  const itemCode = String(x.ItemNumber || x.ItemCode || x.itemCode || '').trim();
  const itemName = String(x.ItemDescription || x.ItemDesc || x.itemDescription || '').trim();
  const stockNumber = String(x.STNumber || x.StockNumber || x.stockNumber || '').trim();
  const stockName = String(x.STDesc || x.StockName || x.stockName || '').trim();
  const qty = Number(x.Quan || x.Quantity || x.quantity || 0);
  const price = Number(x.Price || x.price || 0);
  const amount = Number(x.Amount || (qty * price) || 0);
  return { itemCode, itemName, stockNumber, stockName, qty, price, amount };
}
async function createBoardEventOnce(db, doc) {
  const now = time.now();
  const eventKey = String(doc.eventKey || `${doc.type}:${doc.itemCode}:${Date.now()}`).trim();
  // 0.9.19.57: MongoDB forbids writing the same path in both $setOnInsert and $set.
  // Keep immutable creation fields insert-only and mutable timestamps only in $set.
  const insertOnly = {
    ...doc,
    eventKey,
    status: doc.status || 'new',
    createdAt: doc.createdAt || now,
    createdAtTehran: doc.createdAtTehran || time.formatTehranDateTime(doc.createdAt || now),
    timeSource:'server-clock'
  };
  delete insertOnly.updatedAt;
  delete insertOnly.updatedAtTehran;
  delete insertOnly.lastSeenAt;
  delete insertOnly.lastSeenAtTehran;
  const r = await db.collection('boardEvents').updateOne(
    { eventKey },
    {
      $setOnInsert: insertOnly,
      $set:{
        lastSeenAt: now,
        lastSeenAtTehran: time.formatTehranDateTime(now),
        updatedAt: now,
        updatedAtTehran: time.formatTehranDateTime(now)
      }
    },
    { upsert:true }
  ).catch(e => ({ error:e }));
  return { ok:!r.error, inserted:!!r.upsertedId, eventKey, error:r.error ? String(r.error.message||r.error) : '' };
}
async function createStockOutBoardEventsAfterSale({ db, body, result, mapping, user, invoiceNumber, invoiceGuid, localInventoryDeduct, saleIssueKey, source='sale_invoice_issue_live_reconciled_after_local_deduct' }) {
  // 0.9.19.56: restore the proven v49 board decision path (targeted live refresh)
  // while preserving v53+ immediate local sale deduction. The sale-confirmed local afterQty
  // is authoritative for the sold warehouse so a lagging Shaygan response cannot revive it.
  const activeWarehouseNumbers = await getActiveWarehouseNumbers(db).catch(()=>[]);
  const activeSet = new Set((activeWarehouseNumbers || []).map(x => String(x || '').trim()).filter(Boolean));
  const out = [];
  const itemHints = new Map();
  for (const it of (Array.isArray(body?.items) ? body.items : [])) {
    const code = String(it.itemCode || it.ItemCode || it.ItemNumber || it.itemNumber || '').trim();
    if (!code) continue;
    const prev = itemHints.get(code) || { itemDescription:'', soldByStock:new Map() };
    prev.itemDescription = prev.itemDescription || String(it.itemDescription || it.ItemDescription || it.ItemDesc || '').trim();
    const stockNumber = String(it.stockNumber || it.STNumber || it.stNumber || '').trim();
    const soldQty = Number(it.quantity || it.Quan || 0);
    if (stockNumber && soldQty > 0) prev.soldByStock.set(stockNumber, (prev.soldByStock.get(stockNumber) || 0) + soldQty);
    itemHints.set(code, prev);
  }

  const deductLines = Array.isArray(localInventoryDeduct?.lines) ? localInventoryDeduct.lines : [];
  for (const ln of deductLines) {
    const code = String(ln.itemCode || '').trim();
    if (!code) continue;
    const prev = itemHints.get(code) || { itemDescription:'', soldByStock:new Map() };
    const stockNumber = String(ln.stockNumber || '').trim();
    if (stockNumber) {
      prev.soldByStock.set(stockNumber, Number(ln.soldQty || prev.soldByStock.get(stockNumber) || 0));
      prev.afterQtyByStock = prev.afterQtyByStock || new Map();
      prev.afterQtyByStock.set(stockNumber, Math.max(0, Number(ln.afterQty || 0)));
    }
    itemHints.set(code, prev);
  }

  const seenCodes = new Set();
  for (const [itemCode, hint] of itemHints.entries()) {
    if (!itemCode || seenCodes.has(itemCode)) continue;
    seenCodes.add(itemCode);
    const decisionAt = time.now();

    // Restore v49 behavior: perform an exact, targeted post-sale live refresh.
    // For this board-only verification, reductions/zero are allowed because the local sale
    // deduction has already recorded the successful invoice and is preserved below.
    const live = await refreshInventoryCacheForItem(
      db,
      itemCode,
      'after-sale-issue-stock-out-check-v49-restored',
      { allowZeroReplace:true, allowStockReduction:true, confirmZero:true, confirmReduction:true }
    ).catch(e => ({ ok:false, rows:[], error:String(e.message||e), source:'live-refresh-exception' }));

    // Never let the verification refresh revive the warehouse quantity that was just
    // deducted by a confirmed successful sale. Re-apply the local afterQty to Mongo.
    for (const [stockNumber, afterQty] of (hint.afterQtyByStock || new Map()).entries()) {
      await db.collection('itemInventoryCatalog').updateOne(
        { itemCode, stockNumber },
        { $set:{
          quantity:Math.max(0, Number(afterQty || 0)),
          pendingShayganConfirm:true,
          inventoryConfidence:'local-sale-deduct-after-live-verify',
          lastSaleInvoiceNo:Number(invoiceNumber||0) || String(invoiceNumber||''),
          lastSaleInvoiceGuid:String(invoiceGuid||''),
          lastSaleIssueKey:String(saleIssueKey||''),
          updatedAt:decisionAt,
          syncedAt:decisionAt
        }, $addToSet:{ sourceEvidence:'local-sale-deduct-after-live-verify' } },
        { upsert:true }
      ).catch(()=>{});
    }

    const refreshedRows = await readInventoryRowsForItem(db, itemCode).catch(()=>[]);
    const activeRows = activeSet.size
      ? refreshedRows.filter(x => activeSet.has(String(x.stockNumber || x.STNumber || x.StockNumber || '').trim()))
      : refreshedRows;

    // Reconcile live/cache rows with sale-confirmed local afterQty for sold warehouses.
    // This prevents a delayed Shaygan response from restoring the just-sold last unit.
    const reconciledRows = activeRows.map(row => {
      const stockNumber = String(row.stockNumber || row.STNumber || row.StockNumber || '').trim();
      const rawQty = Math.max(0, Number(row.quantity ?? row.qty ?? row.RemainQ ?? row.remainQty ?? 0));
      const confirmedAfter = hint.afterQtyByStock?.has(stockNumber) ? Number(hint.afterQtyByStock.get(stockNumber)) : null;
      return {
        stockNumber,
        rawQty,
        quantity: confirmedAfter === null ? rawQty : Math.min(rawQty, Math.max(0, confirmedAfter)),
        saleConfirmedAfterQty: confirmedAfter
      };
    });

    // A sold stock can disappear from live rows after reaching zero; add its confirmed zero
    // explicitly so the diagnostic result remains complete.
    for (const [stockNumber, afterQty] of (hint.afterQtyByStock || new Map()).entries()) {
      if (activeSet.size && !activeSet.has(stockNumber)) continue;
      if (!reconciledRows.some(x => x.stockNumber === stockNumber)) {
        reconciledRows.push({ stockNumber, rawQty:0, quantity:Math.max(0, Number(afterQty || 0)), saleConfirmedAfterQty:Number(afterQty || 0) });
      }
    }

    const totalQty = reconciledRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const itemName = String(hint.itemDescription || activeRows[0]?.itemDescription || activeRows[0]?.ItemDescription || '').trim();
    const decision = {
      itemCode,
      invoiceNumber:Number(invoiceNumber||result?.Number||0) || String(invoiceNumber||result?.Number||''),
      invoiceGuid:String(invoiceGuid || result?.GuId || ''),
      saleIssueKey:String(saleIssueKey||''),
      totalQtyAfter:totalQty,
      activeWarehouseNumbers,
      source,
      liveRefreshOk:Boolean(live?.ok),
      liveRefreshSource:String(live?.source || ''),
      liveRefreshError:String(live?.error || ''),
      reconciledRows,
      at:decisionAt,
      atTehran:time.formatTehranDateTime(decisionAt)
    };

    if (totalQty > 0) {
      const row = { itemCode, skipped:true, reason:'active-qty-positive-after-v49-live-reconcile', totalQtyAfter:totalQty, reconciledRows };
      out.push(row);
      await db.collection('appLogs').insertOne({ type:'sale_issue_post_board_stock_out', ...decision, skipped:true, reason:row.reason }).catch(()=>{});
      continue;
    }

    const openExisting = await db.collection('boardEvents').findOne({ type:'stock_out', itemCode, status:{ $in:['new','seen','site_updated'] } }).catch(()=>null);
    if (openExisting) {
      const row = { itemCode, skipped:true, reason:'open-event-exists', existingId:String(openExisting._id || ''), eventKey:String(openExisting.eventKey || '') };
      out.push(row);
      await db.collection('appLogs').insertOne({ type:'sale_issue_post_board_stock_out', ...decision, skipped:true, reason:'open-event-exists', existingId:row.existingId, eventKey:row.eventKey }).catch(()=>{});
      continue;
    }

    const ev = await createBoardEventOnce(db, {
      type:'stock_out',
      typeFa:boardEventTypeFa('stock_out'),
      itemCode,
      itemName,
      totalQtyAfter:totalQty,
      activeWarehouseNumbers,
      reconciledRows,
      source,
      eventKey:`stock_out:${itemCode}:sale:${invoiceNumber || result?.Number || saleIssueKey || Date.now()}`,
      invoiceNo:String(invoiceNumber || result?.Number || result?.InvNo || ''),
      invoiceGuid:String(invoiceGuid || result?.GuId || ''),
      saleIssueKey:String(saleIssueKey||''),
      sellerUsername:String(mapping?.username || user?.username || ''),
      sellerName:String(mapping?.fullName || user?.fullName || ''),
      storeName:String(mapping?.storeName || ''),
      note:'بعد از صدور فاکتور فروش و بررسی زنده موجودی، موجودی کل کالا در انبارهای فعال صفر شد.',
      status:'new'
    });
    out.push({ itemCode, ...ev });
    await db.collection('appLogs').insertOne({ type:'sale_issue_post_board_stock_out', ...decision, created:Boolean(ev.inserted || ev.ok), eventKey:ev.eventKey || '', error:ev.error || '' }).catch(()=>{});
  }

  if (!out.length) {
    const at = time.now();
    await db.collection('appLogs').insertOne({ type:'sale_issue_post_board_stock_out', invoiceNumber:Number(invoiceNumber||0)||String(invoiceNumber||''), saleIssueKey:String(saleIssueKey||''), skipped:true, reason:'no-sale-lines-for-board', at, atTehran:time.formatTehranDateTime(at) }).catch(()=>{});
  }
  return out;
}

async function readLastPurchaseInvoicesFromShaygan(limit=30) {
  const max = Math.max(1, Math.min(Number(limit||30), 30));
  const last = await shaygan.getLastPurchaseInvoiceNumber().catch(e => ({ ok:false, error:String(e.message||e), last:0 }));
  const lastNo = Number(last.last || last.lastInvoiceNumber || last.invoiceNumber || 0);
  if (!last.ok || !lastNo) return { ok:false, error:last.error || 'آخرین شماره فاکتور خرید از شایگان خوانده نشد', list:[], last };
  const list = [];
  for (let no = lastNo; no > 0 && list.length < max && (lastNo - no) < 200; no--) {
    const r = await shaygan.getInvoice(no, 3).catch(()=>null);
    const inv = r && Array.isArray(r.list) && r.list[0] ? r.list[0] : null;
    if (!inv) continue;
    const body = Array.isArray(inv.Body) ? inv.Body : [];
    const total = body.reduce((s,x)=>s + Number(x.Amount || (Number(x.Quan||0)*Number(x.Price||0)) || 0), 0);
    list.push({
      invNo:Number(inv.InvNo || no),
      invTyp:Number(inv.InvTyp || 3),
      invDate:String(inv.InvDate || inv.Date || ''),
      supplierNumber:String(inv.AccountNumber || ''),
      supplierName:String(inv.AccountName || ''),
      description:String(inv.InvDescription || ''),
      rowCount:body.length,
      totalAmount:Number(inv.SourceTotalAmount || inv.TotalAmount || total || 0),
      guId:String(inv.GuId || ''),
      raw:inv
    });
  }
  return { ok:true, list, lastPurchaseInvoiceNumber:lastNo, source:'shaygan-webservice-invoice-get-descending' };
}

function rejectIfStagingReadOnly(req, res, operationName) {
  if (!config.stagingReadOnly) return false;
  sendJson(res, 403, {
    ok: false,
    error: 'Operation disabled in staging read-only mode',
    operation: operationName
  });
  return true;
}

function stagingReadOnlyOperation(req, pathname) {
  const method = String(req.method || 'GET').toUpperCase();
  const normalizedPathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const key = `${method} ${normalizedPathname}`;
  const operations = {
    'POST /api/mongo/init': 'mongo.init',
    'POST /api/users': 'users.save',
    'POST /api/users/delete': 'users.delete',
    'POST /api/users/repair-links': 'users.repair-links',
    'POST /api/user-mappings': 'user-mappings.save',
    'DELETE /api/user-mappings': 'user-mappings.delete',
    'POST /api/user-account-access': 'user-account-access.save',
    'POST /api/sale-snapshot/init': 'sale-snapshot.init',
    'POST /api/sale-snapshot/start': 'sale-snapshot.start',
    'POST /api/supplier-sleep/init': 'supplier-sleep.init',
    'POST /api/supplier-sleep/sync-purchases': 'supplier-sleep.sync-purchases',
    'POST /api/supplier-sleep/supplier-index': 'supplier-sleep.supplier-index',
    'POST /api/supplier-sleep/build': 'supplier-sleep.build',
    'POST /api/supplier-sleep/selected-supplier-invoices': 'supplier-sleep.selected-supplier-invoices',
    'POST /api/supplier-sleep/selected-supplier-invoices-job': 'supplier-sleep.selected-supplier-invoices-job',
    'POST /api/supplier-sleep/build-selected-job': 'supplier-sleep.build-selected-job',
    'POST /api/supplier-sleep/build-selected': 'supplier-sleep.build-selected',
    'POST /api/supplier-sleep/snapshot-update': 'supplier-sleep.snapshot-update',
    'POST /api/supplier-sleep/snapshot-delete': 'supplier-sleep.snapshot-delete',
    'POST /api/stock-sleep/init': 'stock-sleep.init',
    'POST /api/stock-sleep/start': 'stock-sleep.start',
    'POST /api/stock-sleep/process': 'stock-sleep.process',
    'POST /api/stock-sleep/process-all': 'stock-sleep.process-all',
    'POST /api/supplier-aging/selected': 'supplier-aging.selected.save',
    'DELETE /api/supplier-aging/selected': 'supplier-aging.selected.delete',
    'POST /api/supplier-aging/seed': 'supplier-aging.seed',
    'POST /api/settings': 'settings.save',
    'PUT /api/settings': 'settings.save',
    'PATCH /api/settings': 'settings.save',
    'POST /api/settings/sale-invoice-extras': 'settings.sale-invoice-extras.save',
    'POST /api/settings/active-warehouses': 'settings.active-warehouses.save',
    'POST /api/accounts/sync': 'accounts.sync',
    'POST /api/inventory/auto-sync/run': 'inventory.auto-sync.run',
    'POST /api/catalog/sync': 'catalog.sync',
    'POST /api/catalog/sync-all-items': 'catalog.sync-all-items',
    'POST /api/catalog/sync-accounts': 'catalog.sync-accounts',
    'POST /api/invoice-numbers/reserve': 'invoice-numbers.reserve',
    'POST /api/customers': 'customers.save',
    'POST /api/customers/sync-sql-fiscal': 'customers.sync-sql-fiscal',
    'POST /api/customers/repair-channel-tags': 'customers.repair-channel-tags',
    'POST /api/customers/sync-shaygan-sales': 'customers.sync-shaygan-sales',
    'POST /api/leads': 'leads.create',
    'POST /api/board/events/status': 'board.events.status',
    'POST /api/sales/issue': 'sales.issue',
    'POST /admin/accounting/putInvoice': 'sales.issue',
    'POST /api/proformas': 'proformas.create',
    'POST /api/purchase-drafts': 'purchase-drafts.create'
  };
  if (operations[key]) return operations[key];
  if (normalizedPathname === '/api/settings' && ['POST','PUT','PATCH','DELETE'].includes(method)) return 'settings.save';
  if (method === 'POST' && /^\/api\/invoices\/\d+\/(annotations|crm-lead)$/.test(normalizedPathname)) return `invoices.${normalizedPathname.endsWith('/annotations') ? 'annotations' : 'crm-lead'}.save`;
  if (method === 'POST' && /^\/api\/board\/purchase-invoices\/\d+\/announce$/.test(normalizedPathname)) return 'board.purchase-invoices.announce';
  if ((method === 'PUT' || method === 'PATCH') && /^\/api\/proformas\/\d+$/.test(normalizedPathname)) return 'proformas.update';
  if (method === 'POST' && /^\/api\/proformas\/\d+\/convert$/.test(normalizedPathname)) return 'proformas.convert';
  if (method === 'POST' && /^\/api\/purchase-drafts\/\d+\/issue$/.test(normalizedPathname)) return 'purchase-drafts.issue';
  return '';
}

async function handleApi(req, res, pathname, query) {
  try {
    const readOnlyOperation = stagingReadOnlyOperation(req, pathname);
    if (readOnlyOperation && rejectIfStagingReadOnly(req, res, readOnlyOperation)) return;
    if (pathname === '/health') return sendJson(res, 200, { ok: true, app: 'mkcrm', version: APP_VERSION, port: config.port, node: process.version, serverTime: time.serverTimePayload() });
    if (pathname === '/api/version') return sendJson(res, 200, { ok: true, app: 'mkcrm', version: APP_VERSION, node: process.version, serverTime: time.serverTimePayload() });
    if (pathname === '/api/server-time') return sendJson(res, 200, time.serverTimePayload());
    if (pathname === '/api/search/status') { const db = await connectMongo(); return sendJson(res, 200, { ok:true, version:APP_VERSION, counts:{ inventory: await db.collection('itemInventoryCatalog').estimatedDocumentCount().catch(()=>0), allItems: await db.collection('itemCatalogAll').estimatedDocumentCount().catch(()=>0), accounts: await db.collection('accountCatalog').estimatedDocumentCount().catch(()=>0) } }); }
    if (pathname === '/api/jobs/status' && req.method === 'GET') { const db = await connectMongo(); const jobId=String(query.jobId||''); const q=jobId?{jobId}:{ }; const jobsRaw=await db.collection('appJobs').find(q).sort({ updatedAt:-1 }).limit(jobId?1:20).toArray().catch(()=>[]); const nowMs=Date.now(); const jobs=jobsRaw.map(j=>{ const hb=new Date(j.heartbeatAt||j.updatedAt||j.startedAt||0).getTime(); const stale=String(j.status||'')==='running' && hb && (nowMs-hb)>10*60*1000; return { ...j, heartbeatAgeMs: hb ? nowMs-hb : null, staleRunning: !!stale, statusFa: stale ? 'در حال اجرا - heartbeat قدیمی، بررسی PM2/WebService لازم است' : '' }; }); return sendJson(res, 200, { ok:true, list:jobs, job:jobs[0]||null, serverTime: time.serverTimePayload() }); }
    if (pathname === '/api/mongo/health') {
      const db = await connectMongo();
      await db.command({ ping: 1 });
      return sendJson(res, 200, { ok: true, uri: config.mongoUri.replace(/:\/\/.*@/, '://***@') });
    }
    if (pathname === '/api/mongo/init' && req.method === 'POST') { // FIX-C2
      if (!requireRole(req, res, ['admin'])) return;
      return sendJson(res, 200, await initMongo());
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await collectBody(req);
      const db = await connectMongo();
      const username = String(body.username || '').trim();
      const user = await db.collection('users').findOne({ username, isActive: { $ne: false } });
      if (!user || String(user.password || '') !== String(body.password || '')) return sendJson(res, 401, { ok:false, error:'نام کاربری یا رمز عبور اشتباه است' });
      const mapping = await db.collection('userShayganMappings').findOne({ username:user.username, isActive:{ $ne:false } });
      const safeUser = { username:user.username, fullName:user.fullName, role:user.role, canPurchase: user.canPurchase === true, canViewPurchaseInvoices: user.canViewPurchaseInvoices === true, canPostPurchaseToBoard: user.canPostPurchaseToBoard === true, canManageBoardEvents: user.canManageBoardEvents === true, permissions: ROLE_PERMISSIONS[user.role] || [], mapping: mapping ? { cashboxAccountNumber:mapping.cashboxAccountNumber||'', employeeAccountNumber:mapping.employeeAccountNumber||'', storeName:mapping.storeName||'' } : null };
      const token = makeSession(safeUser);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok:true, user: safeUser });
    }
    if (pathname === '/api/auth/logout') {
      clearSession(req, res);
      return sendJson(res, 200, { ok:true });
    }
    if (pathname === '/api/auth/permissions') return sendJson(res, 200, { ok:true, roles: ROLE_PERMISSIONS });
    if (pathname === '/api/auth/me') {
      const s = getSession(req);
      if (!s) return sendJson(res, 401, { ok:false, error:'not authenticated' });
      return sendJson(res, 200, { ok:true, user:s.user });
    }
    if (pathname === '/api/users') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      if (req.method === 'GET') {
        const users = await db.collection('users').find({}, { projection:{ password:0 } }).sort({ username:1 }).limit(200).toArray();
        const list = [];
        for (const u of users) {
          const st = await userIssuedActivityStats(db, u.username);
          list.push({ ...u, issuedCount: st.issuedCount, editLocked: st.hasIssued });
        }
        return sendJson(res, 200, { ok:true, list });
      }
      if (req.method === 'POST') {
        const body = await collectBody(req);
        const originalUsername = String(body.originalUsername || '').trim();
        const username = String(body.username || '').trim();
        if (!username) return sendJson(res, 400, { ok:false, error:'نام کاربری الزامی است' });
        const firstName = String(body.firstName || '').trim();
        const lastName = String(body.lastName || '').trim();
        const fullName = String(body.fullName || `${firstName} ${lastName}`.trim() || username);
        const role = String(body.role || 'seller');
        const mobile = normalizeMobile(body.mobile || '');
        const existingUser = originalUsername ? await db.collection('users').findOne({ username: originalUsername }) : await db.collection('users').findOne({ username });
        if (existingUser) {
          const st = await userIssuedActivityStats(db, existingUser.username);
          if (st.hasIssued && !onlyAllowedLockedUserChange(existingUser, { ...body, username, firstName, lastName, role, mobile })) {
            return sendJson(res, 409, { ok:false, locked:true, issuedCount:st.issuedCount, error:'این کاربر با اکانت خود در CRM فاکتور صادر کرده است؛ نام، نام خانوادگی، نام کاربری، گروه و موبایل قابل تغییر نیست. ادمین همچنان می‌تواند رمز عبور و وضعیت فعال/غیرفعال را تغییر دهد.' });
          }
        }
        if (originalUsername && originalUsername !== username) {
          const duplicate = await db.collection('users').findOne({ username });
          if (duplicate) return sendJson(res, 409, { ok:false, error:'نام کاربری جدید قبلاً برای کاربر دیگری ثبت شده است' });
        }
        const filter = originalUsername ? { username: originalUsername } : { username };
        const update = { username, firstName, lastName, fullName, role, mobile, canPurchase: body.canPurchase === true, canViewPurchaseInvoices: body.canViewPurchaseInvoices === true, canPostPurchaseToBoard: body.canPostPurchaseToBoard === true, canManageBoardEvents: body.canManageBoardEvents === true, isActive: body.isActive !== false, updatedAt: new Date() };
        if (body.password) update.password = String(body.password);
        await db.collection('users').updateOne(filter, { $set: update, $setOnInsert: { createdAt: new Date() } }, { upsert:true });
        await renameUserLinksSafely(db, originalUsername, username, fullName, role);
        await db.collection('appLogs').insertOne({ type:'user_save', username, originalUsername, role, by:body.updatedBy||'admin', at:new Date() }).catch(()=>{});
        return sendJson(res, 200, { ok:true, user:{ username, fullName, firstName, lastName, role, mobile } });
      }
    }
    if (pathname === '/api/users/delete' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      const body = await collectBody(req);
      const username = String(body.username || query.username || '').trim();
      if (!username) return sendJson(res, 400, { ok:false, error:'نام کاربری الزامی است' });
      if (username === 'admin') return sendJson(res, 400, { ok:false, error:'کاربر admin قابل غیرفعال‌سازی نیست' });
      const st = await userIssuedActivityStats(db, username).catch(()=>({ issuedCount:0, hasIssued:false }));
      await db.collection('users').updateOne({ username }, { $set:{ isActive:false, deletedAt:new Date(), deletedBy:currentUser(req)?.username||'admin', updatedAt:new Date() } });
      await db.collection('userShayganMappings').updateMany({ username }, { $set:{ isActive:false, deletedAt:new Date(), deletedBy:currentUser(req)?.username||'admin', updatedAt:new Date() } });
      await db.collection('accountAccess').updateMany({ username }, { $set:{ isActive:false, deletedAt:new Date(), deletedBy:currentUser(req)?.username||'admin', updatedAt:new Date() } }).catch(()=>{});
      await db.collection('appLogs').insertOne({ type:'user_soft_delete', username, issuedCount:st.issuedCount||0, by:currentUser(req)?.username||'admin', at:new Date() }).catch(()=>{});
      return sendJson(res, 200, { ok:true, username, softDeleted:true, issuedCount:st.issuedCount||0 });
    }
    if (pathname === '/api/users/repair-links' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      const users = await db.collection('users').find({}, { projection:{ username:1, fullName:1, role:1 } }).toArray();
      let fixedMappings = 0, fixedAccess = 0, created = 0;
      for (const u of users) {
        const username = String(u.username || '').trim();
        if (!username) continue;
        const m = await db.collection('userShayganMappings').findOne({ username });
        if (!m) { await db.collection('userShayganMappings').insertOne({ username, fullName:u.fullName||username, role:u.role||'seller', storeName:'', cashboxAccountNumber:'', employeeAccountNumber:'', allowedAccountNumbers:[], isActive:true, createdAt:new Date(), updatedAt:new Date() }); created++; }
        const r = await normalizeUserLinks(db, username); fixedMappings += r.mappings; fixedAccess += r.access;
      }
      await db.collection('appLogs').insertOne({ type:'user_links_repair', fixedMappings, fixedAccess, created, by:currentUser(req)?.username||'admin', at:new Date() }).catch(()=>{});
      return sendJson(res, 200, { ok:true, users:users.length, fixedMappings, fixedAccess, created });
    }
    if (pathname === '/api/user-mappings') {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      if (req.method === 'GET') {
        if (isAdmin(req)) {
          const list = await db.collection('userShayganMappings').find({}).sort({ username:1 }).limit(200).toArray();
          return sendJson(res, 200, { ok:true, list });
        }
        const user = currentUser(req);
        const own = await db.collection('userShayganMappings').findOne({ username:user.username, isActive:{ $ne:false } });
        return sendJson(res, 200, { ok:true, list: own ? [own] : [] });
      }
      if (req.method === 'POST') {
        if (!requireRole(req, res, ['admin'])) return;
        const body = await collectBody(req);
        const username = String(body.username || '').trim();
        if (!username) return sendJson(res, 400, { ok:false, error:'username required' });
        const existingUser = await db.collection('users').findOne({ username });
        const update = {
          username,
          fullName: body.fullName || existingUser?.fullName || username,
          role: body.role || existingUser?.role || 'seller',
          storeName: body.storeName || '',
          cashboxAccountNumber: String(body.cashboxAccountNumber || '').trim(),
          cashboxAccountName: String(body.cashboxAccountName || '').trim(),
          employeeAccountNumber: String(body.employeeAccountNumber || '').trim(),
          employeeAccountName: String(body.employeeAccountName || '').trim(),
          canCreateSaleInvoice: body.canCreateSaleInvoice !== false,
          canViewInventory: body.canViewInventory !== false,
          canViewKardex: body.canViewKardex !== false,
          isActive: body.isActive !== false,
          updatedAt: new Date(),
          updatedBy: body.updatedBy || currentUser(req)?.username || 'admin'
        };
        await db.collection('userShayganMappings').updateOne({ username }, { $set: update, $setOnInsert:{ createdAt:new Date() } }, { upsert:true });
        await normalizeUserLinks(db, username);
        const saved = await db.collection('userShayganMappings').findOne({ username });
        await db.collection('appLogs').insertOne({ type:'user_shaygan_mapping_update', username, update, by:update.updatedBy, at:new Date() }).catch(()=>{});
        return sendJson(res, 200, { ok:true, mapping:saved || update });
      }
      if (req.method === 'DELETE') {
        if (!requireRole(req, res, ['admin'])) return;
        const username = String(query.username || '').trim();
        if (!username) return sendJson(res, 400, { ok:false, error:'username required' });
        const old = await db.collection('userShayganMappings').findOne({ username });
        await db.collection('userShayganMappings').deleteMany({ username });
        await db.collection('appLogs').insertOne({ type:'user_shaygan_mapping_delete', username, old, by:currentUser(req)?.username || 'admin', at:new Date() }).catch(()=>{});
        return sendJson(res, 200, { ok:true, username, deleted: old ? 1 : 0 });
      }
    }
    if (pathname === '/api/account-access/my') {
      if (!needLogin(req, res)) return;
      const user = currentUser(req);
      const db = await connectMongo();
      const fullAccessRoles = ['admin','accounting','warehouse','purchase'];
      if (fullAccessRoles.includes(user.role)) return sendJson(res, 200, { ok:true, admin:user.role === 'admin', fullAccess:true, role:user.role, list:[] });
      const mapping = await getUserMapping(user.username);
      const list = [];
      if (mapping?.cashboxAccountNumber) list.push({ accountNumber:mapping.cashboxAccountNumber, accountName:mapping.cashboxAccountName || 'صندوق فروشنده', accountGuid:mapping.cashboxAccountGuid||'', guId:mapping.cashboxAccountGuid||'', source:'mapping' });
      if (mapping?.employeeAccountNumber) list.push({ accountNumber:mapping.employeeAccountNumber, accountName:mapping.employeeAccountName || 'جاری کارکنان / نماینده', accountGuid:mapping.employeeAccountGuid||'', guId:mapping.employeeAccountGuid||'', source:'mapping' });
      const extra = await db.collection('userAccountAccesses').find({ username:user.username }).toArray();
      for (const a of extra) if (!list.find(x=>String(x.accountNumber)===String(a.accountNumber) && String(x.accountGuid||x.guId||'')===String(a.accountGuid||a.guId||''))) list.push({ accountNumber:a.accountNumber, accountName:a.accountName||'', accountGuid:a.accountGuid||a.guId||'', guId:a.accountGuid||a.guId||'', source:'extra' });
      return sendJson(res, 200, { ok:true, admin:false, fullAccess:false, list });
    }
    if (pathname === '/api/user-account-access') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      if (req.method === 'GET') {
        const username = String(query.username || '').trim();
        const filter = username ? { username } : {};
        const list = await db.collection('userAccountAccesses').find(filter).sort({ username:1, accountNumber:1 }).limit(500).toArray();
        return sendJson(res, 200, { ok:true, list });
      }
      if (req.method === 'POST') {
        const body = await collectBody(req);
        const username = String(body.username || '').trim();
        const accounts = Array.isArray(body.accounts) ? body.accounts : [];
        if (!username) return sendJson(res, 400, { ok:false, error:'username required' });
        await db.collection('userAccountAccesses').deleteMany({ username });
        if (accounts.length) {
          await db.collection('userAccountAccesses').insertMany(accounts.filter(a=>a && a.accountNumber).map(a => ({
            username,
            accountNumber: String(a.accountNumber),
            accountName: a.accountName || '',
            accountGuid: a.accountGuid || a.guId || '',
            guId: a.accountGuid || a.guId || '',
            accountKey: a.accountKey || '',
            note: a.note || '',
            createdAt: new Date(),
            updatedAt: new Date(),
            updatedBy: body.updatedBy || 'admin'
          })));
        }
        await db.collection('appLogs').insertOne({ type:'account_access_update', username, accounts, by:body.updatedBy||'admin', at:new Date() }).catch(()=>{});
        return sendJson(res, 200, { ok:true, username, count:accounts.length });
      }
    }



    // 0.9.19.34: Sale Snapshot Engine. Independent sale sync for future supplier profit, seller performance and market prediction.
    if (pathname === '/api/sale-snapshot/init' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.init(db));
    }
    if (pathname === '/api/sale-snapshot/start' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.buildSaleSnapshot(db, {
        dateFrom: body.dateFrom || query.dateFrom || '14050101',
        dateTo: body.dateTo || query.dateTo || '',
        maxPages: Number(body.maxPages || query.maxPages || 300),
        pageSize: Number(body.pageSize || query.pageSize || 20),
        maxDetailInvoices: Number(body.maxDetailInvoices || query.maxDetailInvoices || 0),
        reset: body.reset === true || body.reset === 'true' || query.reset === 'true',
        mode: body.mode || query.mode || 'incremental'
      }));
    }
    if (pathname === '/api/sale-snapshot/snapshots' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.listSnapshots(db, Number(query.limit || 20)));
    }
    if (pathname === '/api/sale-snapshot/status' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.status(db, query.snapshotId || ''));
    }
    if (pathname === '/api/sale-snapshot/lines' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.lines(db, {
        snapshotId: query.snapshotId || '',
        itemCode: query.itemCode || '',
        sellerAccountNumber: query.sellerAccountNumber || '',
        dateFrom: query.dateFrom || '',
        dateTo: query.dateTo || '',
        limit: Number(query.limit || 500)
      }));
    }

    if (pathname === '/api/sale-snapshot/seller-performance' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await saleSnapshot.sellerPerformance(db, {
        sellerAccountNumber: query.sellerAccountNumber || query.seller || '',
        dateFrom: query.dateFrom || '',
        dateTo: query.dateTo || '',
        limit: Number(query.limit || 5000),
        invoiceLimit: Number(query.invoiceLimit || 1000),
        lineLimit: Number(query.lineLimit || 1000)
      }));
    }


    // 0.9.19.27: Supplier stock sleep based on purchase invoice layers, not Kardex.
    if (pathname === '/api/supplier-sleep/init' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      await purchaseSleep.ensureIndexes(db);
      return sendJson(res, 200, { ok:true, version:purchaseSleep.VERSION, collections:['supplierPurchaseInvoices','supplierPurchaseLayers','supplierInventoryAllocation','supplierSleepSummary','supplierSleepSnapshots','supplierSleepDiagnostics','supplierSleepInvoiceSummary','supplierSleepGroupSummary'] });
    }
    if (pathname === '/api/supplier-sleep/sync-purchases' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.readPurchaseInvoicesByDateRange(db, {
        dateFrom: body.dateFrom || query.dateFrom || '14050101',
        dateTo: body.dateTo || query.dateTo || '',
        maxPages: Number(body.maxPages || query.maxPages || 300),
        pageSize: Number(body.pageSize || query.pageSize || 20),
        maxInvoices: Number(body.maxInvoices || query.maxInvoices || 0)
      }));
    }
    if (pathname === '/api/supplier-sleep/supplier-index' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getSupplierIndex(db, {
        sync: body.sync !== false,
        dateFrom: body.dateFrom || query.dateFrom || '14050101',
        dateTo: body.dateTo || query.dateTo || '',
        maxPages: Number(body.maxPages || query.maxPages || 300),
        pageSize: Number(body.pageSize || query.pageSize || 20),
        maxInvoices: Number(body.maxInvoices || query.maxInvoices || 500),
        maxScanNumbers: Number(body.maxScanNumbers || query.maxScanNumbers || 6000)
      }));
    }
    if (pathname === '/api/supplier-sleep/supplier-index' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getSupplierIndex(db, {
        sync: false,
        dateFrom: query.dateFrom || '14050101',
        dateTo: query.dateTo || ''
      }));
    }
    if (pathname === '/api/supplier-sleep/supplier-invoices' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getSupplierInvoices(db, {
        dateFrom: query.dateFrom || '14050101',
        dateTo: query.dateTo || '',
        supplierAccountNo: query.supplierAccountNo || '',
        limit: Number(query.limit || 500)
      }));
    }
    if (pathname === '/api/supplier-sleep/build' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.buildPurchaseLayerSnapshot(db, {
        dateFrom: body.dateFrom || query.dateFrom || '14050101',
        dateTo: body.dateTo || query.dateTo || '',
        maxPages: Number(body.maxPages || query.maxPages || 300),
        pageSize: Number(body.pageSize || query.pageSize || 20),
        maxInvoices: Number(body.maxInvoices || query.maxInvoices || 0),
        maxInventoryRows: Number(body.maxInventoryRows || query.maxInventoryRows || 0)
      }));
    }

    if (pathname === '/api/supplier-sleep/selected-supplier-invoices' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.readPurchaseInvoicesForSupplier(db, body || {}));
    }


    if (pathname === '/api/supplier-sleep/selected-supplier-invoices-job' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      const activeJob = await supplierSleepActiveJob(db);
      if (supplierSleepJobManager.isRunning('supplier-sleep') || activeJob) return sendJson(res, 409, { ok:false, error:'یک Job خواب کالا/خواندن فاکتور خرید در حال اجراست؛ برای جلوگیری از فشار روی شایگان همزمان اجرا نمی‌شود.', running:true, jobId:activeJob?.jobId||'' });
      const jobId = `JOB-SUPPLIER-SLEEP-READ-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
      const now = new Date();
      const safeRequest = { ...body, supplierGuid:body?.supplierGuid?'[set]':'', accountGuid:body?.accountGuid?'[set]':'' };
      await db.collection('appJobs').updateOne({ jobId }, { $set:{ jobId, type:'supplier-sleep-read-selected-invoices', status:'queued', createdAt:now, updatedAt:now, request:safeRequest } }, { upsert:true }).catch(()=>{});
      startSupplierSleepBackgroundJob({ db, jobId, operation:'read-selected-invoices', request:body||{}, mapResult:result=>{
          const slimList = (result.list||[]).slice(0, 1000).map(x => ({
            invNo:x.invNo, invDate:x.invDate, supplierAccountNo:x.supplierAccountNo, supplierName:x.supplierName,
            totalAmount:x.totalAmount, rowCount:x.rowCount
          }));
          return { ok:!!result.ok, source:result.source||'', statementRows:result.statementRows||0, invoiceNoCandidates:result.invoiceNoCandidates||0, count:result.count||0, fallbackUsed:!!result.fallbackUsed, list:slimList, diagnostics:result.diagnostics||null, error:result.error||'' };
      }});
      return sendJson(res, 200, { ok:true, jobId, status:'queued', type:'supplier-sleep-read-selected-invoices', note:'خواندن فاکتورهای خرید به Job پس‌زمینه‌ای منتقل شد. ترک صفحه نباید Job را متوقف کند.' });
    }
    if (pathname === '/api/supplier-sleep/build-selected-job' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      const activeJob = await supplierSleepActiveJob(db);
      if (supplierSleepJobManager.isRunning('supplier-sleep') || activeJob) return sendJson(res, 409, { ok:false, error:'یک Job خواب کالا در حال اجراست؛ برای جلوگیری از فشار روی شایگان همزمان اجرا نمی‌شود.', running:true, jobId:activeJob?.jobId||'' });
      const jobId = `JOB-SUPPLIER-SLEEP-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
      const now = new Date();
      await db.collection('appJobs').updateOne({ jobId }, { $set:{ jobId, type:'supplier-sleep-build-selected', status:'queued', phase:'build-selected-snapshot', createdAt:now, updatedAt:now, request:{ ...body, supplierGuid:body?.supplierGuid?'[set]':'', accountGuid:body?.accountGuid?'[set]':'' } } }, { upsert:true }).catch(()=>{});
      startSupplierSleepBackgroundJob({ db, jobId, operation:'build-selected-snapshot', request:body||{}, mapResult:result=>{
        return { ok:!!result.ok, snapshotId:result.snapshot?.snapshotId||'', source:result.source||'', summaryCount:result.summary?.length||0, invoiceSummaryCount:result.invoiceSummary?.length||0, groupSummaryCount:result.groupSummary?.length||0, purchaseInvoicesSynced:result.snapshot?.purchaseInvoicesSynced||0, purchaseLayerCount:result.snapshot?.purchaseLayerCount||0, totalAllocatedValue:result.snapshot?.totalAllocatedValue||0, totalUnknownValue:result.snapshot?.totalUnknownValue||0, reconciliation:result.reconciliation||null, error:result.error||'' };
      }});
      return sendJson(res, 200, { ok:true, jobId, status:'queued', type:'supplier-sleep-build-selected', note:'Job خواب کالا در پس‌زمینه شروع شد. وضعیت را از /api/jobs/status?jobId=... بگیرید.' });
    }
    if (pathname === '/api/supplier-sleep/build-selected' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.buildSelectedSupplierSnapshot(db, body || {}));
    }
    if (pathname === '/api/supplier-sleep/snapshots' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.listSnapshots(db, Number(query.limit || 20)));
    }
    if (pathname === '/api/supplier-sleep/snapshot-update' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      const actor=(req.user&&req.user.username)||'crm-user';
      const out=await purchaseSleep.updateSnapshot(db, body.snapshotId||query.snapshotId||'', body, actor);
      return sendJson(res, out.ok?200:400, out);
    }
    if (pathname === '/api/supplier-sleep/snapshot-delete' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      const actor=(req.user&&req.user.username)||'crm-user';
      const out=await purchaseSleep.deleteSnapshot(db, body.snapshotId||query.snapshotId||'', actor);
      return sendJson(res, out.ok?200:404, out);
    }
    if (pathname === '/api/supplier-sleep/suppliers' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getSummary(db, query.snapshotId || '', Number(query.limit || 300)));
    }
    if (pathname === '/api/supplier-sleep/layers' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getLayers(db, { snapshotId:query.snapshotId||'', supplierAccountNo:query.supplierAccountNo||'', itemCode:query.itemCode||'', mainGroupCode:query.mainGroupCode||'', limit:Number(query.limit||500) }));
    }
    if (pathname === '/api/supplier-sleep/invoice-summary' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getInvoiceSummary(db, { snapshotId:query.snapshotId||'', supplierAccountNo:query.supplierAccountNo||'', limit:Number(query.limit||500) }));
    }
    if (pathname === '/api/supplier-sleep/group-summary' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getGroupSummary(db, { snapshotId:query.snapshotId||'', supplierAccountNo:query.supplierAccountNo||'', mainGroupCode:query.mainGroupCode||'', limit:Number(query.limit||300) }));
    }
    if (pathname === '/api/supplier-sleep/profit-diagnostics' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await purchaseSleep.getProfitDiagnostics(db, { snapshotId:query.snapshotId||'' }));
    }

    if (pathname === '/api/stock-sleep/init' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      await stockSleep.ensureStockSleepIndexes(db);
      return sendJson(res, 200, { ok:true, version:stockSleep.VERSION, collections:['stockSleepSnapshots','stockSleepQueue','stockSleepItemLayers','stockSleepSupplierSummary','stockSleepHistory'] });
    }
    if (pathname === '/api/stock-sleep/snapshots' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await stockSleep.listSnapshots(db, Number(query.limit || 20)));
    }
    if (pathname === '/api/stock-sleep/start' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const body = await collectBody(req);
      const active = await getActiveWarehouseNumbers(db);
      const result = await stockSleep.createStockSleepSnapshot(db, {
        activeWarehouses: active,
        fiscalYearStart: body.fiscalYearStart || query.fiscalYearStart || '14050101',
        kardexMaxRows: Number(body.kardexMaxRows || query.kardexMaxRows || 80),
        maxItems: Number(body.maxItems || query.maxItems || 0),
        createdBy: currentUser(req)?.username || 'system'
      });
      // 0.9.19.26.2 SALE-SAFE: no automatic Kardex/background processing on snapshot creation.
      // Processing must be triggered explicitly from /api/stock-sleep/process to avoid any pressure on Shaygan invoice provider.
      return sendJson(res, 200, { ...result, note:'Snapshot created only. No Kardex/WebService processing started automatically. Use /api/stock-sleep/process manually.' });
    }
    if (pathname === '/api/stock-sleep/process' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const body = await collectBody(req);
      const snapshotId = body.snapshotId || query.snapshotId || (await db.collection('stockSleepSnapshots').findOne({}, { sort:{ startedAt:-1 } }))?.snapshotId;
      if (!snapshotId) return sendJson(res, 400, { ok:false, error:'snapshotId required' });
      return sendJson(res, 200, await stockSleep.processSnapshotBatch(db, snapshotId, { limit:Number(body.limit || query.limit || 5) }));
    }
    if (pathname === '/api/stock-sleep/process-all' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const body = await collectBody(req);
      const snapshotId = body.snapshotId || query.snapshotId || (await db.collection('stockSleepSnapshots').findOne({}, { sort:{ startedAt:-1 } }))?.snapshotId;
      if (!snapshotId) return sendJson(res, 400, { ok:false, error:'snapshotId required' });
      return sendJson(res, 200, await stockSleep.processSnapshotToEnd(db, snapshotId, { limit:Number(body.limit || query.limit || 5), maxLoops:Number(body.maxLoops || query.maxLoops || 200) }));
    }
    if (pathname === '/api/stock-sleep/status' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await stockSleep.getSnapshotStatus(db, query.snapshotId || ''));
    }
    if (pathname === '/api/stock-sleep/suppliers' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await stockSleep.getSupplierSummary(db, query.snapshotId || '', Number(query.limit || 200)));
    }
    if (pathname === '/api/stock-sleep/layers' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      return sendJson(res, 200, await stockSleep.getItemLayers(db, query.snapshotId || '', { supplierAccountNo:query.supplierAccountNo||'', itemCode:query.itemCode||'', warehouseNo:query.warehouseNo||'', limit:Number(query.limit || 500) }));
    }
    if (pathname === '/api/supplier-aging/candidates') {
      if (!canUseSupplierAging(req, res)) return;
      const db = await connectMongo();
      const selected = await selectedAgingSuppliers(db, false);
      const selectedMap = Object.fromEntries(selected.map(x=>[String(x.accountId),x]));
      // 0.9.19.17→WS: getSupplierPurchaseCandidates SQL → searchAccounts WS
      const wsR = await shaygan.searchAccounts(query.q || query.term || '', 100).catch(() => ({ ok:false, list:[] }));
      const list = (wsR.list || []).map(x => ({ accountId: Number(x.accountId||x.AccountId||0), accountNumber: x.accountNumber||x.AccountNumber||'', accountName: x.accountName||x.AccountName||x.name||'', ...x, selected:!!selectedMap[String(x.accountId||x.AccountId||0)], selectedDoc:selectedMap[String(x.accountId||x.AccountId||0)]||null }));
      return sendJson(res, 200, { ok:true, list, source:'shaygan-webservice-account-search' });
    }
    if (pathname === '/api/supplier-aging/selected') {
      if (!canUseSupplierAging(req, res)) return;
      const db = await connectMongo();
      if (req.method === 'GET') return sendJson(res, 200, { ok:true, list: await selectedAgingSuppliers(db, false) });
      if (req.method === 'POST') {
        const body = await collectBody(req);
        const accountId = Number(body.accountId || 0);
        if (!accountId) return sendJson(res, 400, { ok:false, error:'AccountId تأمین‌کننده الزامی است' });
        const now = new Date();
        const doc = {
          accountId,
          accountNumber:String(body.accountNumber||''),
          accountName:String(body.accountName||''),
          group:String(body.group||''),
          paymentMethod:String(body.paymentMethod || body.settlementType || 'mixed'),
          settlementBasis:String(body.settlementBasis || 'inventory_date'),
          manualSettlementDays: body.manualSettlementDays === '' || body.manualSettlementDays == null ? null : Number(body.manualSettlementDays),
          checkDueDays: body.checkDueDays === '' || body.checkDueDays == null ? null : Number(body.checkDueDays),
          goodsDelayDays: body.goodsDelayDays === '' || body.goodsDelayDays == null ? 0 : Number(body.goodsDelayDays),
          autoSettlementEnabled: body.autoSettlementEnabled !== false,
          minPurchaseRial:Number(body.minPurchaseRial||0),
          isActive: body.isActive !== false,
          note:String(body.note||''),
          updatedAt:now,
          updatedBy:currentUser(req)?.username || 'admin'
        };
        await db.collection('supplierAgingSuppliers').updateOne({ accountId }, { $set:doc, $setOnInsert:{ createdAt:now } }, { upsert:true });
        return sendJson(res, 200, { ok:true, item: await db.collection('supplierAgingSuppliers').findOne({ accountId }) });
      }
      if (req.method === 'DELETE') {
        const accountId = Number(query.accountId || 0);
        if (!accountId) return sendJson(res, 400, { ok:false, error:'accountId required' });
        await db.collection('supplierAgingSuppliers').deleteOne({ accountId });
        return sendJson(res, 200, { ok:true });
      }
    }
    if (pathname === '/api/supplier-aging/seed' && req.method === 'POST') {
      if (!canUseSupplierAging(req, res)) return;
      const db = await connectMongo();
      const r = await ensureDefaultAgingSuppliers(db, currentUser(req)?.username || 'admin');
      return sendJson(res, 200, { ok:true, ...r, list: await selectedAgingSuppliers(db, false) });
    }
    if (pathname === '/api/supplier-aging/last-report') {
      if (!canUseSupplierAging(req, res)) return;
      const db = await connectMongo();
      const doc = await db.collection('supplierAgingLastReports').findOne({ key:'latest-origin-summary' });
      return sendJson(res, 200, { ok:true, found:!!doc, generatedAt:doc?.generatedAt||null, report:doc?.report||null });
    }
    if (pathname === '/api/supplier-aging/report') {
      if (!canUseSupplierAging(req, res)) return;
      const r = await buildSupplierAgingReport({ supplierAccountId: query.supplierAccountId || query.accountId || '', originAccountId: Object.prototype.hasOwnProperty.call(query, 'originAccountId') ? query.originAccountId : undefined });
      const db = await connectMongo();
      await db.collection('supplierAgingLastReports').updateOne({ key:'latest-origin-summary' }, { $set:{ key:'latest-origin-summary', generatedAt:new Date(), report:r, query:{...query} } }, { upsert:true }).catch(()=>{});
      return sendJson(res, 200, r);
    }

    if (pathname === '/api/settings') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, list: await db.collection('settings').find({}).sort({ key: 1 }).toArray() });
      const body = await collectBody(req);
      if (!body.key) return sendJson(res, 400, { ok: false, error: 'key required' });
      await db.collection('settings').updateOne({ key: body.key }, { $set: { key: body.key, value: body.value, updatedBy: body.updatedBy || 'admin', updatedAt: new Date() } }, { upsert: true });
      await db.collection('appLogs').insertOne({ type: 'setting_change', key: body.key, value: body.value, at: new Date() });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/shaygan/fiscal-databases') {
      if (!requireRole(req, res, ['admin'])) return;
      try {
        const db = await connectMongo();
        const modeDoc = await db.collection('settings').findOne({ key:'shayganSqlFiscalMode' });
        const dbDoc = await db.collection('settings').findOne({ key:'shayganSqlFiscalDatabase' });
        // 0.9.19.17→WS: fiscal database state بدون SQL
        return sendJson(res, 200, { ok:true, mode:'webservice-only', activeDatabase:'N/A', savedMode:'N/A', savedDatabase:'', message:'اتصال مستقیم SQL حذف شده؛ WebService رسمی شایگان استفاده می‌شود.' });
      } catch(e) { return sendJson(res, 500, { ok:false, error:e.message, code:e.code||'' }); }
    }
    if (pathname === '/api/shaygan/fiscal-database' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      try {
        // 0.9.19.17→WS: fiscal database تنظیم بدون SQL
        return sendJson(res, 200, { ok:true, mode:'webservice-only', message:'تغییر fiscal database در حالت WebService-only معنی ندارد.' });
      } catch(e) { return sendJson(res, 500, { ok:false, error:e.message, code:e.code||'' }); }
    }
    if (pathname === '/api/shaygan/sql-health') { // FIX-C2
      if (!requireRole(req, res, ['admin'])) return;
      return sendJson(res, 200, { ok:false, disabled:true, message:'اتصال مستقیم SQL از نسخه 0.9.19.17-WS حذف شده؛ WebService رسمی شایگان استفاده می‌شود.' });
    }
    if (pathname === '/api/shaygan/health') { // FIX-C2
      if (!needLogin(req, res)) return;
      const r = await shaygan.getStocks();
      return sendJson(res, 200, { ok: r.ok, count: r.list?.length || 0, error: r.error || '' });
    }
    if (pathname === '/api/stocks' || pathname === '/api/shaygan/stocks') {
      const r = await shaygan.getStocks();
      const db = await connectMongo();
      const active = await getActiveWarehouseNumbers(db);
      const listAll = r.list || [];
      const list = active.length ? listAll.filter(x => active.includes(String(x.stockNumber || x.STNumber || x.StockNumber || ''))) : listAll;
      return sendJson(res, 200, { ok: r.ok, list, allList:listAll, activeWarehouseNumbers:active, unrestricted:!active.length, error: r.error || '' });
    }
    if (pathname === '/api/settings/sale-invoice-extras') {
      const db = await connectMongo();
      if (req.method === 'GET') {
        if (!needLogin(req, res)) return;
        return sendJson(res, 200, { ok:true, list: await getAllowedSaleInvoiceExtras(db) });
      }
      if (req.method === 'POST') {
        if (!requireRole(req, res, ['admin'])) return;
        const body = await collectBody(req);
        const list = (Array.isArray(body.list) ? body.list : Array.isArray(body.allowed) ? body.allowed : [])
          .map(normalizeAllowedInvoiceExtra)
          .filter(x => x.accountNumber);
        await db.collection('settings').updateOne({ key: SALE_ALLOWED_EXTRAS_KEY }, { $set:{ key: SALE_ALLOWED_EXTRAS_KEY, value:list, updatedBy:currentUser(req)?.username || 'admin', updatedAt:new Date() } }, { upsert:true });
        await db.collection('appLogs').insertOne({ type:'sale_invoice_extras_settings_update', count:list.length, by:currentUser(req)?.username || 'admin', at:new Date() }).catch(()=>{});
        return sendJson(res, 200, { ok:true, list });
      }
    }

    if (pathname === '/api/settings/active-warehouses') {
      if (!requireRole(req, res, ['admin'])) return;
      const db = await connectMongo();
      if (req.method === 'GET') {
        const r = await shaygan.getStocks().catch(e => ({ ok:false, error:String(e.message||e), list:[] }));
        const active = await getActiveWarehouseNumbers(db);
        return sendJson(res, 200, { ok:r.ok, stocks:r.list||[], activeWarehouseNumbers:active, unrestricted:!active.length, error:r.error||'' });
      }
      if (req.method === 'POST') {
        const body = await collectBody(req);
        const active = [...new Set((Array.isArray(body.activeWarehouseNumbers) ? body.activeWarehouseNumbers : []).map(x => String(x||'').trim()).filter(Boolean))];
        await db.collection('settings').updateOne({ key:'inventory.activeWarehouseNumbers' }, { $set:{ key:'inventory.activeWarehouseNumbers', value:active, updatedBy:currentUser(req)?.username || 'admin', updatedAt:new Date() } }, { upsert:true });
        await db.collection('appLogs').insertOne({ type:'active_warehouses_change', activeWarehouseNumbers:active, at:new Date(), by:currentUser(req)?.username || 'admin' }).catch(()=>{});
        return sendJson(res, 200, { ok:true, activeWarehouseNumbers:active, unrestricted:!active.length });
      }
    }
    if (pathname === '/api/accounts/search') { if (!requireRole(req, res, ['admin','accounting','warehouse','purchase','seller','seller_buyer'])) return; const r = await searchAccountsFast(query.q || query.term || '', Number(query.limit || 50), Number(query.pages || config.accountSearchPages || 220)); return sendJson(res, 200, { ok:r.ok, list:r.list||[], source:r.source||'', scannedPages:r.scannedPages||0, cacheCount:r.cacheCount||0, error:r.error||'' }); }
    if (pathname === '/api/suppliers/search') {
      if (!canUsePurchase(req, res)) return;
      const r = await searchAccountsFast(query.q || query.term || '', Number(query.limit || 80), Number(query.pages || config.accountSearchPages || 220));
      const list = (r.list || []).map(a => ({ supplierNumber:a.accountNumber||a.AccountNumber||'', supplierName:a.accountName||a.AccountName||'', supplierGuid:a.guId||a.accountGuid||a.GuId||'', accountNumber:a.accountNumber||a.AccountNumber||'', accountName:a.accountName||a.AccountName||'', accountGuid:a.guId||a.accountGuid||a.GuId||'', raw:a.raw||a }));
      return sendJson(res, 200, { ok:r.ok, list, source:r.source||'', scannedPages:r.scannedPages||0, error:r.error||'' });
    }
    if (pathname === '/api/accounts/sync' && req.method === 'POST') { if (!requireRole(req, res, ['admin'])) return; return sendJson(res, 200, await syncAccountsCatalog(Number(query.pages || config.accountSearchPages || 220))); }
    if (pathname === '/api/items/search') {
      // 0.9.19.17→WS: SQL searchItems حذف شد
      return sendJson(res, 200, await searchItems(query.q || query.term || '', Number(query.limit || 200), Number(query.pages || config.inventorySearchLivePages)));
    }
    if (pathname === '/api/items/search-all') {
      // 0.9.19.17→WS: SQL searchItems حذف شد
      return sendJson(res, 200, await searchAllItems(query.q || query.term || '', Number(query.limit || 200), Number(query.pages || config.inventoryCatalogSyncPages), { forceLive: query.forceLive === '1' || query.forceLive === 'true' }));
    }
    if (pathname === '/api/sale/inventory-snapshot-search') {
      if (!requireRole(req, res, ['admin','seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const filters = { stockNumber: query.stockNumber || '', itemMainGroupCode: query.mainGroupCode || '', itemGroupCode: query.groupCode || '' };
      const r = await searchSaleInventorySnapshot(query.q || query.term || '', Number(query.limit || 30), filters);
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/inventory/search') {
      const filters = { stockNumber: query.stockNumber || '', itemMainGroupCode: query.mainGroupCode || '', itemGroupCode: query.groupCode || '' };
      const r = await searchInventoryRows(query.q || query.term || '', Number(query.limit || 0), Number(query.pages || config.inventoryCatalogSyncPages), filters);
      const dd = dedupeRemainRows(r.list || []);
      return sendJson(res, 200, { ok:r.ok, list:dd.list, groups: inventoryGroups(dd.list), source:(r.source||'')+'-deduped-store-item', scannedPages:r.scannedPages||0, fallback:r.fallback||null, error:r.error||'', rawCount:dd.rawCount, uniqueCount:dd.uniqueCount, duplicateCount:dd.duplicates.length, duplicateConflicts:dd.conflicts });
    }
    if (pathname === '/api/inventory/by-stock') {
      // 0.9.15.9: sellers also need full selected-warehouse inventory for stocktaking/control.
      if (!requireRole(req, res, ['admin','seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const filters = { stockNumber: query.stockNumber || '', itemMainGroupCode: query.mainGroupCode || '', itemGroupCode: query.groupCode || '' };
      if (!filters.stockNumber) return sendJson(res, 400, { ok:false, error:'stockNumber required' });
      // 0.9.19.51: operational by-stock view must use global Mongo snapshot, not WebService stock-filter scan.
      const r = await searchInventoryRows(query.q || '', Number(query.limit || 0), Number(query.pages || config.inventoryCatalogSyncPages), filters);
      const dd = dedupeRemainRows(r.list || []);
      return sendJson(res, 200, { ok:r.ok, list:dd.list, groups: inventoryGroups(dd.list), source:(r.source||'inventory-snapshot-by-stock')+'-by-stock-snapshot', scannedPages:0, exactRefresh:r.exactRefresh||null, fallback:r.fallback||null, error:r.error||'', rawCount:dd.rawCount, uniqueCount:dd.uniqueCount, duplicateCount:dd.duplicates.length, duplicateConflicts:dd.conflicts });
    }
    if (pathname === '/api/inventory/debug-item' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const itemCode = String(query.itemCode || query.code || '').trim();
      const stockNumber = String(query.stockNumber || query.STNumber || '').trim();
      if (!itemCode) return sendJson(res, 400, { ok:false, error:'itemCode required' });
      const before = await readInventoryRowsForItem(db, itemCode);
      const refresh = await ensureItemInventoryFresh(db, itemCode, 'debug-item-endpoint').catch(e => ({ ok:false, error:String(e.message||e) }));
      const after = await readInventoryRowsForItem(db, itemCode);
      const kardex = await shaygan.getKardexByItemCode(itemCode, stockNumber, { maxRows: Number(query.maxRows || 10), hardMaxRows: Math.max(Number(query.maxRows || 10), 10) }).catch(e => ({ ok:false, rows:[], error:String(e.message||e) }));
      const active = await getActiveWarehouseNumbers(db).catch(()=>[]);
      const activeSet = new Set((active||[]).map(String));
      const activeAfter = after.filter(x => Number(x.quantity||0)>0 && (!activeSet.size || activeSet.has(String(x.stockNumber||''))));
      return sendJson(res, 200, { ok:true, itemCode, stockNumber, activeWarehouseNumbers:active, before:{ count:before.length, rows:before }, refresh, after:{ count:after.length, positiveActiveCount:activeAfter.length, rows:after, positiveActiveRows:activeAfter }, kardex:{ ok:kardex.ok, rowCount:(kardex.rows||[]).length, rows:(kardex.rows||[]), meta:kardex.meta||{}, error:kardex.error||'' }, serverTime:time.serverTimePayload(), source:'inventory-debug-item-unified-core' });
    }

    if (pathname === '/api/inventory/consistency-check' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const itemCode = String(query.itemCode || query.code || '').trim();
      const stockNumber = String(query.stockNumber || query.STNumber || '').trim();
      if (!itemCode) return sendJson(res, 400, { ok:false, error:'itemCode required' });
      const targeted = await shaygan.getInventoryByItemCode(itemCode).catch(e => ({ ok:false, list:[], error:String(e.message||e) }));
      const targetedList = stockNumber ? (targeted.list || []).filter(x => String(x.stockNumber) === stockNumber) : (targeted.list || []);
      const mongoDocs = await db.collection('itemInventoryCatalog').find({ $or:[ { itemCode }, { itemCode: new RegExp(escapeRe(itemCode), 'i') } ] }).limit(100).toArray().catch(()=>[]);
      const snapshot = await searchActiveInventorySnapshot(itemCode, 50, stockNumber ? { stockNumber } : {});
      return sendJson(res, 200, { ok:true, itemCode, stockNumber, targetedGetRemain:{ ok:targeted.ok, list:targetedList, total:(targeted.list||[]).length, error:targeted.error||'' }, mongo:{ count:mongoDocs.length, list:mongoDocs }, snapshot:{ source:snapshot.source, count:(snapshot.list||[]).length, groups:snapshot.groups||[] } });
    }
    if (pathname === '/api/inventory/auto-sync/status' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      return sendJson(res, 200, await readAutoInventoryStatus());
    }
    if (pathname === '/api/inventory/auto-sync/run' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      return sendJson(res, 200, await runAutoInventorySyncTick());
    }
    if (pathname === '/api/catalog/sync' && req.method === 'POST') { if (!requireRole(req, res, ['admin'])) return; return sendJson(res, 200, await syncCatalog(Number(query.pages || config.inventoryCatalogSyncPages))); }
    if (pathname === '/api/catalog/sync-all-items' && req.method === 'POST') { if (!requireRole(req, res, ['admin'])) return; return sendJson(res, 200, await syncAllItemsCatalog(query.pages === 'all' ? 0 : Number(query.pages || 0), { jobId: query.jobId || '' })); }
    if (pathname === '/api/catalog/sync-accounts' && req.method === 'POST') { if (!requireRole(req, res, ['admin'])) return; return sendJson(res, 200, await syncAccountsCatalog(Number(query.pages || config.accountSearchPages || 220))); }
    const invMatch = pathname.match(/^\/api\/items\/([^/]+)\/inventory$/) || pathname.match(/^\/api\/shaygan\/inventory\/([^/]+)$/);
    if (invMatch) {
      const code = decodeURIComponent(invMatch[1]);
      const stockNumber = query.stockNumber || query.STNumber || '';
      // 0.9.19.51: live item refresh then return final positive cache rows for the exact item.
      const dbi = await connectMongo();
      const r = await authoritativeLiveReconcileItem(dbi, code, 'item-inventory-endpoint');
      const finalRows = (await readInventoryRowsForItem(dbi, code)).filter(x => Number(x.quantity || 0) > 0);
      const list = stockNumber ? finalRows.filter(x => String(x.stockNumber || x.STNumber || '') === String(stockNumber)) : finalRows;
      return sendJson(res, 200, { ok: r.ok, list, refresh:r, source:'item-inventory-safe-refresh-final-cache', error: r.error || '' });
    }
    const karMatch = pathname.match(/^\/api\/items\/([^/]+)\/kardex$/) || pathname.match(/^\/api\/shaygan\/kardex\/([^/]+)$/);
    if (karMatch) {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase','seller','seller_buyer'])) return;
      const u = currentUser(req) || {};
      const role = String(u.role || 'seller');
      const requested = Number(query.maxRows || query.limit || 0);
      const roleDefault = role === 'admin' ? config.kardexAdminQuickMaxRows : config.kardexSellerMaxRows;
      const roleHardMax = role === 'admin' ? config.kardexAdminFullMaxRows : config.kardexSellerMaxRows;
      const maxRows = requested > 0 ? Math.min(requested, roleHardMax) : roleDefault;
      const code = decodeURIComponent(karMatch[1]);
      // 0.9.19.51: ensure item inventory context first, then read Kardex with explicit error response.
      const dbk = await connectMongo();
      const inventoryEnsure = await authoritativeLiveReconcileItem(dbk, code, 'before-kardex').catch(e => ({ ok:false, error:String(e.message||e) }));
      const r = await shaygan.getKardexByItemCode(code, query.stockNumber || query.STNumber || '', { maxRows, hardMaxRows: roleHardMax }).catch(e => ({ ok:false, rows:[], item:null, meta:{}, error:String(e.message||e) }));
      let inventoryRepair = null;
      if (r.ok) inventoryRepair = await repairInventorySnapshotFromKardex(dbk, code, query.stockNumber || query.STNumber || '', r).catch(e => ({ ok:false, error:String(e.message||e) }));
      return sendJson(res, 200, { ok: r.ok, item: r.item, rows: r.rows || [], meta: r.meta || {}, inventoryEnsure, inventoryRepair, error: r.error || '' });
    }

    const lastPurchaseMatch = pathname.match(/^\/api\/items\/([^/]+)\/last-purchase$/);
    if (lastPurchaseMatch) {
      if (!needLogin(req, res)) return;
      const code = decodeURIComponent(lastPurchaseMatch[1]);
      // 0.9.19.17→WS: SQL last-purchase حذف شد
      const r = await shaygan.getKardexByItemCode(code, '', { maxRows: config.kardexAdminFullMaxRows, hardMaxRows: config.kardexAdminFullMaxRows });
      const rows = (r.rows || []).filter(x => Number(x.inQty || 0) > 0);
      rows.sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')) || Number(b.invoiceNumber||0)-Number(a.invoiceNumber||0));
      const row = rows[0] || null;
      const raw = row && row.raw ? row.raw : {};
      let price = Number(row?.salePrice || raw.Price || raw.Rial || 0);
      const qty = Number(row?.inQty || raw.Quan || raw.IncomeQuan1 || 0);
      if (qty > 0 && price > 0 && price > 100000000000) price = Math.round(price/qty);
      if (qty > 0 && !Number(raw.Price || 0) && Number(raw.Rial || 0) > 0) price = Math.round(Number(raw.Rial)/qty);
      return sendJson(res, 200, { ok:true, item:r.item||null, lastPurchase: row ? { price, date:row.date||'', supplierName:row.accountName||raw.CustomerName||'', supplierNumber:row.accountNumber||raw.CustomerNumber||'', invoiceNumber:row.invoiceNumber||raw.InvoiceNumber||'', invoiceType:row.invoiceType||raw.InvoiceType||'', quantity:qty, raw } : null, error:r.error||'' });
    }

    const serialMatch = pathname.match(/^\/api\/items\/([^/]+)\/serials$/);
    if (serialMatch) {
      const r = await shaygan.getSerialsByItemStock({
        itemCode: decodeURIComponent(serialMatch[1]),
        itemGuid: query.itemGuid || query.ItemGuId || '',
        stockNumber: query.stockNumber || query.STNumber || '',
        stockGuid: query.stockGuid || query.STGuId || ''
      });
      return sendJson(res, 200, r);
    }


    const invoiceAnnMatch = pathname.match(/^\/api\/invoices\/(\d+)\/annotations$/);
    if (invoiceAnnMatch) {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      const invNo = String(invoiceAnnMatch[1]);
      const invTyp = Number(query.invType || 2);
      if (req.method === 'GET') {
        const list = await db.collection('invoiceCrmAnnotations').find({ invNo, invTyp }).sort({ at:-1 }).limit(100).toArray();
        return sendJson(res, 200, { ok:true, list });
      }
      if (req.method === 'POST') {
        const user = currentUser(req);
        if (!['admin','accounting'].includes(String(user?.role||''))) return deny(res, 'ثبت یادداشت فاکتور فقط برای مدیر و حسابداری مجاز است');
        const body = await collectBody(req);
        const note = String(body.note || body.reason || '').trim();
        if (!note) return sendJson(res, 400, { ok:false, error:'متن یادداشت/علت الزامی است' });
        const doc = { invNo, invTyp, type:'note', note, by:user.username||'', byName:user.fullName||user.username||'', at:new Date() };
        await db.collection('invoiceCrmAnnotations').insertOne(doc);
        return sendJson(res, 200, { ok:true, doc });
      }
    }
    const invoiceLeadMatch = pathname.match(/^\/api\/invoices\/(\d+)\/crm-lead$/);
    if (invoiceLeadMatch && req.method === 'POST') {
      if (!needLogin(req, res)) return;
      const user = currentUser(req);
      if (!['admin','accounting'].includes(String(user?.role||''))) return deny(res, 'اصلاح Lead ID فاکتور فقط برای مدیر و حسابداری مجاز است');
      const db = await connectMongo();
      const invNo = String(invoiceLeadMatch[1]);
      const invTyp = Number(query.invType || 2);
      const body = await collectBody(req);
      const newLeadId = String(body.leadId || '').trim();
      const reason = String(body.reason || '').trim();
      if (!reason) return sendJson(res, 400, { ok:false, error:'علت اصلاح Lead ID الزامی است' });
      const prev = await db.collection('invoiceCrmLeadOverrides').findOne({ invNo, invTyp });
      await db.collection('invoiceCrmLeadOverrides').updateOne({ invNo, invTyp }, { $set:{ invNo, invTyp, leadId:newLeadId, updatedBy:user.username||'', updatedByName:user.fullName||user.username||'', updatedAt:new Date() }, $setOnInsert:{ createdAt:new Date() } }, { upsert:true });
      const log = { invNo, invTyp, type:'lead_update', oldLeadId:prev?.leadId||'', newLeadId, reason, by:user.username||'', byName:user.fullName||user.username||'', at:new Date() };
      await db.collection('invoiceCrmAnnotations').insertOne(log);
      await db.collection('appLogs').insertOne({ type:'invoice_crm_lead_update', ...log }).catch(()=>{});
      return sendJson(res, 200, { ok:true, leadId:newLeadId, log });
    }

    const invoiceMatch = pathname.match(/^\/api\/invoices\/(\d+)$/) || pathname.match(/^\/api\/shaygan\/invoice\/(\d+)$/);
    if (invoiceMatch) { const r = await shaygan.getInvoice(invoiceMatch[1], query.invType || 2); return sendJson(res, 200, { ok: r.ok, list: r.list || [], error: r.error || '' }); }
    if (pathname === '/api/invoices/last-sale') return sendJson(res, 200, await shaygan.getLastSaleInvoiceNumber());
    if (pathname === '/api/invoice-numbers/reserve' && req.method === 'POST') return sendJson(res, 200, await reserveInvoiceNumber(await collectBody(req)));
    if (pathname === '/api/invoice-numbers/reservations') { const db = await connectMongo(); return sendJson(res, 200, { ok: true, list: await db.collection('invoiceReservations').find({}).sort({ reservedAt: -1 }).limit(50).toArray() }); }
    if (pathname === '/api/customers' && req.method === 'POST') {
      if (!needLogin(req, res)) return;
      const body = await collectBody(req); const db = await connectMongo();
      const mobile = normalizePhone09(body.mobile || '');
      const nationalCode = normalizeNationalCode(body.nationalCode || '');
      const fullName = String(body.fullName || body.name || '').trim();
      if (!fullName && !mobile && !nationalCode) return sendJson(res, 400, { ok:false, error:'نام، موبایل یا کد ملی الزامی است' });
      const key = mobile ? `mobile:${mobile}` : nationalCode ? `nc:${nationalCode}` : `name:${normalizeFa(fullName)}`;
      const searchText = normalizeFa(`${fullName} ${mobile} ${nationalCode}`);
      const qinfo = customerDataQuality({ fullName, mobile, nationalCode });
      await db.collection('customers').updateOne({ customerKey:key }, { $set:{ customerKey:key, fullName, mobile, nationalCode, notes:body.notes||'', searchText, dataQualityStatus:qinfo.status, dataQualityFlags:qinfo.flags, trustScore:qinfo.trustScore, updatedAt:new Date(), lastSource:'manual' }, $setOnInsert:{ createdAt:new Date(), firstSource:'manual', purchaseCount:0, totalPurchaseAmount:0 } }, { upsert:true });
      const customer = await db.collection('customers').findOne({ customerKey:key });
      return sendJson(res, 200, { ok:true, customer });
    }
    if (pathname === '/api/readiness/concurrency') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const [drafts, reservations, audits, customers] = await Promise.all([
        db.collection('purchaseDrafts').countDocuments({ status:'issuing' }).catch(()=>0),
        db.collection('invoiceReservations').countDocuments({ status:'reserved', expiresAt:{ $gt:new Date() } }).catch(()=>0),
        db.collection('invoiceAuditLogs').countDocuments({ at:{ $gte:new Date(Date.now()-24*60*60*1000) } }).catch(()=>0),
        db.collection('customers').estimatedDocumentCount().catch(()=>0)
      ]);
      return sendJson(res, 200, { ok:true, version:APP_VERSION, expectedConcurrentUsers:20, currentLocks:{ issuingPurchaseDrafts:drafts, activeInvoiceReservations:reservations }, last24h:{ invoiceAuditLogs:audits }, customers, rules:['invoice reservation per invType','purchase draft issuing lock','no startup sync','search catalog indexes present','sale issue uses user mapping','manual lead id stored for commission audit','invoiceWithoutLead flag for pilot penalty'] });
    }
    if (pathname === '/api/customers/search') {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      const qRaw = String(query.q || query.term || '').trim();
      const q = normalizeFa(qRaw);
      const tokens = tokensOf(q);
      const escapeRe = (x) => String(x || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const customerTokenFilter = (t) => {
        const re = new RegExp(escapeRe(t), 'i');
        return { $or:[
          { searchText: re },
          { fullName: re },
          { customerName: re },
          { mobile: re },
          { mobiles: re },
          { nationalCode: re },
          { nationalCodes: re },
          { accountName: re },
          { lastSourceStore: re },
          { lastSalesChannel: re },
          { lastBusinessUnit: re }
        ]};
      };
      let filter = {};
      if (tokens.length) {
        filter = { $and: tokens.map(customerTokenFilter) };
      }
      // Exact numeric fallback: some synced customers from older versions did not have searchText.
      const numeric = normalizeMobile(qRaw) || String(qRaw || '').replace(/[^0-9۰-۹٠-٩]/g, '').replace(/[۰-۹]/g, d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
      const list = await db.collection('customers').find(filter).sort({ purchaseCount:-1, lastPurchaseDate:-1 }).limit(Number(query.limit||30)).toArray();
      if (!list.length && numeric) {
        const re = new RegExp(escapeRe(numeric), 'i');
        const fallback = await db.collection('customers').find({ $or:[{mobile:re},{mobiles:re},{nationalCode:re},{nationalCodes:re},{customerKey:re}] }).sort({ purchaseCount:-1, lastPurchaseDate:-1 }).limit(Number(query.limit||30)).toArray();
        return sendJson(res, 200, { ok:true, list:fallback, source:'customers-numeric-fallback' });
      }
      return sendJson(res, 200, { ok:true, list, source:'customers-search-v2' });
    }

    const customerProfileMatch = pathname.match(/^\/api\/customers\/profile\/(.+)$/);
    if (customerProfileMatch) {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      const key = decodeURIComponent(customerProfileMatch[1]);
      const customer = await db.collection('customers').findOne({ $or:[{ customerKey:key }, { _id: ObjectId.isValid(key) ? new ObjectId(key) : null }].filter(x=>x._id!==null) });
      if (!customer) return sendJson(res, 404, { ok:false, error:'مشتری پیدا نشد' });
      const history = await db.collection('customerInvoiceHistory').find({ customerKey: customer.customerKey }).sort({ invDate:-1 }).limit(200).toArray();
      return sendJson(res, 200, { ok:true, customer, history });
    }
    if (pathname === '/api/customers/intelligence') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const type = String(query.type || 'frequent').trim();
      const list = await customerIntelligenceReport(type, query);
      const summary = await customerReportsSummary();
      return sendJson(res, 200, { ok:true, type, summary, list });
    }
    if (pathname === '/api/customers/history-report') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const type = String(query.type || 'site').trim();
      const list = await customerHistoryReport(type, query);
      const summary = await customerReportsSummary();
      return sendJson(res, 200, { ok:true, type, summary, list });
    }
    if (pathname === '/api/customers/reports') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const summary = await customerReportsSummary();
      const type = String(query.type||'').trim();
      let filter = {};
      if (type === 'missing-mobile') filter = { $or:[{mobile:''},{mobile:null},{mobile:{$exists:false}}] };
      if (type === 'missing-national') filter = { $or:[{nationalCode:''},{nationalCode:null},{nationalCode:{$exists:false}}] };
      if (type === 'invalid') filter = { dataQualityStatus:'invalid' };
      if (type === 'partial') filter = { dataQualityStatus:{ $in:['partial','incomplete'] } };
      if (type === 'repeated') filter = { purchaseCount:{ $gte:2 } };
      if (type === 'site') {
        const keys = await db.collection('customerInvoiceHistory').distinct('customerKey', siteHistoryFilter()).catch(()=>[]);
        filter = { customerKey:{ $in:keys } };
      }
      if (type === 'console') {
        const keys = await db.collection('customerInvoiceHistory').distinct('customerKey', consoleHistoryFilter()).catch(()=>[]);
        filter = { customerKey:{ $in:keys } };
      }
      const list = type ? await db.collection('customers').find(filter).sort({ updatedAt:-1 }).limit(Number(query.limit||100)).toArray() : [];
      return sendJson(res, 200, { ok:true, summary, list });
    }
    if (pathname === '/api/customers/quality/duplicates') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const kind = String(query.kind||'mobile');
      const field = kind === 'national' ? 'nationalCode' : 'mobile';
      const list = await db.collection('customers').aggregate([
        { $match:{ [field]:{ $nin:['', null] } } },
        { $group:{ _id:`$${field}`, count:{ $sum:1 }, names:{ $addToSet:'$fullName' }, customers:{ $push:{ customerKey:'$customerKey', fullName:'$fullName', purchaseCount:'$purchaseCount', totalPurchaseAmount:'$totalPurchaseAmount' } } } },
        { $match:{ count:{ $gte:2 } } },
        { $sort:{ count:-1 } }, { $limit:Number(query.limit||100) }
      ]).toArray();
      return sendJson(res, 200, { ok:true, kind, list });
    }
    if (pathname === '/api/customers/sync-sql-fiscal' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      const body = await collectBody(req);
      const databases = Array.isArray(body.databases) ? body.databases : String(body.databases || 'CY000002,CY000001').split(',').map(x=>x.trim()).filter(Boolean);
      const r = await syncCustomersFromSqlFiscalDbs({ databases, maxRowsPerDb:Number(body.maxRowsPerDb || query.maxRowsPerDb || 50000) });
      try { r.channelRepair = await repairCustomerChannelTagsFromHistory(await connectMongo()); } catch(e) { r.channelRepairError = String(e.message||e); }
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/customers/repair-channel-tags' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const r = await repairCustomerChannelTagsFromHistory(await connectMongo());
      const summary = await customerReportsSummary();
      return sendJson(res, 200, { ok:true, ...r, summary });
    }

    if (pathname === '/api/customers/top') {
      if (!requireRole(req, res, ['admin','accounting','purchase','seller','seller_buyer'])) return;
      const db = await connectMongo();
      const list = await db.collection('customers').find({ purchaseCount:{ $gte: Number(query.min || 2) } }).sort({ purchaseCount:-1, totalPurchaseAmount:-1 }).limit(Number(query.limit||50)).toArray();
      return sendJson(res, 200, { ok:true, list });
    }
    if (pathname === '/api/customers/stats') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const total = await db.collection('customers').estimatedDocumentCount().catch(()=>0);
      const repeated = await db.collection('customers').countDocuments({ purchaseCount:{ $gte:2 } }).catch(()=>0);
      const lastRun = await db.collection('customerSyncRuns').find({}).sort({ startedAt:-1 }).limit(1).toArray();
      return sendJson(res, 200, { ok:true, total, repeated, lastRun:lastRun[0]||null });
    }
    if (pathname === '/api/customers/sync-shaygan-sales' && req.method === 'POST') {
      if (!requireRole(req, res, ['admin'])) return;
      const body = await collectBody(req);
      const r = await syncCustomersFromShayganSales({ days:Number(body.days || query.days || 365), pages:Number(body.pages || query.pages || 80) });
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/leads' && req.method === 'POST') { const db = await connectMongo(); const body = await collectBody(req); const leadId = body.leadId || `LEAD-${Date.now()}`; const doc = { ...body, leadId, status: body.status || 'new', createdAt: new Date(), updatedAt: new Date() }; await db.collection('leads').insertOne(doc); return sendJson(res, 200, { ok: true, lead: doc }); }
    if (pathname === '/api/leads/search') { const db = await connectMongo(); const q = normalizeText(query.q || ''); const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); return sendJson(res, 200, { ok: true, list: await db.collection('leads').find({ $or: [{ leadId: re }, { customerName: re }, { mobile: re }] }).limit(20).toArray() }); }

    if (pathname === '/api/lead-id/health') {
      const base = getLeadIdBaseUrl();
      if (!base) return sendJson(res, 200, { ok:false, configured:false, error:'LEAD_ID_BASE_URL تنظیم نشده است' });
      const timeoutMs = Number(process.env.LEAD_ID_TIMEOUT_MS || 2500);
      const apiKey = String(process.env.LEAD_ID_API_KEY || process.env.LEAD_API_KEY || '').trim();
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}/api/integration/health`, { headers:{ ...(apiKey ? { 'x-lead-api-key': apiKey } : {}) }, signal:controller.signal });
        const text = await r.text();
        let json=null; try { json=JSON.parse(text); } catch (_) {}
        return sendJson(res, 200, { ok:r.ok && Boolean(json?.ok), configured:true, base, httpStatus:r.status, response:json || text });
      } catch(e) {
        return sendJson(res, 200, { ok:false, configured:true, base, error:String(e.message||e) });
      } finally { clearTimeout(timer); }
    }

    if (pathname === '/api/reports/sale-lead-audit' || pathname === '/api/lead-audit/sales' || pathname === '/api/sales/lead-audit' || pathname === '/api/lead-control/sales') {
      if (!requireRole(req, res, ['admin','accounting','purchase'])) return;
      const db = await connectMongo();
      const days = Math.min(Math.max(Number(query.days || 31), 1), 180);
      const limit = Math.min(Math.max(Number(query.limit || 500), 1), 2000);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const mode = String(query.mode || '').trim();
      const seller = String(query.seller || '').trim().toLowerCase();
      const leadIdFilter = normalizeManualLeadId(query.leadId || '');

      function isBadManualLead(v) {
        const x = normalizeManualLeadId(v).toLowerCase();
        if (!x) return false;
        if (['0','00','000','test','تست','بدون','ندارد','no','none'].includes(x)) return true;
        if (x.length < 3) return true;
        return false;
      }
      function pickInvoiceNumber(x) {
        return String(x.invoiceNumber || x.result?.Number || x.leadManual?.shayganInvoiceNo || x.response?.result?.Number || x.response?.Number || '').trim();
      }
      function rowFromLock(x) {
        const lm = x.leadManual || { leadId: normalizeManualLeadId(x.request?.leadId || ''), invoiceWithoutLead: !normalizeManualLeadId(x.request?.leadId || ''), leadPenaltyEligible: !normalizeManualLeadId(x.request?.leadId || '') };
        const leadId = normalizeManualLeadId(lm.leadId || '');
        return {
          _id: String(x._id || x.saleIssueKey || ''),
          issuedAt: x.issuedAt || x.updatedAt || x.createdAt || null,
          invoiceNumber: pickInvoiceNumber(x),
          mappingUsername: x.mappingUsername || x.mapping?.username || '',
          fullName: x.mapping?.fullName || x.request?.username || x.username || '',
          storeName: x.mapping?.storeName || x.storeName || '',
          leadId,
          invoiceWithoutLead: Boolean(lm.invoiceWithoutLead || !leadId),
          leadPenaltyEligible: Boolean(lm.leadPenaltyEligible || !leadId),
          leadEntryMode: lm.entryMode || x.leadEntryMode || 'manual',
          customerName: x.requestPreview?.customerName || x.request?.customerName || '',
          mobile: x.requestPreview?.mobile || x.request?.mobile || '',
          itemsCount: Number(x.requestPreview?.itemsCount || (Array.isArray(x.request?.items) ? x.request.items.length : 0) || 0),
          discountAmount: Number(x.requestPreview?.discountAmount || x.request?.discountAmount || 0),
          source: x.__source || 'saleIssueLocks',
          leadSyncStatus: x.leadSyncStatus || (leadId ? 'unknown' : 'not_required'),
          leadSyncOk: Boolean(x.leadSyncOk),
          leadSyncError: x.leadSyncError || '',
          leadSyncedAt: x.leadSyncedAt || null
        };
      }
      function rowFromAudit(a) {
        const leadId = normalizeManualLeadId(a.leadManual?.leadId || a.request?.leadId || '');
        return {
          _id: String(a.saleIssueKey || a._id || ''),
          issuedAt: a.at || a.createdAt || null,
          invoiceNumber: String(a.response?.result?.Number || a.response?.Number || a.result?.Number || '').trim(),
          mappingUsername: a.mappingUsername || a.request?.mappingUsername || '',
          fullName: a.request?.username || '',
          storeName: a.storeName || '',
          leadId,
          invoiceWithoutLead: Boolean(a.leadManual?.invoiceWithoutLead || !leadId),
          leadPenaltyEligible: Boolean(a.leadManual?.leadPenaltyEligible || !leadId),
          leadEntryMode: a.leadManual?.entryMode || 'manual',
          customerName: a.request?.customerName || '',
          mobile: a.request?.mobile || '',
          itemsCount: Number(Array.isArray(a.request?.items) ? a.request.items.length : 0),
          discountAmount: Number(a.request?.discountAmount || 0),
          source: 'invoiceAuditLogs',
          leadSyncStatus: a.leadSyncStatus || (leadId ? 'unknown' : 'not_required'),
          leadSyncOk: Boolean(a.leadSyncOk),
          leadSyncError: a.leadSyncError || '',
          leadSyncedAt: a.leadSyncedAt || null
        };
      }

      const lockFilter = { status:'issued', $or:[ { issuedAt:{ $gte: since } }, { updatedAt:{ $gte: since } } ] };
      const [locks, audits] = await Promise.all([
        db.collection('saleIssueLocks').find(lockFilter).sort({ issuedAt:-1, updatedAt:-1 }).limit(limit).toArray().catch(()=>[]),
        db.collection('invoiceAuditLogs').find({ type:'sale_issue', at:{ $gte: since }, ok:true }).sort({ at:-1 }).limit(limit).toArray().catch(()=>[])
      ]);

      const byKey = new Map();
      for (const x of locks.map(rowFromLock)) {
        const key = x.invoiceNumber ? `inv:${x.invoiceNumber}` : `id:${x._id}`;
        byKey.set(key, x);
      }
      for (const x of audits.map(rowFromAudit)) {
        const key = x.invoiceNumber ? `inv:${x.invoiceNumber}` : `id:${x._id}`;
        if (!byKey.has(key)) byKey.set(key, x);
        else {
          const cur = byKey.get(key);
          if (!cur.leadId && x.leadId) cur.leadId = x.leadId;
          if (!cur.fullName && x.fullName) cur.fullName = x.fullName;
          cur.invoiceWithoutLead = !cur.leadId;
          cur.leadPenaltyEligible = !cur.leadId;
        }
      }
      let list = Array.from(byKey.values()).sort((a,b)=>new Date(b.issuedAt||0)-new Date(a.issuedAt||0));

      // Second-pass dedupe: older builds could create one row from saleIssueLocks and one row from invoiceAuditLogs
      // where the audit row had no invoiceNumber yet. Collapse near-identical rows by lead/mobile/time, preferring rows with invoiceNumber and saleIssueLocks.
      function rowPriority(x) { return (x.invoiceNumber ? 100 : 0) + (x.source === 'saleIssueLocks' ? 10 : 0) + (x.leadSyncStatus === 'success' ? 3 : 0); }
      const compact = [];
      for (const row of list) {
        const t = row.issuedAt ? new Date(row.issuedAt).getTime() : 0;
        let merged = false;
        for (let i = 0; i < compact.length; i++) {
          const cur = compact[i];
          const ct = cur.issuedAt ? new Date(cur.issuedAt).getTime() : 0;
          const sameInvoice = row.invoiceNumber && cur.invoiceNumber && row.invoiceNumber === cur.invoiceNumber;
          const sameLeadCustomer = row.leadId && cur.leadId && row.leadId === cur.leadId && String(row.mobile||'') === String(cur.mobile||'') && Math.abs(t-ct) <= 10*60*1000;
          const sameCustomerTimeNoLead = !row.leadId && !cur.leadId && String(row.mobile||'') && String(row.mobile||'') === String(cur.mobile||'') && Math.abs(t-ct) <= 5*60*1000;
          if (sameInvoice || sameLeadCustomer || sameCustomerTimeNoLead) {
            const better = rowPriority(row) > rowPriority(cur) ? row : cur;
            const other = better === row ? cur : row;
            compact[i] = { ...other, ...better, sources: Array.from(new Set([...(other.sources||[other.source]).filter(Boolean), ...(better.sources||[better.source]).filter(Boolean)])) };
            merged = true;
            break;
          }
        }
        if (!merged) compact.push(row);
      }
      list = compact;

      // Normalize closer display names: use users.fullName when mappingUsername is available, so username/fullName duplicates are not treated as different sellers.
      const usernamesForNames = Array.from(new Set(list.map(x => String(x.mappingUsername||'').toLowerCase()).filter(Boolean)));
      if (usernamesForNames.length) {
        const usersForNames = await db.collection('users').find({ username:{ $in:usernamesForNames } }).project({ username:1, fullName:1, name:1 }).toArray().catch(()=>[]);
        const nameMap = new Map(usersForNames.map(u => [String(u.username||'').toLowerCase(), u.fullName || u.name || u.username]));
        list = list.map(x => ({ ...x, fullName: nameMap.get(String(x.mappingUsername||'').toLowerCase()) || x.fullName || x.mappingUsername || 'نامشخص' }));
      }

      const leadCounts = {};
      for (const x of list) if (x.leadId) leadCounts[x.leadId] = (leadCounts[x.leadId] || 0) + 1;
      list = list.map(x => ({ ...x, duplicateLead: Boolean(x.leadId && leadCounts[x.leadId] > 1), badLeadFormat: isBadManualLead(x.leadId) }));

      if (query.withoutLead === '1' || mode === 'without') list = list.filter(x => x.invoiceWithoutLead);
      if (mode === 'with') list = list.filter(x => !x.invoiceWithoutLead);
      if (mode === 'duplicate') list = list.filter(x => x.duplicateLead);
      if (mode === 'bad') list = list.filter(x => x.badLeadFormat);
      if (leadIdFilter) list = list.filter(x => x.leadId === leadIdFilter);
      if (seller) list = list.filter(x => String(x.mappingUsername || x.fullName || '').toLowerCase().includes(seller));

      const bySellerMap = new Map();
      for (const x of list) {
        const k = x.mappingUsername || x.fullName || 'نامشخص';
        if (!bySellerMap.has(k)) bySellerMap.set(k, { seller:k, fullName:x.fullName||'', total:0, withLead:0, withoutLead:0, penaltyEligible:0, duplicateLead:0, badLeadFormat:0 });
        const r = bySellerMap.get(k); r.total++;
        if (x.leadId) r.withLead++; else r.withoutLead++;
        if (x.leadPenaltyEligible) r.penaltyEligible++;
        if (x.duplicateLead) r.duplicateLead++;
        if (x.badLeadFormat) r.badLeadFormat++;
      }
      const bySeller = Array.from(bySellerMap.values()).sort((a,b)=>b.withoutLead-a.withoutLead || b.total-a.total);
      const summary = {
        total: list.length,
        withoutLead: list.filter(x => x.invoiceWithoutLead).length,
        withLead: list.filter(x => x.leadId).length,
        penaltyEligible: list.filter(x => x.leadPenaltyEligible).length,
        duplicateLead: list.filter(x => x.duplicateLead).length,
        badLeadFormat: list.filter(x => x.badLeadFormat).length,
        leadSyncSuccess: list.filter(x => x.leadSyncStatus === 'success').length,
        leadSyncFailed: list.filter(x => x.leadSyncStatus === 'failed' || x.leadSyncStatus === 'not_found').length,
        leadSyncNotConfigured: list.filter(x => x.leadSyncStatus === 'not_configured').length,
        uniqueLeadIds: Object.keys(leadCounts).length,
        sourceLocks: locks.length,
        sourceAudits: audits.length
      };
      return sendJson(res, 200, { ok:true, days, mode, source:'mkcrm:saleIssueLocks+invoiceAuditLogs', summary, bySeller, list: list.slice(0, limit) });
    }

    if (pathname === '/api/reports/seller-sales-profit/sellers') {
      if (!canUseSellerPerformance(req, res)) return;
      const db = await connectMongo();
      const maps = await db.collection('userShayganMappings').find({ isActive:{ $ne:false } }).sort({ employeeAccountNumber:1, fullName:1 }).limit(800).toArray().catch(()=>[]);
      const by = new Map();
      for (const m of maps) {
        const emp = String(m.employeeAccountNumber || '').trim();
        if (!emp) continue;
        if (!by.has(emp)) by.set(emp, { username:m.username||'', fullName:m.fullName||`نماینده ${emp}`, storeName:m.storeName||'', cashboxAccountNumber:m.cashboxAccountNumber||'', employeeAccountNumber:emp, sellerKey:emp, source:'userShayganMappings.employeeAccountNumber' });
      }
      return sendJson(res, 200, { ok:true, source:'employeeAccountNumber-current-account-mapping', list:[...by.values()].sort((a,b)=>String(a.employeeAccountNumber).localeCompare(String(b.employeeAccountNumber),'fa')) });
    }
    if (pathname === '/api/reports/seller-sales-profit/history') {
      if (!canUseSellerPerformance(req, res)) return;
      const db = await connectMongo();
      if (query.id) {
        let oid = null;
        try { oid = new ObjectId(String(query.id)); } catch {}
        const doc = oid ? await db.collection('sellerPerformanceHistory').findOne({ _id:oid, type:'seller-performance' }) : null;
        return sendJson(res, 200, { ok:true, found:!!doc, generatedAt:doc?.generatedAt || null, filters:doc?.filters || null, report:doc?.report || null });
      }
      const list = await db.collection('sellerPerformanceHistory').find({ type:'seller-performance' }).sort({ generatedAt:-1 }).limit(30).project({ report:0 }).toArray().catch(()=>[]);
      return sendJson(res, 200, { ok:true, list });
    }
    if (pathname === '/api/reports/seller-sales-profit/latest') {
      if (!canUseSellerPerformance(req, res)) return;
      const db = await connectMongo();
      const doc = await getLatestSellerPerformanceHistory(db, query);
      return sendJson(res, 200, { ok:true, found:!!doc, generatedAt:doc?.generatedAt || null, filters:doc?.filters || null, report:doc?.report || null });
    }
    if (pathname === '/api/reports/seller-sales-profit') {
      if (!canUseSellerPerformance(req, res)) return;
      try {
        const db = await connectMongo();
        const force = String(query.force || query.update || '').trim() === '1' || String(query.force || query.update || '').toLowerCase() === 'true';
        if (!force) {
          const cached = await getLatestSellerPerformanceHistory(db, query);
          if (cached?.report) return sendJson(res, 200, { ...cached.report, ok:true, cached:true, generatedAt:cached.generatedAt, cacheSource:'sellerPerformanceHistory' });
        }
        const r = await buildSellerSalesProfitReport(query);
        if (r.ok) {
          const doc = await saveSellerPerformanceHistory(db, query, r, currentUser(req)?.username || 'system');
          return sendJson(res, 200, { ...r, cached:false, generatedAt:doc.generatedAt, historyId:String(doc._id) });
        }
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { ok:false, error:String(e.message||e), code:e.code||'' });
      }
    }



    if (pathname === '/api/board/events') {
      if (!requirePage(req, res, 'tablo')) return;
      const db = await connectMongo();
      const filter = {};
      if (query.status && query.status !== 'all') filter.status = String(query.status);
      if (query.type && query.type !== 'all') filter.type = String(query.type);
      const listRaw = await db.collection('boardEvents').find(filter).sort({ createdAt:-1 }).limit(Math.max(1, Math.min(Number(query.limit||200), 500))).toArray();
      const list = (listRaw||[]).map(x => ({ ...x, createdAtDisplay: x.createdAtTehran || time.formatTehranDateTime(x.createdAt), updatedAtDisplay: x.updatedAtTehran || time.formatTehranDateTime(x.updatedAt) }));
      return sendJson(res, 200, { ok:true, list, serverTime: time.serverTimePayload() });
    }
    if (pathname === '/api/board/events/status' && req.method === 'POST') {
      if (!needLogin(req, res)) return;
      if (!canManageBoardEventsUser(req)) return deny(res, 'دسترسی تغییر وضعیت تابلو برای این کاربر فعال نیست');
      const body = await collectBody(req); const db = await connectMongo();
      let oid = null; try { oid = new ObjectId(String(body.id || body._id || '')); } catch {}
      if (!oid) return sendJson(res, 400, { ok:false, error:'شناسه رویداد معتبر نیست' });
      const status = String(body.status || 'seen');
      const allowed = ['new','seen','site_updated','closed'];
      if (!allowed.includes(status)) return sendJson(res, 400, { ok:false, error:'وضعیت نامعتبر است' });
      await db.collection('boardEvents').updateOne({ _id:oid }, { $set:{ status, note:String(body.note||''), handledBy:currentUser(req)?.username||'', handledAt:new Date(), updatedAt:new Date() } });
      return sendJson(res, 200, { ok:true });
    }
    if (pathname === '/api/board/purchase-invoices') {
      if (!needLogin(req, res)) return;
      if (!canViewPurchaseInvoicesUser(req)) return deny(res, 'دسترسی مرور فاکتورهای خرید برای این کاربر فعال نیست');
      const r = await readLastPurchaseInvoicesFromShaygan(Number(query.limit || 30));
      const db = await connectMongo();
      const announced = await db.collection('boardEvents').find({ type:'stock_in', purchaseInvoiceNo:{ $in:(r.list||[]).map(x=>String(x.invNo)) } }).project({ purchaseInvoiceNo:1 }).toArray().catch(()=>[]);
      const set = new Set(announced.map(x=>String(x.purchaseInvoiceNo)));
      return sendJson(res, 200, { ...r, list:(r.list||[]).map(x=>({ ...x, raw:undefined, announced:set.has(String(x.invNo)) })) });
    }
    const boardPurchaseOne = pathname.match(/^\/api\/board\/purchase-invoices\/(\d+)$/);
    if (boardPurchaseOne) {
      if (!needLogin(req, res)) return;
      if (!canViewPurchaseInvoicesUser(req)) return deny(res, 'دسترسی مرور فاکتورهای خرید برای این کاربر فعال نیست');
      const no = Number(boardPurchaseOne[1]);
      const r = await shaygan.getInvoice(no, 3).catch(e => ({ ok:false, error:String(e.message||e), list:[] }));
      const inv = r.ok && Array.isArray(r.list) ? r.list[0] : null;
      if (!inv) return sendJson(res, 404, { ok:false, error:'فاکتور خرید پیدا نشد', raw:r.raw||r });
      const lines = (Array.isArray(inv.Body) ? inv.Body : []).map(normalizeBoardItemLine).filter(x=>x.itemCode);
      return sendJson(res, 200, { ok:true, invoice:{ invNo:Number(inv.InvNo||no), invTyp:Number(inv.InvTyp||3), invDate:inv.InvDate||'', supplierNumber:inv.AccountNumber||'', supplierName:inv.AccountName||'', description:inv.InvDescription||'', guId:inv.GuId||'', totalAmount:inv.SourceTotalAmount||inv.TotalAmount||lines.reduce((s,x)=>s+x.amount,0) }, lines });
    }
    const boardPurchaseAnnounce = pathname.match(/^\/api\/board\/purchase-invoices\/(\d+)\/announce$/);
    if (boardPurchaseAnnounce && req.method === 'POST') {
      if (!needLogin(req, res)) return;
      if (!canPostPurchaseToBoardUser(req)) return deny(res, 'دسترسی اعلام ورود کالا در تابلو برای این کاربر فعال نیست');
      const no = Number(boardPurchaseAnnounce[1]);
      const body = await collectBody(req).catch(()=>({}));
      const r = await shaygan.getInvoice(no, 3).catch(e => ({ ok:false, error:String(e.message||e), list:[] }));
      const inv = r.ok && Array.isArray(r.list) ? r.list[0] : null;
      if (!inv) return sendJson(res, 404, { ok:false, error:'فاکتور خرید پیدا نشد', raw:r.raw||r });
      const lines = (Array.isArray(inv.Body) ? inv.Body : []).map(normalizeBoardItemLine).filter(x=>x.itemCode);
      const db = await connectMongo();
      const user = currentUser(req) || {};
      const results = [];
      for (const line of lines) {
        const ev = await createBoardEventOnce(db, {
          type:'stock_in', typeFa:boardEventTypeFa('stock_in'),
          itemCode:line.itemCode, itemName:line.itemName, qty:line.qty, totalQtyAfter:null,
          stockNumber:line.stockNumber, stockName:line.stockName,
          source:'purchase_invoice_review_webservice',
          purchaseInvoiceNo:String(no), purchaseInvoiceGuid:String(inv.GuId||''),
          supplierNumber:String(inv.AccountNumber||''), supplierName:String(inv.AccountName||''),
          createdBy:user.username||'', createdByName:user.fullName||user.username||'',
          note:String(body.note || `اعلام ورود از فاکتور خرید ${no}`), status:'new'
        });
        results.push({ ...line, ...ev });
      }
      const inventoryRefresh = await refreshInventoryCacheForItems(db, lines.map(x => x.itemCode), 'board-purchase-announce-stock-in').catch(e => [{ ok:false, error:String(e.message||e) }]);
      await db.collection('appLogs').insertOne({ type:'board_purchase_announce', purchaseInvoiceNo:no, lineCount:lines.length, inventoryRefreshCount:(inventoryRefresh||[]).filter(x=>x.ok).length, by:user.username||'', at:new Date() }).catch(()=>{});
      return sendJson(res, 200, { ok:true, purchaseInvoiceNo:no, inserted:results.filter(x=>x.inserted).length, skipped:results.filter(x=>!x.inserted).length, results, inventoryRefresh });
    }

    if ((pathname === '/api/sales/issue' || pathname === '/admin/accounting/putInvoice') && req.method === 'POST') {
      if (!canUseSalesFlow(req, res)) return;
      const body = await collectBody(req); const db = await connectMongo();
      body.generalRef = String(body.generalRef || body.GeneralRef || '').trim().slice(0, 80);
      body.invoiceExtras = await validateSaleInvoiceExtras(db, body.invoiceExtras || body.expenses || body.extras || []);
      const user = currentUser(req);
      if (body.sessionUsername && user && String(body.sessionUsername) !== String(user.username)) {
        return sendJson(res, 409, { ok:false, error:'ناهماهنگی نشست کاربر: صفحه با یک کاربر باز است اما Cookie سرور کاربر دیگری است. Logout/Login کنید و دوباره فاکتور بزنید.', pageUser:String(body.sessionUsername), sessionUser:String(user.username) });
      }
      if (user && user.role !== 'admin') { body.mappingUsername = user.username; body.username = user.username; }
      body.leadId = normalizeManualLeadId(body.leadId || body.leadCode || body.leadID || '');
      const mapping = await resolveInvoiceMapping(body, user);
      const leadManual = manualLeadMeta(body, mapping, user || {});
      body.invoiceWithoutLead = leadManual.invoiceWithoutLead;
      body.leadPenaltyEligible = leadManual.leadPenaltyEligible;
      body.leadEntryMode = 'manual';
      const saleIssueKey = stableSaleIssueKey(body, mapping);
      const lock = await beginSaleIssueLock(db, saleIssueKey, body, mapping);
      await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ leadManual } }).catch(()=>{});
      if (!lock.ok) {
        if (lock.issued) {
          {
            const dupNo = Number(lock.existing.invoiceNumber || lock.existing.result?.Number || 0);
            return sendJson(res, 200, { ok:true, duplicate:true, message:'این فاکتور قبلاً ثبت شده و برای جلوگیری از ثبت تکراری دوباره ارسال نشد.', result:lock.existing.result||{}, invoiceNumber:dupNo, invoiceGuid:lock.existing.invoiceGuid||lock.existing.result?.GuId||'', printUrl:lock.existing.printUrl || invoicePrintUrl(dupNo), mapping:lock.existing.mapping||{}, saleIssueKey });
          }
        }
        if (lock.inProgress) {
          return sendJson(res, 409, { ok:false, inProgress:true, error:'صدور این فاکتور در حال انجام است؛ چند لحظه صبر کن و دوباره دکمه را نزن.', saleIssueKey });
        }
      }
      try {
        // 0.9.19.24: fast issue path on 0.9.19.23 base.
        // No getLastInvoiceNumber / local reservation / pre-Put Invoice/Get existence check.
        // Shaygan assigns the real number with InvNo=0; we resolve it from GuId before print.
        const inventoryValidation = await validateSaleInventoryLines(db, body.items || [], 'before-sale-issue').catch(e => ({ ok:false, errors:[{ error:String(e.message||e) }] }));
        if (!inventoryValidation.ok) {
          await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ status:'failed', failedAt:new Date(), updatedAt:new Date(), error:'خطای کنترل موجودی قبل از صدور فاکتور', inventoryValidation, leadManual } }).catch(()=>{});
          return sendJson(res, 409, { ok:false, error:'کنترل موجودی قبل از صدور فاکتور ناموفق بود؛ انبار/تعداد ردیف‌ها را دوباره بررسی کنید.', inventoryValidation, saleIssueKey });
        }
        body.inventoryValidation = inventoryValidation.checked;
        const issueStartedAt = Date.now();
        const originalRequestedInvoiceNumber = Number(body.invoiceNumber || 0) || null;
        body.crmId = body.crmId || saleIssueKey;
        body.invoiceNumber = 0;
        const finalIssueAttempts = [{ attemptNo:1, finalInvoiceNumber:0, source:'shaygan-auto-number-put' }];
        const timing = { startAt:new Date() };
        const putStarted = Date.now();
        const r = await shaygan.putSaleInvoice({
          ...body,
          accountNumber: mapping.cashboxAccountNumber,
          sAccountNumber: mapping.employeeAccountNumber,
          username: mapping.fullName || body.username || mapping.username || 'CRM'
        });
        timing.putMs = Date.now() - putStarted;
        const issuedMeta = extractIssuedInvoiceMeta(r);
        let resolvedIssued = null;
        if (r.ok) {
          const resolveStarted = Date.now();
          resolvedIssued = await resolveIssuedInvoiceAfterPut({ issueResponse:r, body, mapping, invoiceType:2, crmId:body.crmId || saleIssueKey });
          timing.resolveMs = Date.now() - resolveStarted;
          finalIssueAttempts.push({ attemptNo:2, source:'resolve-after-put', method:resolvedIssued.method, invoiceNumber:resolvedIssued.invoiceNumber||0, invoiceGuid:resolvedIssued.invoiceGuid||'', matchScore:resolvedIssued.matchScore||0, matchReasons:resolvedIssued.matchReasons||[], attempts:resolvedIssued.attempts||[] });
        }
        const finalInvoiceNumber = Number(resolvedIssued?.invoiceNumber || issuedMeta.invoiceNumber || 0);
        const result = (resolvedIssued?.result && Object.keys(resolvedIssued.result).length ? resolvedIssued.result : (issuedMeta.result || {}));
        if (finalInvoiceNumber > 0) result.Number = finalInvoiceNumber;
        if ((resolvedIssued?.invoiceGuid || issuedMeta.invoiceGuid) && !result.GuId) result.GuId = resolvedIssued?.invoiceGuid || issuedMeta.invoiceGuid;
        const finalInvoiceGuid = String(resolvedIssued?.invoiceGuid || issuedMeta.invoiceGuid || result.GuId || '');
        timing.totalBeforeResponseMs = Date.now() - issueStartedAt;
        await db.collection('invoiceAuditLogs').insertOne({ type: 'sale_issue', saleIssueKey, mappingUsername: mapping.username, storeName: mapping.storeName || '', cashboxAccountNumber: mapping.cashboxAccountNumber, employeeAccountNumber: mapping.employeeAccountNumber, leadManual, invoiceNumber: finalInvoiceNumber || 0, invoiceGuid: finalInvoiceGuid, printUrl: invoicePrintUrl(finalInvoiceNumber), request: { ...body, originalRequestedInvoiceNumber, finalIssueAttempts, rawBody: undefined }, response: r.raw, resolve: resolvedIssued || null, ok: Boolean(r.ok && finalInvoiceNumber > 0), timing, at: new Date() });
        if (r.ok && finalInvoiceNumber > 0) {
          await db.collection('invoiceReservations').updateOne({ invType: 2, invoiceNumber: finalInvoiceNumber }, { $set: { status: 'used', shayganGuid: finalInvoiceGuid || '', usedAt: new Date(), mappingUsername: mapping.username } });
          const mappingView = { username:mapping.username, fullName:mapping.fullName, storeName:mapping.storeName||'', cashboxAccountNumber:mapping.cashboxAccountNumber, employeeAccountNumber:mapping.employeeAccountNumber };
          await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ status:'issued', issuedAt:new Date(), updatedAt:new Date(), invoiceNumber:finalInvoiceNumber, invoiceGuid:finalInvoiceGuid, printUrl:invoicePrintUrl(finalInvoiceNumber), result, mapping:mappingView, shayganRaw:r.raw, leadManual:{ ...leadManual, shayganInvoiceNo:String(finalInvoiceNumber||''), shayganGuid:String(finalInvoiceGuid || '') }, postProcessingStatus:'queued' } });
          setImmediate(() => runSaleIssuePostProcessing({ db, body:{ ...body }, result, invoiceNumber:finalInvoiceNumber, invoiceGuid:finalInvoiceGuid, saleIssueKey, leadManual, mappingView, user:currentUser(req)||{} }).catch(e => console.error('sale issue post-processing warning:', e.message)));
          return sendJson(res, 200, { ok:true, result, invoiceNumber:finalInvoiceNumber, invoiceGuid:finalInvoiceGuid, printUrl:invoicePrintUrl(finalInvoiceNumber), mapping:mappingView, raw:r.raw, error:'', warning: r.warning||'', saleIssueKey, postProcessing:'queued', timing });
        }
        await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ status:'failed', failedAt:new Date(), updatedAt:new Date(), error:r.error||'خطای ثبت فاکتور فروش', shayganRaw:r.raw, leadManual } });
        return sendJson(res, 400, { ok:false, result, invoiceNumber:finalInvoiceNumber || 0, invoiceGuid:finalInvoiceGuid || issuedMeta.invoiceGuid || '', mapping: { username:mapping.username, fullName:mapping.fullName, storeName:mapping.storeName||'', cashboxAccountNumber:mapping.cashboxAccountNumber, employeeAccountNumber:mapping.employeeAccountNumber }, raw: r.raw, resolve:resolvedIssued || null, timing, error: (r.ok && !finalInvoiceNumber) ? 'فاکتور در شایگان ثبت شد اما شماره واقعی با GUID/جستجوی امروز resolve نشد؛ برای جلوگیری از چاپ اشتباه متوقف شد. invoiceAuditLogs را بررسی کنید.' : (r.error || 'خطای ثبت فاکتور فروش'), saleIssueKey });
      } catch (e) {
        await db.collection('saleIssueLocks').updateOne({ _id:saleIssueKey }, { $set:{ status:'failed', failedAt:new Date(), updatedAt:new Date(), error:String(e.message||e), leadManual } }).catch(()=>{});
        throw e;
      }
    }
    if (pathname === '/admin/accounting/getTurnover' && req.method === 'POST') {
      if (!requireRole(req, res, ['seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const body = await collectBody(req);
      let accountNumber = String(body.accountNumber || body.AccountNumber || '').trim();
      if (!accountNumber) return sendJson(res, 400, { ok:false, error:'کد حساب الزامی است' });
      const user = currentUser(req);
      if (user && !['admin','accounting','warehouse','purchase'].includes(user.role)) {
        const db = await connectMongo();
        const mapping = await getUserMapping(user.username);
        const extra = await db.collection('userAccountAccesses').find({ username:user.username }).toArray();
        const allowedNumbers = [mapping?.cashboxAccountNumber, mapping?.employeeAccountNumber, ...extra.map(x=>x.accountNumber)].filter(Boolean).map(String);
        const allowedGuids = [mapping?.cashboxAccountGuid, mapping?.employeeAccountGuid, ...extra.map(x=>x.accountGuid||x.guId)].filter(Boolean).map(String);
        const requestedGuid = String(body.accountGuid || body.AccountGuId || body.guId || '').trim();
        if (!allowedNumbers.includes(String(accountNumber)) && !(requestedGuid && allowedGuids.includes(requestedGuid))) return deny(res, 'برای مشاهده گردش این حساب دسترسی ندارید');
      }
      // 0.9.19.2: Account turnover/ledger must use Shaygan WebService, not SQL.
      // SQL remains read-only for inventory/kardex/supplier aging item layers only.
      return sendJson(res, 200, await shaygan.getAccountStatement(accountNumber, normalizeDate8Input(body.dateFrom || body.fromDate || ''), normalizeDate8Input(body.dateTo || body.toDate || ''), String(body.accountGuid || body.AccountGuId || body.guId || '').trim(), String(body.accountName || body.AccountName || '').trim()));
    }
    if (pathname === '/api/proformas' && req.method === 'POST') {
      if (!requireRole(req, res, ['seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const body = await collectBody(req);
      const db = await connectMongo();
      const counter = await db.collection('invoiceCounters').findOneAndUpdate(
        { invType: 'proforma' },
        { $inc: { currentNumber: 1 }, $setOnInsert: { createdAt: new Date() }, $set: { updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      const no = counter.value?.currentNumber || counter.currentNumber || Date.now();
      const customer = await upsertCustomerForSale(body);
      const doc = {
        proformaNo: no,
        customerId: customer?._id || null,
        customerName: body.customerName || '',
        mobile: normalizeMobile(body.mobile || ''),
        nationalCode: body.nationalCode || '',
        leadId: body.leadId || '',
        items: Array.isArray(body.items) ? body.items : [],
        totalAmount: (Array.isArray(body.items)?body.items:[]).reduce((s,x)=>s + Number(x.quantity||0)*Number(x.price||0),0),
        createdBy: currentUser(req)?.username || 'system',
        createdByName: currentUser(req)?.fullName || currentUser(req)?.username || 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'issued'
      };
      await db.collection('proformas').insertOne(doc);
      await logAction('proforma_create', { proformaNo:no, createdBy:doc.createdBy, customerName:doc.customerName, mobile:doc.mobile, totalAmount:doc.totalAmount });
      return sendJson(res, 200, { ok:true, proforma:doc });
    }
    const proformaOne = pathname.match(/^\/api\/proformas\/(\d+)$/);
    if (proformaOne && (req.method === 'PUT' || req.method === 'PATCH')) {
      if (!requireRole(req, res, ['seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const filter = await visibleProformaFilter(req, {});
      const proformaNo = Number(proformaOne[1]);
      const existing = await db.collection('proformas').findOne({ ...filter, proformaNo });
      if (!existing) return sendJson(res, 404, { ok:false, error:'پیش‌فاکتور پیدا نشد یا دسترسی ندارید' });
      if (existing.status === 'converted') return sendJson(res, 400, { ok:false, error:'پیش‌فاکتور تبدیل‌شده قابل ویرایش نیست' });
      const body = await collectBody(req);
      const items = Array.isArray(body.items) ? body.items : existing.items || [];
      const cleanItems = items.map(x => ({
        itemCode: String(x.itemCode || x.ItemCode || '').trim(),
        itemDescription: String(x.itemDescription || x.ItemDescription || x.ItemDesc || '').trim(),
        itemGuid: String(x.itemGuid || x.ItemGuId || '').trim(),
        stockNumber: String(x.stockNumber || x.STNumber || '').trim(),
        stockName: String(x.stockName || x.StDesc || '').trim(),
        stockGuid: String(x.stockGuid || x.STGuId || '').trim(),
        quantity: Number(x.quantity || x.Quan || 0),
        price: Number(x.price || x.Price || 0)
      })).filter(x => x.itemCode && x.quantity > 0 && x.price >= 0);
      if (!cleanItems.length) return sendJson(res, 400, { ok:false, error:'پیش‌فاکتور باید حداقل یک ردیف معتبر داشته باشد' });
      const update = {
        customerName: body.customerName !== undefined ? String(body.customerName || '').trim() : existing.customerName,
        mobile: body.mobile !== undefined ? normalizeMobile(body.mobile || '') : existing.mobile,
        nationalCode: body.nationalCode !== undefined ? String(body.nationalCode || '').replace(/[^0-9]/g,'').slice(0,10) : existing.nationalCode,
        leadId: body.leadId !== undefined ? String(body.leadId || '').trim() : existing.leadId,
        items: cleanItems,
        totalAmount: cleanItems.reduce((s,x)=>s + Number(x.quantity||0)*Number(x.price||0),0),
        updatedAt: new Date(),
        updatedBy: currentUser(req)?.username || 'system'
      };
      await db.collection('proformas').updateOne({ _id: existing._id }, { $set: update });
      await logAction('proforma_edit', { proformaNo, updatedBy:update.updatedBy, totalAmount:update.totalAmount, items:cleanItems.length });
      const doc = await db.collection('proformas').findOne({ _id: existing._id });
      return sendJson(res, 200, { ok:true, proforma:doc });
    }
    if (proformaOne && req.method === 'GET') {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      const filter = await visibleProformaFilter(req, {});
      const doc = await db.collection('proformas').findOne({ ...filter, proformaNo:Number(proformaOne[1]) });
      if (!doc) return sendJson(res, 404, { ok:false, error:'پیش‌فاکتور پیدا نشد یا دسترسی ندارید' });
      return sendJson(res, 200, { ok:true, proforma:doc });
    }
    const profConvert = pathname.match(/^\/api\/proformas\/(\d+)\/convert$/);
    if (profConvert && req.method === 'POST') {
      if (!requireRole(req, res, ['seller','seller_buyer','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const user = currentUser(req);
      const proformaNo = Number(profConvert[1]);
      const pfFilter = await visibleProformaFilter(req, {});
      const pf = await db.collection('proformas').findOne({ ...pfFilter, proformaNo });
      if (!pf) return sendJson(res, 404, { ok:false, error:'پیش‌فاکتور پیدا نشد یا دسترسی ندارید' });
      if (pf.status === 'converted') return sendJson(res, 400, { ok:false, error:'این پیش‌فاکتور قبلاً به فاکتور تبدیل شده است', proforma:pf });
      const body = await collectBody(req);
      let lines = Array.isArray(body.items) ? body.items : [];
      if (!lines.length) return sendJson(res, 400, { ok:false, error:'برای تبدیل، باید برای هر ردیف کالا انبار انتخاب شود' });
      const invalid = lines.filter(x => !x.itemCode || !x.stockNumber || Number(x.quantity||0) <= 0 || Number(x.price||0) <= 0);
      if (invalid.length) return sendJson(res, 400, { ok:false, error:'برخی ردیف‌ها کالا/انبار/تعداد/قیمت معتبر ندارند', invalid });
      const mappingBody = { ...body };
      if (user && user.role !== 'admin') { mappingBody.mappingUsername = user.username; mappingBody.username = user.username; }
      const mapping = await resolveInvoiceMapping(mappingBody, user);
      let invoiceNumber = Number(body.invoiceNumber || 0);
      if (!invoiceNumber) {
        const rsv = await reserveInvoiceNumber({ username:mapping.username || user?.username || 'system' });
        invoiceNumber = Number(rsv.reservation.invoiceNumber);
      }
      const customer = await upsertCustomerForSale({ customerName:pf.customerName, mobile:pf.mobile, nationalCode:pf.nationalCode });
      const issueBody = {
        invoiceNumber,
        customerName: pf.customerName,
        mobile: pf.mobile,
        nationalCode: pf.nationalCode,
        leadId: normalizeManualLeadId(pf.leadId || ''),
        crmId: `PF-${pf.proformaNo}`,
        username: mapping.fullName || mapping.username || user?.username || 'CRM',
        items: lines
      };
      const inventoryValidation = await validateSaleInventoryLines(db, issueBody.items || [], 'before-proforma-convert').catch(e => ({ ok:false, errors:[{ error:String(e.message||e) }] }));
      if (!inventoryValidation.ok) return sendJson(res, 409, { ok:false, error:'کنترل موجودی قبل از تبدیل پیش‌فاکتور ناموفق بود؛ برای هر ردیف انبار/تعداد را دوباره انتخاب کنید.', inventoryValidation });
      issueBody.inventoryValidation = inventoryValidation.checked;
      const r = await shaygan.putSaleInvoice({ ...issueBody, accountNumber:mapping.cashboxAccountNumber, sAccountNumber:mapping.employeeAccountNumber });
      const result = r.result[0] || {};
      await db.collection('invoiceAuditLogs').insertOne({ type:'proforma_convert', proformaNo, request:{ ...issueBody, mappingUsername:mapping.username }, response:r.raw, ok:r.ok, at:new Date(), user:user?.username });
      if (!r.ok) return sendJson(res, 400, { ok:false, error:r.error || 'خطا در صدور فاکتور شایگان', raw:r.raw });
      const finalInvoiceNumber = Number(result.Number || invoiceNumber);
      const finalInvoiceGuid = String(result.GuId || '');
      await db.collection('proformas').updateOne({ _id:pf._id }, { $set:{ status:'converted', convertedAt:new Date(), convertedBy:user?.username||'', shayganInvoiceNo:finalInvoiceNumber, shayganGuid:finalInvoiceGuid, convertedItems:lines, customerId:customer?._id || pf.customerId || null, updatedAt:new Date() } });
      await db.collection('invoiceReservations').updateOne({ invType:2, invoiceNumber:finalInvoiceNumber }, { $set:{ status:'used', shayganGuid:finalInvoiceGuid, usedAt:new Date(), mappingUsername:mapping.username } });
      // 0.9.19.54: proforma conversion is also a confirmed sale.
      // Deduct local inventory before stock-out board logic so last-item sales are announced correctly.
      const localInventoryDeduct = await applyLocalSaleInventoryDeductAfterSuccess({
        db,
        body:issueBody,
        invoiceNumber:finalInvoiceNumber,
        invoiceGuid:finalInvoiceGuid,
        saleIssueKey:`proforma:${proformaNo}:${finalInvoiceNumber}`
      }).catch(e => ({ ok:false, error:String(e.message||e), lines:[] }));
      await db.collection('appLogs').insertOne({ type:'proforma_convert_local_inventory_deduct', proformaNo, invoiceNumber:finalInvoiceNumber, invoiceGuid:finalInvoiceGuid, localInventoryDeduct, at:new Date(), atTehran:time.formatTehranDateTime(new Date()), by:user?.username||'' }).catch(()=>{});
      const boardStockOut = await createStockOutBoardEventsAfterSale({ db, body:issueBody, result, mapping, user:user||{}, invoiceNumber:finalInvoiceNumber, invoiceGuid:finalInvoiceGuid, localInventoryDeduct, saleIssueKey:`proforma:${proformaNo}:${finalInvoiceNumber}`, source:'proforma_convert_local_snapshot_after_deduct' }).catch(e => [{ ok:false, error:String(e.message||e) }]);
      await db.collection('appLogs').insertOne({ type:'proforma_convert_post_board_stock_out', proformaNo, invoiceNumber:finalInvoiceNumber, localInventoryDeduct, boardStockOut, at:new Date(), by:user?.username||'' }).catch(()=>{});
      return sendJson(res, 200, { ok:true, result, proformaNo, invoiceNumber:finalInvoiceNumber, localInventoryDeduct, boardStockOut, mapping:{ username:mapping.username, fullName:mapping.fullName, cashboxAccountNumber:mapping.cashboxAccountNumber, employeeAccountNumber:mapping.employeeAccountNumber } });
    }
    if (pathname === '/api/proformas' && req.method === 'GET') {
      if (!needLogin(req, res)) return;
      const db = await connectMongo();
      const filter = await visibleProformaFilter(req, query);
      const list = await db.collection('proformas').find(filter).sort({ createdAt:-1 }).limit(Number(query.limit||200)).toArray();
      return sendJson(res, 200, { ok:true, list });
    }

    if (pathname === '/api/app-logs' && req.method === 'GET') {
      if (!requireRole(req, res, ['admin','accounting','warehouse','purchase'])) return;
      const db = await connectMongo();
      const filter = {};
      if (query.type) filter.type = String(query.type);
      if (query.q) {
        const q = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
        filter.$or = [{ type:q }, { username:q }, { by:q }, { customerName:q }, { mobile:q }];
      }
      const list = await db.collection('appLogs').find(filter).sort({ at:-1 }).limit(Number(query.limit||200)).toArray();
      return sendJson(res, 200, { ok:true, list });
    }

    if (pathname === '/api/purchase-drafts' && req.method === 'GET') {
      if (!canUsePurchase(req, res)) return;
      const user = currentUser(req);
      const db = await connectMongo();
      const filter = {};
      if (!['admin','accounting','warehouse','purchase'].includes(user.role)) filter.createdBy = user.username;
      if (query.status) filter.status = String(query.status);
      if (query.q) {
        const q = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
        filter.$or = [{ supplierName:q }, { supplierMobile:q }, { description:q }];
        if (/^\d+$/.test(String(query.q))) filter.$or.push({ purchaseDraftNo:Number(query.q) });
      }
      const list = await db.collection('purchaseDrafts').find(filter).sort({ createdAt:-1 }).limit(Number(query.limit||200)).toArray();
      return sendJson(res, 200, { ok:true, list });
    }

    if (pathname === '/api/purchase-drafts' && req.method === 'POST') {
      if (!canUsePurchase(req, res)) return;
      const user = currentUser(req);
      const body = await collectBody(req);
      const items = (Array.isArray(body.items) ? body.items : []).map(x => ({
        itemCode: String(x.itemCode || x.ItemCode || '').trim(),
        itemDescription: String(x.itemDescription || x.ItemDescription || x.ItemDesc || '').trim(),
        itemGuid: String(x.itemGuid || x.ItemGuId || '').trim(),
        stockNumber: String(x.stockNumber || x.STNumber || '').trim(),
        stockName: String(x.stockName || x.STDesc || '').trim(),
        stockGuid: String(x.stockGuid || x.STGuId || '').trim(),
        quantity: Number(x.quantity || x.Quan || 0),
        price: Number(x.price || x.Price || 0),
        lastPurchasePrice: Number(x.lastPurchasePrice || 0),
        lastPurchaseSupplier: String(x.lastPurchaseSupplier || '').trim(),
        lastPurchaseDate: String(x.lastPurchaseDate || '').trim()
      })).filter(x => x.itemCode && x.quantity > 0 && x.price >= 0);
      if (!items.length) return sendJson(res, 400, { ok:false, error:'پیش‌نویس خرید باید حداقل یک ردیف معتبر داشته باشد' });
      const db = await connectMongo();
      let existingCounter = await db.collection('counters').findOne({ _id:'purchaseDraftNo' });
      if (!existingCounter) {
        await db.collection('counters').insertOne({ _id:'purchaseDraftNo', currentNumber:9000, createdAt:new Date(), updatedAt:new Date() });
      }
      const counter = await db.collection('counters').findOneAndUpdate(
        { _id:'purchaseDraftNo' },
        { $inc:{ currentNumber:1 }, $set:{ updatedAt:new Date() } },
        { returnDocument:'after' }
      );
      const no = counter.value?.currentNumber || counter.currentNumber || Date.now();
      const doc = {
        purchaseDraftNo:Number(no),
        supplierName:String(body.supplierName||'').trim(),
        supplierNumber:String(body.supplierNumber||body.accountNumber||'').trim(),
        supplierGuid:String(body.supplierGuid||body.accountGuid||'').trim(),
        supplierMobile:normalizeMobile(body.supplierMobile||''),
        description:String(body.description||'').trim(),
        items,
        totalAmount:items.reduce((s,x)=>s+Number(x.quantity||0)*Number(x.price||0),0),
        status:'draft',
        createdBy:user?.username||'system',
        createdByName:user?.fullName||user?.username||'system',
        createdAt:new Date(),
        updatedAt:new Date()
      };
      await db.collection('purchaseDrafts').insertOne(doc);
      await logAction('purchase_draft_create', { purchaseDraftNo:doc.purchaseDraftNo, createdBy:doc.createdBy, supplierName:doc.supplierName, supplierNumber:doc.supplierNumber, totalAmount:doc.totalAmount, items:items.length });
      return sendJson(res, 200, { ok:true, draft:doc });
    }



    const purchaseDraftPrintMatch = pathname.match(/^\/print\/purchase-draft\/(\d+)$/);
    if (purchaseDraftPrintMatch && req.method === 'GET') {
      const sess = currentUser(req);
      if (!sess) return redirect(res, '/login');
      const db = await connectMongo();
      const no = Number(purchaseDraftPrintMatch[1]);
      const filter = { purchaseDraftNo:no };
      if (!['admin','accounting','warehouse','purchase'].includes(sess.role)) filter.createdBy = sess.username;
      const draft = await db.collection('purchaseDrafts').findOne(filter);
      if (!draft) return sendText(res, 404, '<h3>پیش‌نویس خرید پیدا نشد یا دسترسی ندارید</h3>', 'text/html; charset=utf-8');
      return sendText(res, 200, purchaseDraftPrintHtml(draft), 'text/html; charset=utf-8');
    }

    const purchaseInvoicePrintMatch = pathname.match(/^\/print\/purchase-invoice\/(\d+)$/);
    if (purchaseInvoicePrintMatch && req.method === 'GET') {
      const sess = currentUser(req);
      if (!sess) return redirect(res, '/login');
      const no = Number(purchaseInvoicePrintMatch[1]);
      const r = await shaygan.getInvoice(no, 3);
      const inv = (r.list || [])[0];
      if (!r.ok || !inv) return sendText(res, 404, '<h3>فاکتور خرید شایگان پیدا نشد</h3>', 'text/html; charset=utf-8');
      return sendText(res, 200, purchaseInvoicePrintHtml(inv), 'text/html; charset=utf-8');
    }

    const purchaseIssuePreviewMatch = pathname.match(/^\/api\/purchase-drafts\/(\d+)\/issue-preview$/);
    if (purchaseIssuePreviewMatch && req.method === 'GET') {
      if (!canUsePurchase(req, res)) return;
      const user = currentUser(req);
      const db = await connectMongo();
      const purchaseDraftNo = Number(purchaseIssuePreviewMatch[1]);
      const filter = { purchaseDraftNo };
      if (!['admin','accounting','warehouse','purchase'].includes(user.role)) filter.createdBy = user.username;
      const draft = await db.collection('purchaseDrafts').findOne(filter);
      if (!draft) return sendJson(res, 404, { ok:false, error:'پیش‌نویس خرید پیدا نشد یا دسترسی ندارید' });
      if (String(draft.status || 'draft') === 'issued') return sendJson(res, 400, { ok:false, error:'این پیش‌نویس قبلاً در شایگان ثبت شده است', draft });
      const last = await shaygan.getLastPurchaseInvoiceNumber();
      if (!last.ok) return sendJson(res, 400, { ok:false, error:last.error || 'خواندن آخرین شماره فاکتور خرید از شایگان ناموفق بود', last });
      const active = await db.collection('invoiceReservations').find({ invType:3, status:'reserved', expiresAt:{ $gt:new Date() } }).sort({ invoiceNumber:-1 }).limit(1).toArray();
      const reservedMax = active.length ? Number(active[0].invoiceNumber||0) : 0;
      const suggested = Math.max(Number(last.last||0), reservedMax) + 1;
      return sendJson(res, 200, { ok:true, purchaseDraftNo, draft, lastPurchaseInvoiceNumber:Number(last.last||0), reservedMax, suggestedInvoiceNumber:suggested, invTyp:3, source:last });
    }

    const purchaseIssueMatch = pathname.match(/^\/api\/purchase-drafts\/(\d+)\/issue$/);
    if (purchaseIssueMatch && req.method === 'POST') {
      if (!canUsePurchase(req, res)) return;
      const user = currentUser(req);
      const db = await connectMongo();
      const purchaseDraftNo = Number(purchaseIssueMatch[1]);
      const filter = { purchaseDraftNo };
      if (!['admin','accounting','warehouse','purchase'].includes(user.role)) filter.createdBy = user.username;
      const draft = await db.collection('purchaseDrafts').findOne(filter);
      if (!draft) return sendJson(res, 404, { ok:false, error:'پیش‌نویس خرید پیدا نشد یا دسترسی ندارید' });
      const currentStatus = String(draft.status || 'draft');
      if (currentStatus === 'issued') return sendJson(res, 400, { ok:false, error:'این پیش‌نویس قبلاً در شایگان ثبت شده است', draft });
      if (currentStatus === 'issuing') return sendJson(res, 409, { ok:false, error:'ثبت این پیش‌نویس در شایگان در حال انجام است. از کلیک مجدد خودداری کن.', draft });
      if (currentStatus === 'pending_verify') return sendJson(res, 409, { ok:false, error:'این پیش‌نویس پاسخ ثبت گرفته ولی هنوز تأیید نشده است. از ثبت مجدد خودداری کن و شایگان را بررسی کن.', draft });
      if (!draft.supplierNumber) return sendJson(res, 400, { ok:false, error:'تأمین‌کننده شایگان برای این پیش‌نویس مشخص نیست' });
      const items = (draft.items || []).map(x => ({
        itemCode:String(x.itemCode||'').trim(),
        itemDescription:String(x.itemDescription||'').trim(),
        itemGuid:String(x.itemGuid||'').trim(),
        stockNumber:String(x.stockNumber||'').trim(),
        stockName:String(x.stockName||'').trim(),
        stockGuid:String(x.stockGuid||'').trim(),
        quantity:Number(x.quantity||0),
        price:Number(x.price||0)
      }));
      const bad = items.find(x => !x.itemCode || !x.stockNumber || !(x.quantity > 0) || x.price < 0);
      if (bad) return sendJson(res, 400, { ok:false, error:'همه ردیف‌های خرید باید کالا، انبار ورودی، تعداد و قیمت معتبر داشته باشند', badLine:bad });

      // Atomic issue lock: validation is done before setting issuing, so invalid drafts cannot get stuck.
      const lock = await db.collection('purchaseDrafts').findOneAndUpdate(
        { _id:draft._id, status:{ $nin:['issued','issuing','pending_verify'] } },
        { $set:{ status:'issuing', issueStartedAt:new Date(), issueStartedBy:user.username, updatedAt:new Date() } },
        { returnDocument:'after' }
      );
      if (!lock || !lock.value) return sendJson(res, 409, { ok:false, error:'این پیش‌نویس قبلاً وارد فرآیند ثبت شده است؛ صفحه را تازه‌سازی کن.' });
      draft.status = 'issuing';

      let invoiceNumber = 0;
      let rsv = null;
      try {
      const mapping = await getUserMapping(user.username).catch(()=>null);
      rsv = await reserveInvoiceNumber({ invType:3, username:user.username, userId:user.username, draftId:purchaseDraftNo });
      if (!rsv.ok || !rsv.reservation?.invoiceNumber) {
        await db.collection('purchaseDrafts').updateOne({ _id:draft._id }, { $set:{ status:'failed', lastIssueError:'رزرو شماره فاکتور خرید از شایگان ناموفق بود', lastIssueAt:new Date(), updatedAt:new Date() } });
        return sendJson(res, 400, { ok:false, error:'رزرو شماره فاکتور خرید از شایگان ناموفق بود', reservation:rsv });
      }
      invoiceNumber = Number(rsv.reservation.invoiceNumber);
      await logAction('purchase_invoice_reserve', { purchaseDraftNo, invoiceNumber, lastShaygan:rsv.lastShaygan, username:user.username });
      const r = await shaygan.putPurchaseInvoice({
        invoiceNumber,
        purchaseDraftNo,
        supplierName:draft.supplierName,
        supplierNumber:draft.supplierNumber,
        supplierGuid:draft.supplierGuid,
        description:draft.description,
        items,
        sAccountNumber: mapping?.employeeAccountNumber || '',
        username: user.fullName || user.username || 'CRM'
      });
      const result = r.result[0] || {};
      await db.collection('invoiceAuditLogs').insertOne({ type:'purchase_issue', purchaseDraftNo, invoiceNumber, request:{ supplierNumber:draft.supplierNumber, items }, response:r.raw, ok:r.ok, at:new Date(), username:user.username });
      if (!r.ok) {
        await db.collection('purchaseDrafts').updateOne({ _id:draft._id }, { $set:{ status:'failed', lastIssueError:r.error||'', lastIssueAt:new Date(), reservedPurchaseInvoiceNumber:invoiceNumber, updatedAt:new Date() } });
        await db.collection('invoiceReservations').updateOne({ invType:3, invoiceNumber }, { $set:{ status:'failed', error:r.error||'', failedAt:new Date() } });
        await logAction('purchase_invoice_issue_failed', { purchaseDraftNo, invoiceNumber, error:r.error||'', username:user.username });
        return sendJson(res, 400, { ok:false, error:r.error||'خطا در ثبت فاکتور خرید در شایگان', raw:r.raw, result, invoiceNumber });
      }
      const confirmedNo = Number(result.Number || invoiceNumber);
      const verify = await shaygan.getInvoice(confirmedNo, 3);
      const verified = !!(verify.ok && Array.isArray(verify.list) && verify.list.some(x => Number(x.InvTyp) === 3 && Number(x.InvNo) === confirmedNo));
      if (!verified) {
        await db.collection('purchaseDrafts').updateOne({ _id:draft._id }, { $set:{ status:'pending_verify', shayganInvoiceNumber:confirmedNo, shayganGuid:result.GuId||'', issueResponse:r.raw, verifyResponse:verify.raw||null, lastIssueError:'فاکتور خرید در شایگان پاسخ ثبت داد اما با Invoice/Get و InvTyp=3 تأیید نشد', updatedAt:new Date() } });
        await db.collection('invoiceReservations').updateOne({ invType:3, invoiceNumber }, { $set:{ status:'pending_verify', shayganGuid:result.GuId||'', updatedAt:new Date() } });
        await logAction('purchase_invoice_verify_failed', { purchaseDraftNo, invoiceNumber:confirmedNo, shayganGuid:result.GuId||'', username:user.username });
        return sendJson(res, 202, { ok:false, pendingVerify:true, error:'ثبت خرید پاسخ موفق داد، اما تأیید Invoice/Get با InvTyp=3 انجام نشد. از ثبت مجدد خودداری کن و شایگان را بررسی کن.', result, raw:r.raw, verify, purchaseDraftNo, shayganInvoiceNumber:confirmedNo, shayganGuid:result.GuId||'' });
      }
      await db.collection('purchaseDrafts').updateOne({ _id:draft._id }, { $set:{ status:'issued', shayganInvoiceNumber:confirmedNo, shayganGuid:result.GuId||'', issuedAt:new Date(), issuedBy:user.username, issueResponse:r.raw, verifyResponse:verify.raw||null, updatedAt:new Date() } });
      await db.collection('invoiceReservations').updateOne({ invType:3, invoiceNumber }, { $set:{ status:'used', shayganGuid:result.GuId||'', usedAt:new Date(), draftId:purchaseDraftNo } });
      await logAction('purchase_invoice_issue', { purchaseDraftNo, shayganInvoiceNumber:confirmedNo, shayganGuid:result.GuId||'', supplierName:draft.supplierName, supplierNumber:draft.supplierNumber, totalAmount:draft.totalAmount, username:user.username });
      return sendJson(res, 200, { ok:true, result, raw:r.raw, verify, purchaseDraftNo, shayganInvoiceNumber:confirmedNo, shayganGuid:result.GuId||'', lastShaygan:rsv.lastShaygan });
      } catch (e) {
        if (invoiceNumber) {
          await db.collection('invoiceReservations').updateOne({ invType:3, invoiceNumber }, { $set:{ status:'failed', error:e.message||String(e), failedAt:new Date(), draftId:purchaseDraftNo } }).catch(()=>{});
        }
        await markPurchaseIssueFailed(db, draft._id, e.message || e, { reservedPurchaseInvoiceNumber: invoiceNumber || undefined });
        await logAction('purchase_invoice_issue_exception', { purchaseDraftNo, invoiceNumber, error:e.message||String(e), username:user.username });
        return sendJson(res, 500, { ok:false, error:'خطای غیرمنتظره هنگام ثبت خرید در شایگان؛ سند به حالت خطای ثبت رفت و قفل آزاد شد.', detail:e.message||String(e), purchaseDraftNo, invoiceNumber });
      }
    }

    const purchaseDraftOne = pathname.match(/^\/api\/purchase-drafts\/(\d+)$/);
    if (purchaseDraftOne && req.method === 'GET') {
      if (!canUsePurchase(req, res)) return;
      const user = currentUser(req);
      const db = await connectMongo();
      const filter = { purchaseDraftNo:Number(purchaseDraftOne[1]) };
      if (!['admin','accounting','warehouse','purchase'].includes(user.role)) filter.createdBy = user.username;
      const draft = await db.collection('purchaseDrafts').findOne(filter);
      if (!draft) return sendJson(res, 404, { ok:false, error:'پیش‌نویس خرید پیدا نشد یا دسترسی ندارید' });
      return sendJson(res, 200, { ok:true, draft });
    }
    if (pathname === '/api/legacy/productName/search') { const body = req.method === 'POST' ? await collectBody(req) : {}; const q = query.q || body.q || body.search || body.name || body.term || body.text || ''; const r = await searchItems(q, 30, Number(query.pages || config.inventorySearchLivePages)); return sendJson(res, 200, { ok:r.ok, list:(r.list||[]).map(toProductNameRow), source:r.source, scannedPages:r.scannedPages||0, error:r.error||'' }); }
    if (pathname === '/api/legacy/stock/search') { const body = req.method === 'POST' ? await collectBody(req) : {}; const q = query.q || body.q || body.search || body.name || body.term || body.text || ''; const r = await searchInventoryRows(q, Number(query.limit || 1000), Number(query.pages || config.inventorySearchLivePages), { stockNumber: query.stockNumber || '' }); return sendJson(res, 200, { ok:r.ok, list:(r.list||[]).map(toOldStockRow), source:r.source, scannedPages:r.scannedPages||0, error:r.error||'' }); }
    if (pathname === '/api/legacy/cardex/search') { const body = await collectBody(req); const code = body.itemCode || body.ItemCode || query.itemCode; const stockNumber = body.stockNumber || body.STNumber || query.stockNumber || query.STNumber || ''; const r = await shaygan.getKardexByItemCode(code, stockNumber, { maxRows: Number(query.maxRows || config.kardexAdminQuickMaxRows), hardMaxRows: config.kardexAdminFullMaxRows }); return sendJson(res, 200, { ok: r.ok, item: r.item, rows: r.rows || [], meta: r.meta || {}, error: r.error || '' }); }
    if (pathname === '/admin/getUserInfo') return sendJson(res, 200, { userData: { id: 'dev', name: 'تست', role: 'admin' } });
    if (pathname === '/api/template-map') return sendJson(res, 200, getTemplateMap());
    return false;
  } catch (e) { return sendJson(res, 500, { ok: false, error: e.message, stack: process.env.NODE_ENV === 'production' ? undefined : e.stack }); }
}

function getTemplateMap() {
  const root = path.join(publicDir, 'legacy-src');
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('._') || name === '__MACOSX') continue;
      const p = path.join(dir, name); const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else if (/\.(vue|js)$/.test(name)) files.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  }
  walk(root);
  return { ok: true, count: files.length, files };
}


function printCss(){return `<style>body{font-family:tahoma,Arial;margin:24px;direction:rtl;color:#111}.head{display:flex;justify-content:space-between;border-bottom:2px solid #0b5ed7;padding-bottom:10px;margin-bottom:14px}.brand{font-size:22px;font-weight:bold;color:#0b5ed7}.meta{font-size:13px;line-height:1.9}.box{border:1px solid #ddd;border-radius:8px;padding:10px;margin:10px 0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ccc;padding:7px;text-align:right;font-size:12px}th{background:#eaf3ff;color:#0b3d91}.total{text-align:left;font-size:16px;font-weight:bold;margin-top:12px}.printbar{margin-bottom:16px}@media print{.printbar{display:none}body{margin:0}}</style>`}
async function htmlInvoice(inv){
  const h = inv || {}; const rows = Array.isArray(h.Body) ? h.Body : [];
  const storeName = await resolveStoreNameForInvoice(h);
  const grossTotal = rows.reduce((sum,x)=>sum+Number(x.Amount || (Number(x.Quan||0)*Number(x.Price||0)) || 0),0);
  const discount = Number(h.DiscAmount || h.DiscountAmount || 0);
  const netTotal = Math.max(0, grossTotal - discount);
  const tr = rows.map((x,i)=>{
    const serial = extractSerialText(x);
    const amount = Number(x.Amount || (Number(x.Quan||0)*Number(x.Price||0)) || 0);
    return `<tr><td class="c">${i+1}</td><td class="code">${esc(x.ItemNumber||'')}</td><td class="item"><b>${esc(x.ItemDescription||'')}</b>${serial?`<div class="serial">سریال: ${esc(serial)}</div>`:''}</td><td class="c qty">${esc(x.Quan||'')}</td><td class="num price">${Number(x.Price||0).toLocaleString('fa-IR')}</td><td class="num amount">${amount.toLocaleString('fa-IR')}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>چاپ فاکتور ${esc(h.InvNo||'')}</title><style>body{font-family:tahoma,Arial;margin:18px;direction:rtl;color:#111}.printbar{margin-bottom:10px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #0b5ed7;padding-bottom:8px;margin-bottom:10px}.brand{font-size:21px;font-weight:bold;color:#0b5ed7}.store{font-size:17px;font-weight:bold;margin-top:4px}.meta{font-size:12px;line-height:1.7}.box{border:1px solid #ddd;border-radius:7px;padding:8px;margin:8px 0;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed}th,td{border:1px solid #bbb;padding:4px 5px;text-align:right;font-size:10.5px;vertical-align:top}th{background:#eaf3ff;color:#0b3d91}.c{text-align:center}.num{text-align:left;direction:ltr}.code{width:88px;font-size:9.5px}.item{width:auto}.qty{width:48px}.price{width:86px}.amount{width:96px}.serial{font-size:9px;color:#333;margin-top:3px}.summary{margin-top:9px;margin-right:auto;width:280px;font-size:12px}.summary div{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:4px 0}.summary .net{font-weight:bold;font-size:14px;border-bottom:2px solid #333}@media print{.printbar{display:none}body{margin:0}th,td{font-size:9.5px;padding:3px 4px}.brand{font-size:19px}.store{font-size:15px}}</style></head><body><div class="printbar"><button onclick="print()">چاپ</button></div><div class="head"><div><div class="brand">مشهد کالا</div><div class="store">${esc(storeName)}</div><div>فاکتور فروش</div></div><div class="meta">شماره: ${esc(h.InvNo||'')}<br>تاریخ: ${esc(toJalaliDatePrint(h.InvDate||h.CreatedDate||''))}<br>صندوق: ${esc(h.AccountName||h.AccountNumber||'')}<br>نماینده: ${esc(h.SAccountNumber||'')}</div></div><div class="box">${esc(h.InvDescription||'')}</div><table><thead><tr><th class="c">ردیف</th><th class="code">کد کالا</th><th>نام کالا / سریال</th><th class="qty">تعداد</th><th class="price">قیمت واحد</th><th class="amount">مبلغ</th></tr></thead><tbody>${tr}</tbody></table><div class="summary"><div><span>جمع ردیف‌ها</span><b>${grossTotal.toLocaleString('fa-IR')} ریال</b></div><div><span>تخفیف</span><b>${discount.toLocaleString('fa-IR')} ریال</b></div><div class="net"><span>جمع کل</span><b>${netTotal.toLocaleString('fa-IR')} ریال</b></div></div></body></html>`;
}
function htmlProforma(doc){
  const rows = doc.items || []; const total = rows.reduce((s,x)=>s+Number(x.quantity||0)*Number(x.price||0),0);
  const tr = rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.itemCode||'')}</td><td>${esc(x.itemDescription||'')}</td><td>${esc(x.quantity||'')}</td><td>${Number(x.price||0).toLocaleString('fa-IR')}</td><td>${(Number(x.quantity||0)*Number(x.price||0)).toLocaleString('fa-IR')}</td></tr>`).join('');
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>چاپ پیش‌فاکتور ${esc(doc.proformaNo||'')}</title>${printCss()}</head><body><div class="printbar"><button onclick="print()">چاپ</button></div><div class="head"><div><div class="brand">مشهد کالا</div><div>پیش‌فاکتور</div></div><div class="meta">شماره: ${esc(doc.proformaNo||'')}<br>تاریخ: ${new Date(doc.createdAt||Date.now()).toLocaleDateString('fa-IR')}<br>خریدار: ${esc(doc.customerName||'')}<br>موبایل: ${esc(doc.mobile||'')}</div></div><table><thead><tr><th>ردیف</th><th>کد</th><th>کالا</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${tr}</tbody></table><div class="total">جمع کل: ${total.toLocaleString('fa-IR')} ریال</div></body></html>`;
}
async function handlePrint(req,res,pathname,query){
  try {
    if (!getSession(req)) return redirect(res,'/login');
    const inv = pathname.match(/^\/print\/invoice\/(\d+)$/);
    if(inv){ const r=await shaygan.getInvoice(inv[1], query.invType || 2); const doc=(r.list||[])[0]; if(!doc){res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});return res.end('فاکتور پیدا نشد')} res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await htmlInvoice(doc)); }
    const prof = pathname.match(/^\/print\/proforma\/(\d+)$/);
    if(prof){ const db=await connectMongo(); const doc=await db.collection('proformas').findOne({proformaNo:Number(prof[1])}); if(!doc){res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});return res.end('پیش‌فاکتور پیدا نشد')} res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(htmlProforma(doc)); }
    return false;
  } catch(e) {
    console.error('print error:', e);
    res.writeHead(500, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    return res.end(`<h2>خطا در چاپ</h2><pre>${esc(e.message || e)}</pre>`);
  }
}

async function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/print/')) { const printed = await handlePrint(req,res,pathname,{}); if (printed !== false) return; }
  if (pathname === '/logout') {
    clearSession(req, res);
    return redirect(res, '/login');
  }
  if (pathname === '/login' || pathname === '/login.html') {
    const filePath = path.join(publicDir, 'login.html');
    return fs.readFile(filePath, (err, data) => {
      if (err) return sendJson(res, 404, { ok:false, error:'login page not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      res.end(data);
    });
  }

  const isAsset = pathname.startsWith('/assets/') || pathname === '/favicon.ico';
  if (!isAsset && !getSession(req)) return redirect(res, '/login');

  let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(publicDir, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, { 'Content-Type': mime(filePath), 'Cache-Control': 'no-store, no-cache, must-revalidate' }); res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = extractQuery(req.url);
  if (pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/admin/')) {
    const handled = await handleApi(req, res, pathname, query);
    if (handled === false) sendJson(res, 404, { ok: false, error: 'API not found', pathname });
    return;
  }
  serveStatic(req, res, pathname);
});

ensureInit().finally(() => {
  startAutoInventorySyncWorker();
  server.listen(config.port, config.host, () => console.log(`mkcrm listening on http://${config.host}:${config.port} | login: ${(config.publicBaseUrl || `http://127.0.0.1:${config.port}`)}/login`));
});
