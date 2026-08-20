'use strict';

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

function normInvDate8(v='') {
  const x = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0,10).replace(/-/g,'');
  const d = x.replace(/[^0-9]/g,'').slice(0,8);
  return d.length === 8 ? d : '';
}
function originalIssueDate8(attempt = {}, formatDate8 = ()=>'') {
  const explicit = normInvDate8(attempt.requestSnapshot?.invDate || attempt.invDate || '');
  if (explicit) return explicit;
  const source = attempt.putStartedAt || attempt.putSentAt || attempt.requestTimestamp || attempt.createdAt;
  const date = source ? new Date(source) : new Date();
  return normInvDate8(formatDate8(date));
}
function invoiceBodyAmount(inv = {}) {
  return (Array.isArray(inv.Body) ? inv.Body : []).reduce((s,x)=>s + Number(x.Amount || (Number(x.Quan||0) * Number(x.Price||0)) || 0), 0);
}
function invoiceExpenseAmount(inv = {}) {
  const rows = Array.isArray(inv.Expense) ? inv.Expense
    : Array.isArray(inv.Expenses) ? inv.Expenses
      : Array.isArray(inv.InvoiceExpenses) ? inv.InvoiceExpenses
        : [];
  return rows.reduce((sum,row)=>sum + Number(row.InvExpRowAmount || row.Amount || 0),0);
}
function invoiceTotalAmount(inv = {}) {
  const declared = Number(inv.SourceTotalAmount || inv.TotalAmount || 0);
  return declared || (invoiceBodyAmount(inv) + invoiceExpenseAmount(inv));
}
function saleRequestAmount(body = {}) {
  const rows = Array.isArray(body.items) ? body.items : [];
  const gross = rows.reduce((s,x)=>s + Number(x.quantity || x.Quan || 0) * Number(x.price || x.Price || 0) - Number(x.discountAmount || x.LineDiscAmount || 0), 0);
  const extras = (Array.isArray(body.invoiceExtras) ? body.invoiceExtras : []).reduce((sum,x)=>sum + Math.max(0,Number(x.amount || x.InvExpRowAmount || 0)),0);
  return gross - Number(body.discountAmount || body.DiscAmount || 0) + extras;
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
function createdAtMs(inv = {}) {
  const raw = inv.CreatedDate || inv.CreateDate || inv.CreatedAt || inv.IssueDateTime || '';
  if (!raw) return 0;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}
function scoreIssuedInvoiceCandidate(inv = {}, body = {}, mapping = {}, putGuid = '', crmId = '', issuedAt = 0, formatDate8 = ()=>'') {
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
  const reqDate = normInvDate8(body.invDate || formatDate8(new Date()));
  const gotDate = normInvDate8(inv.InvDate || inv.InvoiceDate || '');
  if (reqDate && gotDate && reqDate === gotDate) { score += 400; reasons.push('date'); }
  const reqAmount = saleRequestAmount(body);
  const invAmount = invoiceTotalAmount(inv);
  if (reqAmount > 0 && invAmount > 0 && Math.abs(reqAmount - invAmount) <= 1) { score += 1200; reasons.push('amount'); }
  const desc = String(inv.InvDescription || inv.Description || '');
  if (crmId && desc.includes(String(crmId))) { score += 2500; reasons.push('crmId'); }
  const customerRefs = [body.customerName,body.mobile,body.nationalCode].map(x=>String(x||'').trim()).filter(x=>x.length>=3);
  if (customerRefs.length && customerRefs.some(value=>desc.includes(value))) { score += 500; reasons.push('customer-reference'); }
  const reqLines = saleRequestLines(body);
  const gotLines = Array.isArray(inv.Body) ? inv.Body : [];
  if (reqLines.length && reqLines.length === gotLines.length) { score += 300; reasons.push('line-count'); }
  let lineHits = 0;
  for (const r of reqLines) {
    if (gotLines.some(g => String(g.ItemNumber||'').trim() === r.itemCode && String(g.STNumber||'').trim() === r.stockNumber && Math.abs(Number(g.Quan||0)-r.quantity) < 0.0001 && (!r.price || Math.abs(Number(g.Price||0)-r.price) <= 1))) lineHits++;
  }
  if (reqLines.length && lineHits === reqLines.length) { score += 1500; reasons.push('lines-all'); }
  else if (lineHits > 0) { score += lineHits * 250; reasons.push(`lines-${lineHits}`); }
  const created = createdAtMs(inv);
  const issued = Number(issuedAt || 0);
  const createdDeltaMs = created && issued ? Math.abs(created-issued) : null;
  if (createdDeltaMs !== null && createdDeltaMs <= 5*60*1000) { score += 800; reasons.push('created-within-5m'); }
  else if (createdDeltaMs !== null && createdDeltaMs <= 30*60*1000) { score += 300; reasons.push('created-within-30m'); }
  if (String(inv.FirstIssuerUsername||'') && String(mapping.fullName||'') && String(inv.FirstIssuerUsername).includes(String(mapping.fullName))) { score += 150; reasons.push('issuer'); }
  return { score, reasons, invNo, invGuid, reqAmount, invAmount, lineCount:gotLines.length, createdDeltaMs };
}

function reliableCandidate(sc = {}, body = {}, putGuid = '') {
  if (String(putGuid || '').trim() && sc.reasons.includes('guid')) return true;
  const required = ['account','saccount','date','amount','lines-all'];
  if (!required.every(reason=>sc.reasons.includes(reason))) return false;
  if (sc.createdDeltaMs !== null && sc.createdDeltaMs > 30*60*1000) return false;
  const customerRefs = [body.customerName,body.mobile,body.nationalCode].map(x=>String(x||'').trim()).filter(x=>x.length>=3);
  return !customerRefs.length || sc.reasons.includes('customer-reference');
}

function failedResolution(out, extra = {}) {
  return { ...out, ok:false, method:'unresolved', code:'POST_PUT_RESOLVE_FAILED', error:'POST_PUT_RESOLVE_FAILED', ...extra };
}
function candidateAudit(candidates = []) {
  return candidates.slice(0,10).map(x=>({invoiceNumber:x.sc.invNo,invoiceGuid:x.sc.invGuid,score:x.sc.score,reasons:x.sc.reasons,lineCount:x.sc.lineCount,createdDeltaMs:x.sc.createdDeltaMs,reliable:Boolean(x.reliable)}));
}
function totalRecordsOf(response = {}) {
  const first = Array.isArray(response.result) ? response.result[0] : null;
  const values = [
    response.TotalRecords,response.totalRecords,
    response.raw?.TotalRecords,response.raw?.totalRecords,
    first?.TotalRecords,first?.totalRecords
  ];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

async function resolveIssuedInvoiceAfterPut({ issueResponse = {}, body = {}, mapping = {}, invoiceType = 2, crmId = '', shaygan, formatDate8, maxPages = 40, rowCount = 20, issuedAt = Date.now() } = {}) {
  const issuedMeta = extractIssuedInvoiceMeta(issueResponse);
  const putGuid = issuedMeta.invoiceGuid || String(issueResponse?.raw?.Result?.[0]?.GuId || issueResponse?.result?.[0]?.GuId || '').trim();
  const out = { ok:false, invoiceNumber:issuedMeta.invoiceNumber || 0, invoiceGuid:putGuid || issuedMeta.invoiceGuid || '', result:issuedMeta.result || {}, method:'put-response', attempts:[] };
  if (out.invoiceNumber > 0) { out.ok = true; return out; }
  const date = normInvDate8(body.invDate || formatDate8(new Date())) || formatDate8(new Date());
  const safeMaxPages = Math.max(1,Math.min(Number(maxPages||40),100));
  const safeRowCount = Math.max(1,Math.min(Number(rowCount||20),20));
  const candidates = [];
  const paging = { totalRecords:null, rowCount:safeRowCount, expectedPages:null, pagesRead:0, pagingMode:'fallback' };
  out.paging = paging;
  for (let page=0,rowStart=0;page<(paging.pagingMode==='total-records'?paging.expectedPages:safeMaxPages);page++,rowStart+=safeRowCount) {
    const r = await shaygan.getInvoicePageByDate(rowStart,invoiceType,date,date,safeRowCount);
    paging.pagesRead++;
    if (page===0) {
      const totalRecords = totalRecordsOf(r);
      if (totalRecords !== null) {
        paging.totalRecords = totalRecords;
        paging.expectedPages = Math.ceil(totalRecords/safeRowCount);
        paging.pagingMode = 'total-records';
      }
    }
    out.attempts.push({ method:'date-page', page, rowStart, ok:r.ok, count:(r.result||[]).length, error:r.error||'' });
    if (!r.ok) return failedResolution(out,{ failureStage:'date-search', candidateCount:candidates.length, candidates:candidateAudit(candidates) });
    const list = Array.isArray(r.result) ? r.result : [];
    for (const inv of list) {
      const sc = scoreIssuedInvoiceCandidate(inv,body,mapping,putGuid,crmId,issuedAt,formatDate8);
      if (sc.invNo > 0 && sc.score >= 1700) candidates.push({ inv, sc, reliable:reliableCandidate(sc,body,putGuid) });
    }
    if (paging.pagingMode==='total-records') {
      if (page+1>=paging.expectedPages) break;
    } else if (!list.length) break;
  }
  candidates.sort((a,b)=>b.sc.score-a.sc.score||Number(b.inv.InvNo||0)-Number(a.inv.InvNo||0));
  const exactGuidCandidates=putGuid?candidates.filter(candidate=>candidate.sc.reasons.includes('guid')&&candidate.reliable):[];
  const reliableCandidates=exactGuidCandidates.length?exactGuidCandidates:candidates.filter(candidate=>candidate.reliable);
  const best = reliableCandidates.length===1?reliableCandidates[0]:null;
  const auditedCandidates = candidateAudit(candidates);
  if (!best) return failedResolution(out,{ failureStage:reliableCandidates.length>1?'multiple-candidates':'candidate-search', candidateCount:reliableCandidates.length, discoveredCandidateCount:candidates.length, candidates:auditedCandidates });
  const bestNo = Number(best.inv.InvNo || best.inv.Number || 0);
  const verify = await shaygan.getInvoice(bestNo,invoiceType);
  const verifyAttempt = { method:'final-verification', invoiceNumber:bestNo, invoiceType, ok:verify.ok, count:(verify.list||[]).length, error:verify.error||'' };
  out.attempts.push(verifyAttempt);
  if (!verify.ok) return failedResolution(out,{ failureStage:'final-verification', candidateCount:candidates.length, candidates:auditedCandidates, bestCandidate:{ invoiceNumber:bestNo, score:best.sc.score, reasons:best.sc.reasons } });
  const verified = (verify.list||[]).find(x=>Number(x.InvTyp||x.InvoiceType||0)===Number(invoiceType)&&Number(x.InvNo||x.InvoiceNumber||x.Number||0)===bestNo);
  if (!verified) return failedResolution(out,{ failureStage:'final-verification', candidateCount:candidates.length, candidates:auditedCandidates, bestCandidate:{ invoiceNumber:bestNo, score:best.sc.score, reasons:best.sc.reasons } });
  const verifiedGuid = String(verified.GuId || verified.Guid || verified.InvGuId || verified.InvHeaderGuId || '').trim();
  verifyAttempt.responseInvoiceNumber = Number(verified.InvNo||verified.InvoiceNumber||verified.Number||0);
  verifyAttempt.responseInvoiceType = Number(verified.InvTyp||verified.InvoiceType||0);
  verifyAttempt.responseInvoiceGuid = verifiedGuid;
  if (putGuid && verifiedGuid && putGuid.toLowerCase()!==verifiedGuid.toLowerCase()) {
    return failedResolution(out,{ failureStage:'identity-verification', candidateCount:candidates.length, candidates:auditedCandidates, bestCandidate:{ invoiceNumber:bestNo, score:best.sc.score, reasons:best.sc.reasons } });
  }
  return { ...out, ok:true, invoiceNumber:bestNo, invoiceGuid:verifiedGuid||putGuid, result:{...verified,Number:bestNo,GuId:verifiedGuid||putGuid}, method:'date-search-verified', matchScore:best.sc.score, matchReasons:best.sc.reasons, candidateCount:candidates.length, candidates:auditedCandidates };
}

module.exports = { extractIssuedInvoiceMeta, saleRequestAmount, invoiceExpenseAmount, invoiceTotalAmount, originalIssueDate8, scoreIssuedInvoiceCandidate, reliableCandidate, resolveIssuedInvoiceAfterPut, totalRecordsOf };
