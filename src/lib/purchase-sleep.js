'use strict';

const shaygan = require('./shaygan');
const VERSION = '0.9.19.59-supplier-sleep-operational-control';

function clean(v){ return String(v == null ? '' : v).trim(); }
function faToEn(v){ const m={'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9','٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'}; return String(v==null?'':v).replace(/[۰-۹٠-٩]/g,ch=>m[ch]||ch); }
function normDigits(v){ return faToEn(v).replace(/[^0-9]/g,'').replace(/^0+/,''); }
function num(v, d=0){ const n = Number(String(v ?? '').replace(/[,،\s]/g,'')); return Number.isFinite(n) ? n : d; }
function pct(a,b){ return b ? Math.round((Number(a||0)*10000)/Number(b||1))/100 : 0; }
function jobProgress(opts, phase, current, total, message){ opts?.jobControl?.progress?.({ phase, current, total, message }); }
function jobCheckpoint(opts){ opts?.jobControl?.heartbeat?.(); opts?.jobControl?.checkCancellation?.(); }
function snapshotId(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `PS-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2,8)}`; }
function parseDateScore(v){ const s=clean(v).replace(/[^0-9]/g,''); return Number(s.slice(0,8) || 0); }
function ageDays(dateStr){ const s=clean(dateStr).replace(/[^0-9]/g,''); if(s.length < 8) return null; // Shaygan may be Jalali; use rough age by numeric year only for sorting-safe management view.
  const y=Number(s.slice(0,4)), m=Number(s.slice(4,6)), d=Number(s.slice(6,8));
  // If Gregorian-like use Date, if Jalali-like estimate with 365-day year from current Jalali-ish 1405 not exact.
  if(y > 1900){ const dt=new Date(y,m-1,d); return Math.max(0, Math.floor((Date.now()-dt.getTime())/86400000)); }
  const now=new Date(); const gy=now.getFullYear(); const jyApprox=gy-621; return Math.max(0, (jyApprox-y)*365 + (now.getMonth()+1-m)*30 + (now.getDate()-d));
}
function gregorianToJalali(gy, gm, gd){
  // Gregorian to Jalali conversion, no external dependency. gm is 1-based.
  const g_d_m=[0,31,59,90,120,151,181,212,243,273,304,334];
  let jy=(gy<=1600)?0:979; gy-=(gy<=1600)?621:1600;
  const gy2=(gm>2)?(gy+1):gy;
  let days=(365*gy)+Math.floor((gy2+3)/4)-Math.floor((gy2+99)/100)+Math.floor((gy2+399)/400)-80+gd+g_d_m[gm-1];
  jy+=33*Math.floor(days/12053); days%=12053;
  jy+=4*Math.floor(days/1461); days%=1461;
  if(days>365){ jy+=Math.floor((days-1)/365); days=(days-1)%365; }
  const jm=(days<186)?1+Math.floor(days/31):7+Math.floor((days-186)/30);
  const jd=1+((days<186)?(days%31):((days-186)%30));
  return { jy, jm, jd };
}
function formatJalaliDateTime(v){
  const d=v ? new Date(v) : new Date(); if(Number.isNaN(d.getTime())) return '';
  const j=gregorianToJalali(d.getFullYear(), d.getMonth()+1, d.getDate()); const pad=n=>String(n).padStart(2,'0');
  return `${j.jy}/${pad(j.jm)}/${pad(j.jd)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function snapshotLabelFromDoc(x={}){
  const sup=clean(x.selectedSupplier?.accountName || x.supplierName || x.selectedSupplierName || x.selectedSupplier?.accountNumber || 'تأمین‌کننده');
  const date=formatJalaliDateTime(x.createdAt || x.finishedAt || new Date());
  return `${sup} - ${date}`;
}
function lineItemCode(x){ return clean(x.ItemCode || x.ItemNumber || x.Code || x.itemCode || x.itemNumber); }
function lineItemName(x){ return clean(x.ItemDescription || x.ItemDesc || x.ItemName || x.Description || x.itemDescription || x.name); }
function lineQty(x){ return num(x.Quan ?? x.Quantity ?? x.Qty ?? x.Quantity1 ?? x.MainUnitQuantity ?? x.itemQty, 0); }
function lineUnitCost(x){ const q=lineQty(x); const amount=lineAmount(x); return num(x.Price ?? x.UnitPrice ?? x.Fee ?? x.UnitCost ?? (q ? amount/q : 0), 0); }
function lineAmount(x){ return num(x.Amount ?? x.TotalAmount ?? x.LineAmount ?? x.PriceTotal ?? x.NetAmount ?? 0, 0); }
function knownMainGroupName(code){
  const c=clean(code);
  const map={ '1':'Notebook / نوت‌بوک', '01':'Notebook / نوت‌بوک' };
  return map[c] || (c ? `گروه اصلی ${c}` : 'نامشخص');
}
function deriveMainGroupFromRaw(raw={}, itemCode=''){
  const r=raw.raw || raw || {};
  let code=clean(r.ItemMainGroupCode || r.MainGroupCode || r.ProductMainGroupCode || r.ItemMainGroupNumber || r.MainGroupNumber || r.mainGroupCode || r.mainGroupNumber || '');
  let name=clean(r.ItemMainGroupName || r.MainGroupName || r.ProductMainGroupName || r.mainGroupName || '');
  // Fallback: in Mashhad Kala coding convention, the first digit is a practical main-group key (e.g. 1 = Notebook).
  if(!code){ const m=clean(itemCode || r.ItemCode || r.itemCode || '').match(/^\d+/); if(m) code=m[0].slice(0,1); }
  if(!name) name=knownMainGroupName(code);
  return { code, name, label: code ? `${code} - ${name}` : 'نامشخص' };
}
function lineMainGroupCode(x){ return deriveMainGroupFromRaw(x, lineItemCode(x)).code; }
function lineMainGroupName(x){ return deriveMainGroupFromRaw(x, lineItemCode(x)).name; }
function lineGroup(x){ const g=deriveMainGroupFromRaw(x, lineItemCode(x)); return g.label; }
function invNo(inv){ return Number(inv.InvNo || inv.InvoiceNumber || inv.Number || 0); }
function invDate(inv){ return clean(inv.InvDate || inv.InvoiceDate || inv.Date || ''); }
function invSupplierNo(inv){ return clean(inv.AccountNumber || inv.SupplierAccountNumber || inv.AccNo || inv.accountNumber || ''); }
function invSupplierName(inv){ return clean(inv.AccountName || inv.SupplierName || inv.AccName || inv.accountName || ''); }
function invBody(inv){ return Array.isArray(inv.Body) ? inv.Body : (Array.isArray(inv.Items) ? inv.Items : []); }
function invTotal(inv){ const body=invBody(inv); const sum=body.reduce((s,x)=>s+lineAmount(x),0); return num(inv.SourceTotalAmount ?? inv.TotalAmount ?? inv.Amount ?? sum, sum); }
function invGuid(inv){ return clean(inv.GuId || inv.Guid || inv.InvGuId || ''); }
function invDoc(inv){
  const body = invBody(inv);
  return {
    invNo: invNo(inv), invTyp: Number(inv.InvTyp || inv.InvoiceType || 3), invDate: invDate(inv),
    supplierAccountNo: invSupplierNo(inv), supplierName: invSupplierName(inv), guId: invGuid(inv),
    totalAmount: invTotal(inv), rowCount: body.length,
    items: body.map((x,i)=>({ row:i+1, itemCode:lineItemCode(x), itemName:lineItemName(x), mainGroupCode:lineMainGroupCode(x), mainGroupName:lineMainGroupName(x), mainGroup:lineGroup(x), qty:lineQty(x), unitCost:lineUnitCost(x), lineAmount:lineAmount(x), raw:x })).filter(x=>x.itemCode && x.qty>0)
  };
}

async function hydrateInvoiceIfHeaderOnly(invHeader, invType=3){
  const headerDoc = invDoc(invHeader || {});
  if(headerDoc.items.length) return { doc:headerDoc, fetchedDetail:false, error:'' };
  const no = headerDoc.invNo || invNo(invHeader);
  if(!no) return { doc:headerDoc, fetchedDetail:false, error:'invoice-number-missing' };
  const detail = await shaygan.getInvoice(no, invType).catch(e=>({ ok:false, error:String(e.message||e), list:[] }));
  if(detail.ok && Array.isArray(detail.list) && detail.list.length){
    return { doc:invDoc(detail.list[0]), fetchedDetail:true, error:'' };
  }
  return { doc:headerDoc, fetchedDetail:true, error:detail.error || 'invoice-detail-empty-or-failed' };
}

function inventoryUnitValue(inv){
  return num(inv.currentQty,0) ? num(inv.currentValue,0) / num(inv.currentQty,1) : 0;
}
function makeUnknownAllocationLayer({ snapshotId, code, inv, remainingQty, reason, now }){
  const qty = num(remainingQty,0);
  const unit = inventoryUnitValue(inv || {});
  const g = deriveMainGroupFromRaw({}, code);
  return {
    snapshotId,
    layerId:`PL-${snapshotId}-${reason}-${code}`,
    persistentLayerId:`PL-${reason}-${code}`,
    snapshotLayerId:`PLS-${snapshotId}-${reason}-${code}`,
    itemCode:code,
    itemName:inv?.itemName || '',
    mainGroupCode:g.code || '', mainGroupName:g.name || 'نامشخص', mainGroup:g.label || 'نامشخص', mainGroupSource:'unknown-allocation-fallback',
    supplierAccountNo:`__${reason}__`, supplierName: reason === 'SCAN_LIMIT_OR_OPENING' ? 'مانده نامشخص / قبل سال / محدودیت اسکن' : 'منشأ نامشخص',
    purchaseInvoiceNo:'', purchaseDate:'', purchaseQty:qty, unitCost:unit, purchaseValue:qty*unit,
    allocatedRemainingQty:qty, allocatedRemainingValue:qty*unit, ageDays:null,
    allocationMethod:'UNALLOCATED_CURRENT_STOCK_NOT_ASSIGNED_TO_SELECTED_SUPPLIER', status:'unknown_not_selected_supplier', syncedAt:now
  };
}

function saleLineAmount(x){
  return num(x.Amount ?? x.TotalAmount ?? x.LineAmount ?? x.PriceTotal ?? x.NetAmount ?? x.SaleAmount ?? x.TotalPrice ?? 0, 0);
}
function saleLineUnitPrice(x){
  const q=lineQty(x); const amount=saleLineAmount(x);
  return num(x.Price ?? x.UnitPrice ?? x.SalePrice ?? x.Fee ?? (q ? amount/q : 0), 0);
}
async function readSaleRowsForItems(db, itemCodes=[], opts={}){
  const target=[...new Set((itemCodes||[]).map(clean).filter(Boolean))];
  const targetSet=new Set(target);
  if(!target.length) return { ok:true, list:[], pages:0, scannedInvoices:0, source:'sale-invoice-no-target-items' };
  const dateFrom=clean(opts.saleDateFrom || opts.dateFrom || '14050101');
  const dateTo=clean(opts.saleDateTo || opts.dateTo || '');
  const maxPages=Math.max(1, Math.min(Number(opts.maxSalePages || opts.saleMaxPages || 600), 3000));
  const maxDetailInvoices=Math.max(0, Math.min(Number(opts.maxSaleDetailInvoices || opts.saleDetailMax || maxPages*20), 60000));
  const pageSize=20;
  const list=[]; const errors=[]; const seenSales=new Set(); let scannedInvoices=0; let detailFetched=0; let headersWithBody=0; let saleBodyRowsParsed=0; const diagnostics={ emptyBodyInvoices:0, targetHitInvoices:0, targetHitRows:0, noTargetRowsAfterBody:0, detailErrors:[] };
  for(let page=0,rowStart=0; page<maxPages; page++, rowStart+=pageSize){
    const r=await shaygan.getInvoicePageByDate(rowStart, 2, dateFrom, dateTo, pageSize).catch(e=>({ok:false,error:String(e.message||e),result:[]}));
    if(!r.ok){ errors.push({page,rowStart,error:r.error||'sale invoice get failed'}); break; }
    const rows=Array.isArray(r.result)?r.result:[];
    if(!rows.length) break;
    scannedInvoices+=rows.length;
    for(const invHeader of rows){
      const no=invNo(invHeader); if(!no) continue;
      let inv=invHeader; let body=invBody(invHeader); const headerGuid=invGuid(invHeader);
      if(body.length) headersWithBody++;
      // Invoice/Get pages may return header-only rows. Profit matching needs the invoice Body,
      // so fetch detail by invoice number when Body is absent. This is controlled by maxSaleDetailInvoices.
      if(!body.length && detailFetched < maxDetailInvoices){
        let detail=await shaygan.getInvoice(no, 2).catch(e=>({ok:false,error:String(e.message||e),list:[]}));
        detailFetched++;
        if((!detail.ok || !Array.isArray(detail.list) || !detail.list.length || !invBody(detail.list[0]).length) && headerGuid && typeof shaygan.getInvoiceByGuid === 'function'){
          const byGuid=await shaygan.getInvoiceByGuid(headerGuid, 2).catch(e=>({ok:false,error:String(e.message||e),list:[]}));
          if(byGuid.ok && Array.isArray(byGuid.list) && byGuid.list.length) detail=byGuid;
        }
        if(detail.ok && Array.isArray(detail.list) && detail.list.length){
          inv=detail.list[0]; body=invBody(inv);
        } else if(detail.error) {
          errors.push({ invoiceNo:no, error:detail.error, stage:'sale-detail-get' });
        }
      }
      const dt=invDate(inv) || invDate(invHeader);
      if(!body.length) diagnostics.emptyBodyInvoices++;
      let hitInThisInvoice=0; saleBodyRowsParsed += body.length;
      for(let i=0;i<body.length;i++){
        const x=body[i]; const code=lineItemCode(x); if(!targetSet.has(code)) continue;
        const qty=lineQty(x); if(qty<=0) continue;
        const amount=saleLineAmount(x); const unit=saleLineUnitPrice(x) || (amount&&qty?amount/qty:0);
        const key=`${no}::${i+1}::${code}::${qty}`;
        if(seenSales.has(key)) continue;
        seenSales.add(key);
        list.push({ saleInvoiceNo:no, saleDate:dt, itemCode:code, itemName:lineItemName(x), qty, unitSale:unit, saleValue: amount || qty*unit, row:i+1 }); hitInThisInvoice++; diagnostics.targetHitRows++;
      }
      if(hitInThisInvoice>0) diagnostics.targetHitInvoices++; else if(body.length) diagnostics.noTargetRowsAfterBody++;
    }
    if(rows.length<pageSize) break;
  }
  list.sort((a,b)=>parseDateScore(a.saleDate)-parseDateScore(b.saleDate)||Number(a.saleInvoiceNo)-Number(b.saleInvoiceNo)||Number(a.row||0)-Number(b.row||0));
  const byItem={}; for(const r of list){ byItem[r.itemCode]=(byItem[r.itemCode]||0)+num(r.qty,0); }
  const saleDiagnostic={ dateFrom,dateTo,targetItemCount:target.length, saleRows:list.length, scannedInvoices, detailFetched, headersWithBody, saleBodyRowsParsed, diagnostics, byItem:Object.entries(byItem).slice(0,80).map(([itemCode,qty])=>({itemCode,qty})) };
  await db.collection('supplierSleepDiagnostics').insertOne({ type:'supplier-profit-sale-read-v3-diagnostic', at:new Date(), ...saleDiagnostic, errors:errors.slice(0,30) }).catch(()=>{});
  return { ok:errors.length===0 || list.length>0, list, pages:Math.ceil(scannedInvoices/pageSize), scannedInvoices, detailFetched, headersWithBody, saleBodyRowsParsed, diagnostics, byItem:saleDiagnostic.byItem, errors, source:'sale-invoice-get-date-detail-body-filtered-by-selected-items-diagnostic' };
}
function allocateProfitToSupplierLayers(globalLayers=[], saleRows=[], selectedSupplierRef={}){
  const byItem=new Map();
  for(const l of globalLayers||[]){
    const code=clean(l.itemCode); if(!code) continue;
    if(!byItem.has(code)) byItem.set(code,[]);
    byItem.get(code).push({ ...l, remainingForSale:num(l.purchaseQty,0) });
  }
  for(const arr of byItem.values()) arr.sort((a,b)=>parseDateScore(a.purchaseDate)-parseDateScore(b.purchaseDate)||Number(a.purchaseInvoiceNo)-Number(b.purchaseInvoiceNo)||Number(a.row||0)-Number(b.row||0));
  const layerProfit=new Map(), invoiceProfit=new Map(), groupProfit=new Map();
  const allocations=[]; const unmatched=[]; const diagnostic={ saleRows:0, saleQty:0, itemsWithPurchaseLayers:0, itemsWithoutPurchaseLayers:0, skippedFuturePurchaseLayers:0, selectedLayerHits:0, nonSelectedLayerHits:0, selectedSupplierRef, unmatchedReasons:{} };
  for(const sale of saleRows||[]){
    diagnostic.saleRows++; diagnostic.saleQty+=num(sale.qty,0);
    let need=num(sale.qty,0); const unitSale=num(sale.unitSale || (sale.saleValue&&sale.qty?sale.saleValue/sale.qty:0),0);
    const arr=byItem.get(clean(sale.itemCode))||[]; if(arr.length) diagnostic.itemsWithPurchaseLayers++; else diagnostic.itemsWithoutPurchaseLayers++;
    for(const l of arr){
      if(need<=0) break;
      if(num(l.remainingForSale,0)<=0) continue;
      // Do not consume a purchase layer that happens after the sale date.
      if(parseDateScore(l.purchaseDate) && parseDateScore(sale.saleDate) && parseDateScore(l.purchaseDate)>parseDateScore(sale.saleDate)){ diagnostic.skippedFuturePurchaseLayers++; continue; }
      const qty=Math.min(need, num(l.remainingForSale,0)); if(qty<=0) continue;
      l.remainingForSale-=qty; need-=qty;
      const saleValue=qty*unitSale; const cost=qty*num(l.unitCost,0); const profit=saleValue-cost;
      const isSelected=sameSupplier({supplierAccountNo:l.supplierAccountNo,supplierName:l.supplierName}, selectedSupplierRef);
      if(isSelected){ diagnostic.selectedLayerHits += qty;
        const layerId=l.layerId||l.persistentLayerId||makeStableLayerId(l.supplierAccountNo,l.purchaseInvoiceNo,l.row,l.itemCode);
        const base={ saleQty:0, saleValue:0, fifoCost:0, fifoProfit:0, allocationCount:0 };
        const lp=layerProfit.get(layerId)||{...base, layerId, itemCode:l.itemCode, purchaseInvoiceNo:l.purchaseInvoiceNo};
        lp.saleQty+=qty; lp.saleValue+=saleValue; lp.fifoCost+=cost; lp.fifoProfit+=profit; lp.allocationCount+=1; layerProfit.set(layerId,lp);
        const ik=String(l.purchaseInvoiceNo||''); const ip=invoiceProfit.get(ik)||{...base, purchaseInvoiceNo:l.purchaseInvoiceNo};
        ip.saleQty+=qty; ip.saleValue+=saleValue; ip.fifoCost+=cost; ip.fifoProfit+=profit; ip.allocationCount+=1; invoiceProfit.set(ik,ip);
        const gk=clean(l.mainGroupCode||'__UNKNOWN__'); const gp=groupProfit.get(gk)||{...base, mainGroupCode:gk, mainGroup:l.mainGroup||'نامشخص'};
        gp.saleQty+=qty; gp.saleValue+=saleValue; gp.fifoCost+=cost; gp.fifoProfit+=profit; gp.allocationCount+=1; groupProfit.set(gk,gp);
        allocations.push({ layerId, purchaseInvoiceNo:l.purchaseInvoiceNo, purchaseDate:l.purchaseDate, supplierAccountNo:l.supplierAccountNo, supplierName:l.supplierName, itemCode:l.itemCode, itemName:l.itemName, mainGroupCode:l.mainGroupCode||'', mainGroup:l.mainGroup||'', saleInvoiceNo:sale.saleInvoiceNo, saleDate:sale.saleDate, qty, saleValue:Math.round(saleValue), fifoCost:Math.round(cost), fifoProfit:Math.round(profit), unitSale, unitCost:num(l.unitCost,0) });
      } else { diagnostic.nonSelectedLayerHits += qty; }
    }
    if(need>0.0001){ const reason=arr.length?'opening-stock-or-purchase-before-range-or-scan-limit':'no-purchase-layer-for-sale-item'; diagnostic.unmatchedReasons[reason]=(diagnostic.unmatchedReasons[reason]||0)+1; unmatched.push({ itemCode:sale.itemCode, saleInvoiceNo:sale.saleInvoiceNo, saleDate:sale.saleDate, unmatchedQty:need, reason }); }
  }
  const roundObj=o=>({ ...o, saleQty:num(o.saleQty,0), saleValue:Math.round(num(o.saleValue,0)), fifoCost:Math.round(num(o.fifoCost,0)), fifoProfit:Math.round(num(o.fifoProfit,0)), roiOnCostPercent:num(o.fifoCost,0)?Math.round(num(o.fifoProfit,0)*10000/num(o.fifoCost,1))/100:null, profitPercentOfSale:num(o.saleValue,0)?Math.round(num(o.fifoProfit,0)*10000/num(o.saleValue,1))/100:null });
  diagnostic.allocationRows=allocations.length; diagnostic.unmatchedRows=unmatched.length;
  return { ok:true, layerProfit:new Map([...layerProfit].map(([k,v])=>[k,roundObj(v)])), invoiceProfit:new Map([...invoiceProfit].map(([k,v])=>[k,roundObj(v)])), groupProfit:new Map([...groupProfit].map(([k,v])=>[k,roundObj(v)])), allocations, unmatched, diagnostic, saleRowCount:(saleRows||[]).length, source:'sales-invoice-fifo-to-purchase-layerid-management-profit-diagnostic-v3' };
}
function makeStableLayerId(supplierAccountNo, invNoValue, row, itemCode){
  const sup = clean(supplierAccountNo || 'SUP').replace(/[^0-9A-Za-zآ-ی_-]/g,'') || 'SUP';
  const inv = clean(invNoValue || '0').replace(/[^0-9A-Za-z_-]/g,'') || '0';
  const rr = String(row || 0).padStart(3,'0');
  const item = clean(itemCode || 'ITEM').replace(/[^0-9A-Za-z._-]/g,'') || 'ITEM';
  return `PL-${sup}-${inv}-${rr}-${item}`;
}
async function ensureIndexes(db){
  const names=['supplierPurchaseInvoices','supplierPurchaseLayers','supplierInventoryAllocation','supplierSleepSummary','supplierSleepSnapshots','supplierSleepDiagnostics','supplierSleepInvoiceSummary','supplierSleepGroupSummary'];
  const existing=new Set((await db.listCollections().toArray()).map(x=>x.name));
  for(const n of names) if(!existing.has(n)) await db.createCollection(n).catch(()=>{});
  await db.collection('supplierPurchaseInvoices').createIndex({ invNo:1 }, { unique:true });
  await db.collection('supplierPurchaseInvoices').createIndex({ invDate:1, supplierAccountNo:1 });
  await db.collection('supplierPurchaseLayers').createIndex({ snapshotId:1, itemCode:1 });
  await db.collection('supplierPurchaseLayers').createIndex({ snapshotId:1, supplierAccountNo:1, remainingValue:-1 });
  await db.collection('supplierSleepSummary').createIndex({ snapshotId:1, supplierAccountNo:1 }, { unique:true });
  await db.collection('supplierSleepSnapshots').createIndex({ snapshotId:1 }, { unique:true });
  await db.collection('supplierSleepDiagnostics').createIndex({ at:-1 });
  await db.collection('supplierSleepInvoiceSummary').createIndex({ snapshotId:1, supplierAccountNo:1, purchaseInvoiceNo:1 });
  await db.collection('supplierSleepGroupSummary').createIndex({ snapshotId:1, supplierAccountNo:1, mainGroup:1 });
}
async function getActiveWarehouses(db){ const doc=await db.collection('settings').findOne({ key:'inventory.activeWarehouseNumbers' }).catch(()=>null); return (Array.isArray(doc?.value)?doc.value:[]).map(x=>clean(x)).filter(Boolean); }
async function readPurchaseInvoicesDescending(db, opts={}){
  await ensureIndexes(db);
  const dateFrom=clean(opts.dateFrom || '14050101');
  const dateTo=clean(opts.dateTo || '');
  const maxInvoices=Math.max(1, Number(opts.maxInvoices || 500));
  const maxScanNumbers=Math.max(maxInvoices, Number(opts.maxScanNumbers || opts.maxPages*20 || 2000));
  const last = await shaygan.getLastPurchaseInvoiceNumber().catch(e=>({ ok:false, error:String(e.message||e), last:0 }));
  const lastNo = Number(last.last || last.lastInvoiceNumber || last.invoiceNumber || 0);
  if(!last.ok || !lastNo) return { ok:false, count:0, list:[], errors:[{ error:last.error || 'last purchase invoice failed' }], source:'descending-last-invoice-failed' };
  const list=[]; const errors=[]; let scanned=0;
  for(let no=lastNo; no>0 && scanned<maxScanNumbers && list.length<maxInvoices; no--, scanned++){
    const r=await shaygan.getInvoice(no,3).catch(e=>({ ok:false, error:String(e.message||e), list:[] }));
    if(!r.ok){ errors.push({ invNo:no, error:r.error||'getInvoice failed' }); continue; }
    const inv = Array.isArray(r.list) && r.list[0] ? r.list[0] : null;
    if(!inv) continue;
    const h = await hydrateInvoiceIfHeaderOnly(inv, 3);
    const doc=h.doc;
    if(!doc.invNo || !doc.items.length) { if(h.error && errors.length<80) errors.push({ invNo:no, stage:'purchase-detail-hydration', error:h.error }); continue; }
    const ds=parseDateScore(doc.invDate);
    if(dateTo && ds>parseDateScore(dateTo)) continue;
    if(dateFrom && ds<parseDateScore(dateFrom)) {
      // Since we scan descending, once enough older invoices appear we can stop safely.
      if(list.length>0) break;
      continue;
    }
    list.push(doc);
    await db.collection('supplierPurchaseInvoices').updateOne({ invNo:doc.invNo }, { $set:{ ...doc, source:'shaygan-invoice-get-descending-by-last-no', syncedAt:new Date() } }, { upsert:true });
  }
  return { ok: errors.length===0 || list.length>0, dateFrom, dateTo, scannedNumbers:scanned, count:list.length, list, errors, source:'invoice-get-invtyp-3-descending-last-number' };
}
async function readPurchaseInvoicesByDateRange(db, opts={}){
  await ensureIndexes(db);
  const dateFrom=clean(opts.dateFrom || '14050101');
  const dateTo=clean(opts.dateTo || '');
  const pageSize=Math.max(1, Math.min(Number(opts.pageSize || 20), 20));
  const maxPages=Math.max(1, Math.min(Number(opts.maxPages || 300), 5000));
  const maxInvoices=Math.max(0, Number(opts.maxInvoices || 0));
  const list=[]; const errors=[]; let scannedPages=0;
  for(let page=0,rowStart=0; page<maxPages; page++, rowStart+=pageSize){
    const r=await shaygan.getInvoicePageByDate(rowStart, 3, dateFrom, dateTo, pageSize).catch(e=>({ ok:false, error:String(e.message||e), result:[] }));
    scannedPages++;
    if(!r.ok){ errors.push({ page, rowStart, error:r.error||'' }); break; }
    const rows=r.result || [];
    if(!rows.length) break;
    for(const inv of rows){
      const h = await hydrateInvoiceIfHeaderOnly(inv, 3);
      const doc = h.doc;
      if(!doc.invNo) continue;
      if(!doc.items.length){
        if(errors.length < 80) errors.push({ invNo:doc.invNo, stage:'purchase-detail-hydration', error:h.error || 'purchase invoice body missing' });
        continue;
      }
      list.push({ ...doc, detailFetched:!!h.fetchedDetail });
      await db.collection('supplierPurchaseInvoices').updateOne({ invNo:doc.invNo }, { $set:{ ...doc, detailFetched:!!h.fetchedDetail, source:h.fetchedDetail?'shaygan-invoice-get-date-range-detail-hydrated':'shaygan-invoice-get-date-range', syncedAt:new Date() } }, { upsert:true });
      if(maxInvoices && list.length>=maxInvoices) break;
    }
    if(maxInvoices && list.length>=maxInvoices) break;
    if(rows.length < pageSize) break;
  }
  // Experience from Tablo: date-range Invoice/Get may return 0 in some Shaygan builds. Fallback to tested descending invoice-number path.
  if(!list.length){
    const fb=await readPurchaseInvoicesDescending(db, { dateFrom, dateTo, maxInvoices:maxInvoices||500, maxPages, maxScanNumbers:Number(opts.maxScanNumbers||maxPages*20||6000) });
    return { ...fb, dateRangeAttempt:{ scannedPages, count:0, errors }, fallbackUsed:true };
  }
  return { ok: errors.length===0, dateFrom, dateTo, scannedPages, count:list.length, list, errors, source:'invoice-get-invtyp-3-date-range-paged', fallbackUsed:false };
}
async function getSupplierIndex(db, opts={}){
  await ensureIndexes(db);
  const dateFrom=clean(opts.dateFrom || '14050101'); const dateTo=clean(opts.dateTo || '');
  const sync=opts.sync ? await readPurchaseInvoicesByDateRange(db, opts) : null;
  const q={ invDate: dateTo ? { $gte:dateFrom, $lte:dateTo } : { $gte:dateFrom } };
  const invs=await db.collection('supplierPurchaseInvoices').find(q).sort({ invDate:-1, invNo:-1 }).toArray();
  const map=new Map();
  for(const inv of invs){
    const k=inv.supplierAccountNo || inv.supplierName || '__UNKNOWN_SUP__';
    const x=map.get(k)||{ supplierAccountNo:inv.supplierAccountNo||'', supplierName:inv.supplierName||'تأمین‌کننده نامشخص', invoiceCount:0, periodPurchaseValue:0, itemRows:0, skuSet:new Set(), invoices:[] };
    x.invoiceCount++; x.periodPurchaseValue+=num(inv.totalAmount,0); x.itemRows+=Number(inv.rowCount||0); (inv.items||[]).forEach(it=>{ if(it.itemCode) x.skuSet.add(it.itemCode); });
    x.invoices.push({ invNo:inv.invNo, invDate:inv.invDate, totalAmount:inv.totalAmount, rowCount:inv.rowCount, guId:inv.guId });
    map.set(k,x);
  }
  const list=[...map.values()].map(x=>({ ...x, skuCount:x.skuSet.size, skuSet:undefined, invoices:x.invoices.slice(0,200) })).sort((a,b)=>b.periodPurchaseValue-a.periodPurchaseValue);
  return { ok:true, dateFrom, dateTo, sync, supplierCount:list.length, invoiceCount:invs.length, list };
}
async function getSupplierInvoices(db, opts={}){
  await ensureIndexes(db);
  const dateFrom=clean(opts.dateFrom || '14050101'); const dateTo=clean(opts.dateTo || ''); const supplierAccountNo=clean(opts.supplierAccountNo||'');
  const q={ invDate: dateTo ? { $gte:dateFrom, $lte:dateTo } : { $gte:dateFrom } };
  if(supplierAccountNo) q.supplierAccountNo=supplierAccountNo;
  const list=await db.collection('supplierPurchaseInvoices').find(q).sort({ invDate:-1, invNo:-1 }).limit(Math.min(Number(opts.limit||500),2000)).toArray();
  return { ok:true, list:list.map(inv=>({ invNo:inv.invNo, invDate:inv.invDate, supplierAccountNo:inv.supplierAccountNo, supplierName:inv.supplierName, totalAmount:inv.totalAmount, rowCount:inv.rowCount, items:inv.items||[] })) };
}

async function loadMainGroupMap(db, itemCodes=[]){
  const codes=[...new Set((itemCodes||[]).map(clean).filter(Boolean))];
  const map=new Map();
  if(!codes.length) return map;
  async function scan(col){
    const docs=await db.collection(col).find({ itemCode:{ $in:codes } }).limit(50000).toArray().catch(()=>[]);
    for(const d of docs){
      const code=clean(d.itemCode || d.ItemCode); if(!code || map.has(code)) continue;
      const g=deriveMainGroupFromRaw(d, code);
      if(g.code) map.set(code, { mainGroupCode:g.code, mainGroupName:g.name, mainGroup:g.label, source:col });
    }
  }
  // Best source first: inventory snapshot raw normally contains ItemMainGroupCode/Name.
  await scan('itemInventoryCatalog');
  await scan('itemCatalogAll');
  await scan('itemCatalog');
  for(const c of codes){ if(!map.has(c)){ const g=deriveMainGroupFromRaw({}, c); map.set(c, { mainGroupCode:g.code, mainGroupName:g.name, mainGroup:g.label, source:'item-code-prefix-fallback' }); } }
  return map;
}
function applyMainGroupsToLayers(layers=[], groupMap=new Map()){
  for(const l of layers){
    const g=groupMap.get(clean(l.itemCode)) || deriveMainGroupFromRaw({}, l.itemCode);
    l.mainGroupCode = l.mainGroupCode || g.mainGroupCode || g.code || '';
    l.mainGroupName = l.mainGroupName || g.mainGroupName || g.name || knownMainGroupName(l.mainGroupCode);
    l.mainGroup = l.mainGroup || g.mainGroup || (l.mainGroupCode ? `${l.mainGroupCode} - ${l.mainGroupName}` : 'نامشخص');
    l.mainGroupSource = l.mainGroupSource || g.source || 'fallback';
  }
  return layers;
}

function inventoryRow(doc){
  const q=num(doc.quantity ?? doc.qty ?? doc.RemainQ ?? doc.Quantity1 ?? doc.remainQty, 0);
  const cost=num(doc.remainCost ?? doc.RemainCost ?? doc.totalCost ?? doc.cost ?? 0, 0);
  const unit= q ? cost/q : num(doc.averageCost ?? doc.unitCost ?? doc.RemainUnit1Price ?? 0,0);
  return { itemCode:clean(doc.itemCode || doc.ItemCode), itemName:clean(doc.itemDescription || doc.ItemDescription || doc.itemName), stockNumber:clean(doc.stockNumber || doc.StoreNumber || doc.STNumber), qty:q, value:cost || q*unit, unitCost:unit };
}
async function buildPurchaseLayerSnapshot(db, opts={}){
  await ensureIndexes(db);
  const sid=snapshotId(); const now=new Date();
  const dateFrom=clean(opts.dateFrom || '14050101'); const dateTo=clean(opts.dateTo || '');
  const activeWarehouses=await getActiveWarehouses(db); const activeSet=activeWarehouses.length ? new Set(activeWarehouses) : null;
  const maxPages=Number(opts.maxPages || 300); const pageSize=Number(opts.pageSize || 20);
  const sync = await readPurchaseInvoicesByDateRange(db, { dateFrom, dateTo, maxPages, pageSize, maxInvoices:Number(opts.maxInvoices||0) });
  const invs = await db.collection('supplierPurchaseInvoices').find({ invDate: dateTo ? { $gte:dateFrom, $lte:dateTo } : { $gte:dateFrom } }).sort({ invDate:1, invNo:1 }).toArray();
  const purchaseLayers=[];
  for(const inv of invs){
    for(const it of inv.items || []){
      const qty=num(it.qty,0); if(!it.itemCode || qty<=0) continue;
      const unit=num(it.unitCost || (it.lineAmount && qty ? it.lineAmount/qty : 0),0);
      purchaseLayers.push({
        snapshotId:sid, layerId:`PL-${sid}-${inv.invNo}-${it.row}-${it.itemCode}`,
        itemCode:it.itemCode, itemName:it.itemName, mainGroupCode:it.mainGroupCode||'', mainGroupName:it.mainGroupName||'', mainGroup:it.mainGroup || '',
        supplierAccountNo:inv.supplierAccountNo || '', supplierName:inv.supplierName || 'تأمین‌کننده نامشخص',
        purchaseInvoiceNo:inv.invNo, purchaseDate:inv.invDate, purchaseQty:qty, unitCost:unit,
        purchaseValue:num(it.lineAmount || qty*unit, qty*unit), allocatedRemainingQty:0, allocatedRemainingValue:0,
        ageDays:ageDays(inv.invDate), allocationMethod:'REVERSE_FIFO_PURCHASE_INVOICES', status:'unallocated', syncedAt:now
      });
    }
  }
  applyMainGroupsToLayers(purchaseLayers, await loadMainGroupMap(db, purchaseLayers.map(x=>x.itemCode)));
  const invQuery={ quantity:{ $gt:0 } }; if(activeSet) invQuery.stockNumber={ $in:[...activeSet] };
  const invDocs=await db.collection('itemInventoryCatalog').find(invQuery).limit(Number(opts.maxInventoryRows||0)||0).toArray();
  const itemInv=new Map();
  for(const d of invDocs){ const r=inventoryRow(d); if(!r.itemCode || r.qty<=0) continue; const cur=itemInv.get(r.itemCode)||{ itemCode:r.itemCode,itemName:r.itemName,currentQty:0,currentValue:0,warehouses:new Set() }; cur.currentQty+=r.qty; cur.currentValue+=r.value; if(r.stockNumber)cur.warehouses.add(r.stockNumber); itemInv.set(r.itemCode,cur); }
  const byItem=new Map(); for(const l of purchaseLayers){ if(!byItem.has(l.itemCode)) byItem.set(l.itemCode,[]); byItem.get(l.itemCode).push(l); }
  for(const arr of byItem.values()) arr.sort((a,b)=>parseDateScore(b.purchaseDate)-parseDateScore(a.purchaseDate) || Number(b.purchaseInvoiceNo)-Number(a.purchaseInvoiceNo));
  const allocations=[]; const writtenLayers=[];
  for(const [code, inv] of itemInv.entries()){
    let remaining=inv.currentQty; const layers=byItem.get(code)||[];
    for(const l of layers){ if(remaining<=0) break; const alloc=Math.min(remaining, l.purchaseQty); if(alloc<=0) continue; const value=alloc*num(l.unitCost,0); const out={ ...l, allocatedRemainingQty:alloc, allocatedRemainingValue:value, status:'allocated' }; writtenLayers.push(out); remaining-=alloc; }
    const allocatedQty=inv.currentQty-remaining; const allocatedValue=writtenLayers.filter(x=>x.itemCode===code).reduce((s,x)=>s+num(x.allocatedRemainingValue,0),0);
    if(remaining>0){ const unit=inv.currentQty ? inv.currentValue/inv.currentQty : 0; writtenLayers.push({ snapshotId:sid, layerId:`PL-${sid}-OPENING-${code}`, itemCode:code, itemName:inv.itemName, mainGroupCode:'', mainGroupName:'نامشخص', mainGroup:'نامشخص', supplierAccountNo:'__OPENING__', supplierName:'مانده قبل سال / منشأ نامشخص', purchaseInvoiceNo:'', purchaseDate:'', purchaseQty:remaining, unitCost:unit, purchaseValue:remaining*unit, allocatedRemainingQty:remaining, allocatedRemainingValue:remaining*unit, ageDays:null, allocationMethod:'UNALLOCATED_TO_CURRENT_YEAR_PURCHASE', status:'opening_or_unknown', syncedAt:now }); }
    allocations.push({ snapshotId:sid, itemCode:code, itemName:inv.itemName, currentQty:inv.currentQty, currentValue:inv.currentValue, allocatedToPurchasesQty:allocatedQty, allocatedToPurchasesValue:allocatedValue, unknownQty:remaining, unknownValue:remaining*(inv.currentQty?inv.currentValue/inv.currentQty:0), warehouses:[...inv.warehouses], allocationMethod:'REVERSE_FIFO_PURCHASE_LAYERS', createdAt:now });
  }
  await db.collection('supplierPurchaseLayers').deleteMany({ snapshotId:sid });
  if(writtenLayers.length) await db.collection('supplierPurchaseLayers').insertMany(writtenLayers, { ordered:false });
  await db.collection('supplierInventoryAllocation').deleteMany({ snapshotId:sid });
  if(allocations.length) await db.collection('supplierInventoryAllocation').insertMany(allocations, { ordered:false });
  const purchaseBySupplier=new Map(); for(const l of purchaseLayers){ const k=l.supplierAccountNo||'__UNKNOWN_SUP__'; const x=purchaseBySupplier.get(k)||{ supplierAccountNo:k, supplierName:l.supplierName, periodPurchaseValue:0, periodPurchaseQty:0 }; x.periodPurchaseValue+=num(l.purchaseValue,0); x.periodPurchaseQty+=num(l.purchaseQty,0); purchaseBySupplier.set(k,x); }
  const summaries=new Map(); const totalActiveInventoryValue=allocations.reduce((s,x)=>s+num(x.currentValue,0),0);
  for(const l of writtenLayers){ const k=l.supplierAccountNo||'__UNKNOWN_SUP__'; const base=purchaseBySupplier.get(k)||{ supplierAccountNo:k, supplierName:l.supplierName, periodPurchaseValue:0, periodPurchaseQty:0 }; const x=summaries.get(k)||{ snapshotId:sid, supplierAccountNo:k, supplierName:base.supplierName||l.supplierName, periodPurchaseValue:base.periodPurchaseValue||0, periodPurchaseQty:base.periodPurchaseQty||0, remainingValue:0, remainingQty:0, itemCodes:new Set(), layerCount:0, ageValueSum:0, ageWeight:0, mainGroups:{} }; x.remainingValue+=num(l.allocatedRemainingValue,0); x.remainingQty+=num(l.allocatedRemainingQty,0); x.itemCodes.add(l.itemCode); x.layerCount++; if(l.ageDays!=null){ const av=num(l.allocatedRemainingValue,0); x.ageValueSum+=num(l.ageDays,0)*av; x.ageWeight+=av; if(num(l.ageDays,0)>30) x.staleOver30Value=(x.staleOver30Value||0)+av; if(num(l.ageDays,0)>60) x.staleOver60Value=(x.staleOver60Value||0)+av; } if(l.mainGroup) x.mainGroups[l.mainGroup]=(x.mainGroups[l.mainGroup]||0)+num(l.allocatedRemainingValue,0); summaries.set(k,x); }
  const summaryRows=[...summaries.values()].map(x=>({ snapshotId:sid, supplierAccountNo:x.supplierAccountNo, supplierName:x.supplierName, periodPurchaseValue:x.periodPurchaseValue, periodPurchaseQty:x.periodPurchaseQty, remainingValue:x.remainingValue, remainingQty:x.remainingQty, shareOfTotalInventoryPercent:pct(x.remainingValue,totalActiveInventoryValue), averageAgeDays:x.ageWeight?Math.round(x.ageValueSum/x.ageWeight):null, itemCount:x.itemCodes.size, layerCount:x.layerCount, mainGroups:x.mainGroups, staleOver30Value:x.staleOver30Value||0, staleOver60Value:x.staleOver60Value||0, staleOver30Percent:pct(x.staleOver30Value||0,x.remainingValue), staleOver60Percent:pct(x.staleOver60Value||0,x.remainingValue), profitStatus:'estimated_not_final', updatedAt:now })).sort((a,b)=>b.remainingValue-a.remainingValue);
  await db.collection('supplierSleepSummary').deleteMany({ snapshotId:sid });
  if(summaryRows.length) await db.collection('supplierSleepSummary').insertMany(summaryRows, { ordered:false });
  const snap={ snapshotId:sid, version:VERSION, status:'completed', mode:'purchase-layer-no-kardex', dateFrom, dateTo, activeWarehouses, createdAt:now, finishedAt:new Date(), purchaseInvoicesSynced:sync.count, purchaseInvoicePages:sync.scannedPages, purchaseLayerCount:purchaseLayers.length, allocatedLayerCount:writtenLayers.length, inventoryItemCount:allocations.length, totalActiveInventoryValue, totalAllocatedValue:summaryRows.filter(x=>x.supplierAccountNo!=='__OPENING__').reduce((s,x)=>s+num(x.remainingValue,0),0), totalUnknownValue:(summaryRows.find(x=>x.supplierAccountNo==='__OPENING__')||{}).remainingValue||0, errors:sync.errors||[] };
  await db.collection('supplierSleepSnapshots').insertOne(snap);
  return { ok:true, snapshot:snap, summary:summaryRows.slice(0,50), source:'purchase-invoice-layer-allocation' };
}

function sameSupplier(inv, sup={}){
  const a=clean(inv.supplierAccountNo||inv.AccountNumber||inv.accountNumber||'');
  const b=clean(sup.accountNumber||sup.supplierAccountNo||sup.supplierNumber||'');
  const ad=normDigits(a), bd=normDigits(b);
  const an=clean(inv.supplierName||inv.AccountName||inv.accountName||'').replace(/[\s‌]+/g,'');
  const bn=clean(sup.accountName||sup.supplierName||'').replace(/[\s‌]+/g,'');
  if(b && a && String(a)===String(b)) return true;
  if(bd && ad && ad===bd) return true;
  if(bn && an && (an===bn || an.includes(bn) || bn.includes(an))) return true;
  return false;
}
function rowText(r={}){
  return Object.values(r||{}).map(v => (v == null || typeof v === 'object') ? '' : String(v)).join(' | ');
}
function isPurchaseLikeStatementRow(r={}){
  const t=rowText(r).replace(/ي/g,'ی').replace(/ك/g,'ک');
  // Keep this permissive: final validation is getInvoice(no,3)+sameSupplier.
  return /خرید|فاکتور خرید|فاكتور خريد|خريد|خ\.ف|Invoice|Purchase/i.test(t);
}
function extractNumbers(v){
  const out=[]; const m=faToEn(v||'').match(/\d{1,10}/g);
  if(m) for(const x of m){
    const n=Number(x);
    if(!Number.isFinite(n) || n<=0) continue;
    // Dates like 14050101 and huge rial amounts should not be treated as invoice numbers.
    if(/^13\d{6}$|^14\d{6}$|^20\d{6}$/.test(String(x))) continue;
    if(n>=10000000) continue;
    out.push(n);
  }
  return out;
}
function extractInvoiceNoCandidatesFromStatementRow(r={}){
  const priorityKeys=['InvoiceNumber','InvNo','InvNumber','InvHeaderNo','DocNo','DocumentNo','RefNo','ReferenceNo','FishNo','No','Number','VoucherNo','SanadNo','Serial','DocNumber'];
  const descKeys=['Description','Desc','RowDesc','DocDesc','DocumentDesc','Comment','Memo','Explain','Description1','Subject','Operation','TypeName','Title'];
  const out=[];
  for(const k of priorityKeys){
    const v=r[k] ?? r[k.charAt(0).toLowerCase()+k.slice(1)];
    out.push(...extractNumbers(v));
  }
  // If row text indicates purchase, scan descriptive fields too; this catches Persian ledger descriptions.
  if(isPurchaseLikeStatementRow(r)){
    for(const k of descKeys){
      const v=r[k] ?? r[k.charAt(0).toLowerCase()+k.slice(1)];
      out.push(...extractNumbers(v));
    }
    // Conservative broad scan only after purchase-like signal. getInvoice(no,3) validates the candidate.
    out.push(...extractNumbers(rowText(r)));
  }
  return [...new Set(out)].sort((a,b)=>b-a);
}

async function scanPurchaseInvoicesForSupplierDescending(db, supplier, opts={}){
  const dateFrom=clean(opts.dateFrom||'14050101');
  const dateTo=clean(opts.dateTo||'');
  const maxInvoices=Math.max(1, Number(opts.maxInvoices||300));
  const maxScanNumbers=Math.max(maxInvoices, Number(opts.maxScanNumbers||6000));
  const last = await shaygan.getLastPurchaseInvoiceNumber().catch(e=>({ok:false,error:String(e.message||e),last:0}));
  const lastNo=Number(last.last||last.lastInvoiceNumber||last.invoiceNumber||0);
  const list=[]; const errors=[]; const checked=[]; let scanned=0;
  if(!last.ok || !lastNo) return { ok:false, source:'descending-supplier-scan-last-no-failed', count:0, list, errors:[{error:last.error||'last purchase invoice failed'}], scannedNumbers:0, checkedInvoices:[] };
  for(let no=lastNo; no>0 && scanned<maxScanNumbers && list.length<maxInvoices; no--, scanned++){
    if(scanned%10===0){ jobCheckpoint(opts); jobProgress(opts,'Reading Purchase Invoices',scanned,maxScanNumbers,'Scanning purchase invoices for the selected supplier'); }
    const gr=await shaygan.getInvoice(no,3).catch(e=>({ok:false,error:String(e.message||e),list:[]}));
    if(!gr.ok){ if(errors.length<30) errors.push({invNo:no,error:gr.error||'getInvoice failed'}); continue; }
    const inv=(gr.list||[])[0]; if(!inv) continue;
    const h = await hydrateInvoiceIfHeaderOnly(inv, 3);
    const doc=h.doc;
    if(!doc.invNo || !doc.items.length) { if(h.error && errors.length<30) errors.push({ invNo:no, stage:'purchase-detail-hydration', error:h.error }); continue; }
    const ds=parseDateScore(doc.invDate);
    const match=sameSupplier(doc, supplier);
    if(checked.length<80) checked.push({ invNo:doc.invNo, invDate:doc.invDate, supplierAccountNo:doc.supplierAccountNo, supplierName:doc.supplierName, totalAmount:doc.totalAmount, rowCount:doc.rowCount, match });
    if(dateTo && ds>parseDateScore(dateTo)) continue;
    if(dateFrom && ds<parseDateScore(dateFrom)) {
      // Do not break immediately. Invoice numbers are usually chronological, but previous tests showed gaps and non-strict ordering.
      continue;
    }
    if(!match) continue;
    list.push(doc);
    await db.collection('supplierPurchaseInvoices').updateOne({ invNo:doc.invNo }, { $set:{ ...doc, source:'supplier-descending-invoice-scan', selectedSupplier:supplier, syncedAt:new Date() } }, { upsert:true });
  }
  return { ok:true, source:'descending-supplier-scan-getInvoice-3', count:list.length, list, errors, scannedNumbers:scanned, lastNo, checkedInvoices:checked };
}

async function readPurchaseInvoicesForSupplier(db, opts={}){
  await ensureIndexes(db);
  jobCheckpoint(opts);
  const buildMode=opts.jobOperation==='build-selected-snapshot';
  jobProgress(opts,'Loading Suppliers',0,buildMode?5:2,'Loading selected supplier');
  const dateFrom=clean(opts.dateFrom||'14050101');
  const dateTo=clean(opts.dateTo||'');
  const supplier={ accountNumber:clean(opts.supplierAccountNo||opts.accountNumber||opts.supplierNumber||''), accountGuid:clean(opts.supplierGuid||opts.accountGuid||''), accountName:clean(opts.supplierName||opts.accountName||'') };
  if(!supplier.accountNumber && !supplier.accountGuid && !supplier.accountName) return { ok:false, error:'supplier is required', list:[], count:0 };

  const diagnostics={ version:VERSION, supplier, dateFrom, dateTo, stages:[] };

  const st=await shaygan.getAccountStatement(supplier.accountNumber, dateFrom, dateTo, supplier.accountGuid, supplier.accountName).catch(e=>({ok:false,error:String(e.message||e),rows:[],list:[]}));
  const rows=st.rows||st.list||[];
  diagnostics.stages.push({ stage:'account-statement', ok:!!st.ok, rowCount:rows.length, source:st.source||st.domainUsed||'', error:st.error||'', attempts:st.attempts||st.diagnostics||[] });
  diagnostics.statementSample=(rows||[]).slice(0,12).map((r,i)=>({ index:i+1, keys:Object.keys(r||{}).slice(0,30), text:rowText(r).slice(0,900), raw:r }));

  const candidates=[]; const rowDiagnostics=[];
  for(const r of rows){
    const c=extractInvoiceNoCandidatesFromStatementRow(r);
    if(c.length && rowDiagnostics.length<80) rowDiagnostics.push({ text:rowText(r).slice(0,700), candidates:c.slice(0,20), isPurchaseLike:isPurchaseLikeStatementRow(r) });
    for(const n of c) candidates.push(n);
  }
  const invoiceNos=[...new Set(candidates)].sort((a,b)=>b-a).slice(0, Number(opts.maxInvoices||300));
  jobProgress(opts,'Reading Purchase Invoices',0,invoiceNos.length||1,'Reading selected supplier purchase invoices');
  diagnostics.stages.push({ stage:'extract-invoice-numbers-from-statement', ok:invoiceNos.length>0, candidateCount:invoiceNos.length, firstCandidates:invoiceNos.slice(0,80), rowDiagnostics });

  const list=[]; const errors=[]; const validations=[];
  let invoiceIndex=0;
  for(const no of invoiceNos){
    invoiceIndex++;
    if(invoiceIndex===1||invoiceIndex%10===0){ jobCheckpoint(opts); jobProgress(opts,'Reading Purchase Invoices',invoiceIndex,invoiceNos.length||1,'Reading selected supplier purchase invoices'); }
    const gr=await shaygan.getInvoice(no,3).catch(e=>({ok:false,error:String(e.message||e),list:[]}));
    if(!gr.ok){ errors.push({invNo:no,error:gr.error||'getInvoice failed'}); continue; }
    const inv=(gr.list||[])[0];
    if(!inv){ if(validations.length<120) validations.push({invNo:no, found:false}); continue; }
    const h = await hydrateInvoiceIfHeaderOnly(inv, 3);
    const doc=h.doc;
    const ds=parseDateScore(doc.invDate);
    const match=sameSupplier(doc, supplier);
    if(validations.length<120) validations.push({ invNo:no, found:true, docInvNo:doc.invNo, invDate:doc.invDate, supplierAccountNo:doc.supplierAccountNo, supplierName:doc.supplierName, rowCount:doc.rowCount, totalAmount:doc.totalAmount, supplierMatch:match, detailFetched:!!h.fetchedDetail, detailError:h.error||'' });
    if(!doc.invNo || !doc.items.length) { if(h.error) errors.push({ invNo:no, stage:'purchase-detail-hydration', error:h.error }); continue; }
    if(!match) continue;
    if(dateFrom && ds<parseDateScore(dateFrom)) continue;
    if(dateTo && ds>parseDateScore(dateTo)) continue;
    list.push(doc);
    await db.collection('supplierPurchaseInvoices').updateOne({ invNo:doc.invNo }, { $set:{ ...doc, source:'supplier-account-statement-invoice-get', selectedSupplier:supplier, syncedAt:new Date() } }, { upsert:true });
  }
  diagnostics.stages.push({ stage:'validate-ledger-candidates-with-getInvoice-3', ok:list.length>0, validInvoiceCount:list.length, checked:validations, errors:errors.slice(0,50) });

  let finalList=list;
  let fallback=null;
  if(!finalList.length && opts.disableFallback !== true){
    fallback=await scanPurchaseInvoicesForSupplierDescending(db, supplier, { ...opts, dateFrom, dateTo, maxInvoices:Number(opts.maxInvoices||300), maxScanNumbers:Number(opts.maxScanNumbers||6000) });
    finalList=fallback.list||[];
    diagnostics.stages.push({ stage:'fallback-descending-invoice-scan', ok:finalList.length>0, source:fallback.source, lastNo:fallback.lastNo, scannedNumbers:fallback.scannedNumbers, count:fallback.count, checkedInvoices:fallback.checkedInvoices||[], errors:(fallback.errors||[]).slice(0,50) });
  }

  const result={ ok:true, source: finalList.length && list.length ? 'account-statement-exact-supplier-to-invoice-get' : (fallback?.source || 'account-statement-no-valid-invoice'), supplier, statementRows:rows.length, invoiceNoCandidates:invoiceNos.length, count:finalList.length, list:finalList, errors, statementMeta:{ source:st.source||st.domainUsed||'', attempts:st.attempts||st.diagnostics||[] }, fallbackUsed:!!fallback, diagnostics };
  jobCheckpoint(opts);
  await db.collection('supplierSleepDiagnostics').insertOne({ type:'selected-supplier-invoices', at:new Date(), supplier, dateFrom, dateTo, resultSummary:{ source:result.source, statementRows:result.statementRows, invoiceNoCandidates:result.invoiceNoCandidates, count:result.count, fallbackUsed:result.fallbackUsed }, diagnostics }).catch(()=>{});
  return result;
}

async function readGlobalPurchaseLayersForItems(db, itemCodes=[], itemInv=new Map(), opts={}){
  // True remaining allocation needs all purchase layers for the same item, across all suppliers.
  // This is a targeted descending scan: it only keeps invoice rows whose itemCode is in target itemCodes.
  const target=[...new Set((itemCodes||[]).map(clean).filter(Boolean))];
  const targetSet=new Set(target);
  const dateFrom=clean(opts.dateFrom||'14050101');
  const dateTo=clean(opts.dateTo||'');
  const maxScanNumbers=Math.max(100, Number(opts.globalAllocationMaxScanNumbers || opts.allSupplierMaxScanNumbers || opts.maxScanNumbers || 6000));
  const maxMatchedInvoices=Math.max(50, Number(opts.globalAllocationMaxInvoices || opts.allSupplierMaxInvoices || 2000));
  const collected=[]; const errors=[]; const matchedInvoices=[]; let scanned=0;
  const collectedQty=new Map(target.map(code=>[code,0]));
  const requiredQty=new Map(target.map(code=>[code, num(itemInv.get(code)?.currentQty,0)]));
  const enough=()=> target.every(code => num(requiredQty.get(code),0) <= 0 || num(collectedQty.get(code),0) >= num(requiredQty.get(code),0));
  if(!target.length) return { ok:true, layers:[], scannedNumbers:0, matchedInvoices:[], errors:[], source:'global-all-supplier-no-target-items' };
  const last = await shaygan.getLastPurchaseInvoiceNumber().catch(e=>({ok:false,error:String(e.message||e),last:0}));
  const lastNo=Number(last.last||last.lastInvoiceNumber||last.invoiceNumber||0);
  if(!last.ok || !lastNo) return { ok:false, layers:[], scannedNumbers:0, matchedInvoices:[], errors:[{error:last.error||'last purchase invoice failed'}], source:'global-all-supplier-last-no-failed' };
  for(let no=lastNo; no>0 && scanned<maxScanNumbers && matchedInvoices.length<maxMatchedInvoices; no--, scanned++){
    if(scanned%10===0){ jobCheckpoint(opts); jobProgress(opts,'Calculating Remaining Stock',scanned,maxScanNumbers,'Reading purchase layers for remaining stock'); }
    if(!opts.collectAllForProfit && enough() && matchedInvoices.length>0) break;
    const gr=await shaygan.getInvoice(no,3).catch(e=>({ok:false,error:String(e.message||e),list:[]}));
    if(!gr.ok){ if(errors.length<30) errors.push({ invNo:no, error:gr.error||'getInvoice failed' }); continue; }
    const inv=(gr.list||[])[0]; if(!inv) continue;
    const doc=invDoc(inv); if(!doc.invNo || !doc.items?.length) continue;
    const ds=parseDateScore(doc.invDate);
    if(dateTo && ds>parseDateScore(dateTo)) continue;
    if(dateFrom && ds<parseDateScore(dateFrom)) continue;
    const hitItems=(doc.items||[]).filter(it=>targetSet.has(clean(it.itemCode)) && num(it.qty,0)>0);
    if(!hitItems.length) continue;
    matchedInvoices.push({ invNo:doc.invNo, invDate:doc.invDate, supplierAccountNo:doc.supplierAccountNo, supplierName:doc.supplierName, hitRows:hitItems.length });
    await db.collection('supplierPurchaseInvoices').updateOne({ invNo:doc.invNo }, { $set:{ ...doc, source:'global-all-supplier-allocation-scan', syncedAt:new Date() } }, { upsert:true }).catch(()=>{});
    for(const it of hitItems){
      const qty=num(it.qty,0); const unit=num(it.unitCost || (it.lineAmount && qty ? it.lineAmount/qty : 0),0);
      collectedQty.set(it.itemCode, num(collectedQty.get(it.itemCode),0)+qty);
      collected.push({
        itemCode:it.itemCode, itemName:it.itemName, mainGroupCode:it.mainGroupCode||'', mainGroupName:it.mainGroupName||'', mainGroup:it.mainGroup||'',
        supplierAccountNo:doc.supplierAccountNo||'', supplierName:doc.supplierName||'تأمین‌کننده نامشخص',
        purchaseInvoiceNo:doc.invNo, purchaseDate:doc.invDate, purchaseQty:qty, unitCost:unit,
        purchaseValue:num(it.lineAmount||qty*unit, qty*unit), row:it.row,
        layerId:makeStableLayerId(doc.supplierAccountNo||'', doc.invNo, it.row, it.itemCode),
        persistentLayerId:makeStableLayerId(doc.supplierAccountNo||'', doc.invNo, it.row, it.itemCode),
        ageDays:ageDays(doc.invDate)
      });
    }
  }
  applyMainGroupsToLayers(collected, await loadMainGroupMap(db, collected.map(x=>x.itemCode)));
  collected.sort((a,b)=>parseDateScore(b.purchaseDate)-parseDateScore(a.purchaseDate)||Number(b.purchaseInvoiceNo)-Number(a.purchaseInvoiceNo)||Number(b.row||0)-Number(a.row||0));
  return { ok:true, layers:collected, scannedNumbers:scanned, matchedInvoices, errors, collectedQty:Object.fromEntries(collectedQty), requiredQty:Object.fromEntries(requiredQty), source: opts.collectAllForProfit ? 'global-all-supplier-targeted-full-scan-for-profit-roi' : 'global-all-supplier-targeted-reverse-fifo-scan' };
}

async function buildSelectedSupplierSnapshot(db, opts={}){
  await ensureIndexes(db);
  jobCheckpoint(opts);
  const sid=snapshotId(); const now=new Date();
  const dateFrom=clean(opts.dateFrom||'14050101'); const dateTo=clean(opts.dateTo||'');
  const supplier={ accountNumber:clean(opts.supplierAccountNo||opts.accountNumber||opts.supplierNumber||''), accountGuid:clean(opts.supplierGuid||opts.accountGuid||''), accountName:clean(opts.supplierName||opts.accountName||'') };
  const sync=await readPurchaseInvoicesForSupplier(db,{...opts,dateFrom,dateTo,maxInvoices:Number(opts.maxInvoices||300)});
  const invs=sync.list||[];
  jobProgress(opts,'Building Layers',0,invs.length||1,'Building purchase layers');
  const activeWarehouses=await getActiveWarehouses(db); const activeSet=activeWarehouses.length?new Set(activeWarehouses):null;
  const purchaseLayers=[];
  let builtInvoiceCount=0;
  for(const inv of invs){
    builtInvoiceCount++;
    if(builtInvoiceCount===1||builtInvoiceCount%10===0){ jobCheckpoint(opts); jobProgress(opts,'Building Layers',builtInvoiceCount,invs.length||1,'Building purchase layers'); }
    for(const it of inv.items||[]){
      const qty=num(it.qty,0); if(!it.itemCode||qty<=0) continue;
      const unit=num(it.unitCost || (it.lineAmount && qty ? it.lineAmount/qty : 0),0);
      const supLayerNo = inv.supplierAccountNo||supplier.accountNumber||'';
      const persistentLayerId = makeStableLayerId(supLayerNo, inv.invNo, it.row, it.itemCode);
      purchaseLayers.push({ snapshotId:sid, layerId:persistentLayerId, persistentLayerId, snapshotLayerId:`PLS-${sid}-${inv.invNo}-${it.row}-${it.itemCode}`, itemCode:it.itemCode, itemName:it.itemName, mainGroupCode:it.mainGroupCode||'', mainGroupName:it.mainGroupName||'', mainGroup:it.mainGroup||'', supplierAccountNo:supLayerNo, supplierName:inv.supplierName||supplier.accountName||'تأمین‌کننده انتخاب‌شده', purchaseInvoiceNo:inv.invNo, purchaseDate:inv.invDate, purchaseQty:qty, unitCost:unit, purchaseValue:num(it.lineAmount||qty*unit, qty*unit), allocatedRemainingQty:0, allocatedRemainingValue:0, ageDays:ageDays(inv.invDate), allocationMethod:'SELECTED_SUPPLIER_REVERSE_FIFO_PURCHASE_LAYERS', status:'unallocated', syncedAt:now });
    }
  }
  applyMainGroupsToLayers(purchaseLayers, await loadMainGroupMap(db, purchaseLayers.map(x=>x.itemCode)));
  const itemCodes=[...new Set(purchaseLayers.map(x=>x.itemCode))];
  jobCheckpoint(opts);
  jobProgress(opts,'Calculating Remaining Stock',0,itemCodes.length||1,'Calculating remaining stock');
  const invQuery={ quantity:{ $gt:0 } }; if(itemCodes.length) invQuery.itemCode={ $in:itemCodes }; if(activeSet) invQuery.stockNumber={ $in:[...activeSet] };
  const invDocs=await db.collection('itemInventoryCatalog').find(invQuery).limit(0).toArray();
  const itemInv=new Map();
  for(const d of invDocs){ const r=inventoryRow(d); if(!r.itemCode||r.qty<=0) continue; const cur=itemInv.get(r.itemCode)||{itemCode:r.itemCode,itemName:r.itemName,currentQty:0,currentValue:0,warehouses:new Set()}; cur.currentQty+=r.qty; cur.currentValue+=r.value; if(r.stockNumber) cur.warehouses.add(r.stockNumber); itemInv.set(r.itemCode,cur); }

  // 0.9.19.30: TRUE Reverse FIFO must allocate current stock across ALL suppliers' purchases for the same item.
  // Previous selected-supplier-only allocation incorrectly attributed remaining stock to an older supplier when the item was sold and later repurchased from another supplier.
  const globalAllocation = await readGlobalPurchaseLayersForItems(db, itemCodes, itemInv, { ...opts, dateFrom, dateTo, collectAllForProfit:false });
  const globalByItem=new Map();
  for(const l of globalAllocation.layers||[]){ if(!globalByItem.has(l.itemCode)) globalByItem.set(l.itemCode,[]); globalByItem.get(l.itemCode).push(l); }
  for(const arr of globalByItem.values()) arr.sort((a,b)=>parseDateScore(b.purchaseDate)-parseDateScore(a.purchaseDate)||Number(b.purchaseInvoiceNo)-Number(a.purchaseInvoiceNo)||Number(b.row||0)-Number(a.row||0));

  // 0.9.19.34: Supplier profit calculation is intentionally paused.
  // Sale data must first be built by the independent Sale Snapshot engine.
  // Pre-profit supplier sleep phases remain active: purchase invoices, reconciliation, LayerId,
  // true reverse FIFO remaining stock, invoice remaining and main-group report.
  const saleRead = { source:'disabled-use-sale-snapshot-engine', scannedInvoices:0, detailFetched:0, headersWithBody:0, saleBodyRowsParsed:0, list:[], errors:[] };
  const selectedSupplierRef={ accountNumber: sync.supplier?.accountNumber || supplier.accountNumber || '', accountName: sync.supplier?.accountName || supplier.accountName || '' };
  const profitAlloc = { source:'profit-paused-sale-snapshot-required', invoiceProfit:new Map(), groupProfit:new Map(), layerProfit:new Map(), allocations:[], unmatched:[], diagnostic:{ profitPaused:true, reason:'SALE_SNAPSHOT_ENGINE_NOT_YET_LINKED_TO_PROFIT' } };
  const profitDiagnostic={
    version:VERSION, selectedSupplierRef,
    targets:{ itemCodeCount:itemCodes.length, selectedPurchaseLayerCount:purchaseLayers.length },
    status:'PROFIT_PAUSED',
    note:'سود تأمین‌کننده در این نسخه عمداً متوقف شده است. ابتدا Sale Snapshot ساخته و تست می‌شود؛ محاسبه سود در فاز بعدی از Mongo saleInvoiceLines انجام خواهد شد.',
    saleSnapshotRequired:true,
    saleRead:{ source:saleRead.source, scannedInvoices:0, detailFetched:0, headersWithBody:0, saleBodyRowsParsed:0, saleRows:0, byItem:[], diagnostics:{ profitPaused:true }, errors:[] },
    globalAllocation:{ source:globalAllocation.source, scannedNumbers:globalAllocation.scannedNumbers||0, matchedInvoiceCount:(globalAllocation.matchedInvoices||[]).length, globalLayerCount:(globalAllocation.layers||[]).length, matchedInvoices:(globalAllocation.matchedInvoices||[]).slice(0,80), errors:(globalAllocation.errors||[]).slice(0,50), coverage:null },
    profitMatch:{ source:profitAlloc.source, allocations:0, unmatched:0, diagnostic:profitAlloc.diagnostic||{}, unmatchedSample:[], allocationSample:[] }
  };
  const selectedPurchaseByItem=new Map(); for(const l of purchaseLayers){ if(!selectedPurchaseByItem.has(l.itemCode)) selectedPurchaseByItem.set(l.itemCode,[]); selectedPurchaseByItem.get(l.itemCode).push(l); }
  const writtenLayers=[]; const allocations=[]; const unknownInventoryLayers=[];
  let totalUnallocatedCurrentQty=0, totalUnallocatedCurrentValue=0;
  let fullCoverageItemCount=0, partialCoverageItemCount=0, noCoverageItemCount=0;
  let processedItemCount=0;
  for(const code of itemCodes){
    processedItemCount++;
    if(processedItemCount===1||processedItemCount%25===0){ jobCheckpoint(opts); jobProgress(opts,'Calculating Remaining Stock',processedItemCount,itemCodes.length||1,'Calculating remaining stock'); }
    const inv=itemInv.get(code)||{itemCode:code,itemName:(selectedPurchaseByItem.get(code)||[])[0]?.itemName||'',currentQty:0,currentValue:0,warehouses:new Set()};
    let remainingCurrent=inv.currentQty;
    const allLayers=globalByItem.get(code)||[];
    let allocatedToAnySupplierQty=0, allocatedToAnySupplierValue=0, allocatedToSelectedSupplierQty=0, allocatedToSelectedSupplierValue=0;
    const selectedWrittenForCode=[];
    for(const l of allLayers){
      if(remainingCurrent<=0) break;
      const alloc=Math.min(remainingCurrent, num(l.purchaseQty,0));
      if(alloc<=0) continue;
      const value=alloc*num(l.unitCost,0);
      allocatedToAnySupplierQty+=alloc; allocatedToAnySupplierValue+=value;
      const isSelected=sameSupplier({ supplierAccountNo:l.supplierAccountNo, supplierName:l.supplierName }, selectedSupplierRef);
      if(isSelected){
        const lp=profitAlloc.layerProfit.get(l.layerId||l.persistentLayerId||makeStableLayerId(l.supplierAccountNo,l.purchaseInvoiceNo,l.row,l.itemCode))||{};
        const out={...l, snapshotId:sid, snapshotLayerId:`PLS-${sid}-${l.purchaseInvoiceNo}-${l.row||0}-${l.itemCode}`, allocatedRemainingQty:alloc, allocatedRemainingValue:value, soldQty:num(lp.saleQty,0), soldValue:num(lp.saleValue,0), fifoCost:num(lp.fifoCost,0), fifoProfit:num(lp.fifoProfit,0), roiOnCostPercent:lp.roiOnCostPercent??null, profitPercentOfSale:lp.profitPercentOfSale??null, profitStatus:lp.saleValue?'MANAGEMENT_FIFO_SALES_INVOICE':'NO_MATCHED_SALE_OR_UNSOLD', allocationMethod:'TRUE_REVERSE_FIFO_ALL_SUPPLIERS_THEN_FILTER_SELECTED', status:'allocated_selected_supplier_true_fifo', syncedAt:now };
        writtenLayers.push(out); selectedWrittenForCode.push(out);
        allocatedToSelectedSupplierQty+=alloc; allocatedToSelectedSupplierValue+=value;
      }
      remainingCurrent-=alloc;
    }
    const selectedLayers=selectedPurchaseByItem.get(code)||[];
    const unallocatedCurrentQty=Math.max(0, remainingCurrent);
    const unallocatedCurrentValue=unallocatedCurrentQty * inventoryUnitValue(inv);
    totalUnallocatedCurrentQty += unallocatedCurrentQty;
    totalUnallocatedCurrentValue += unallocatedCurrentValue;
    if(num(inv.currentQty,0)>0 && unallocatedCurrentQty<=0.0001) fullCoverageItemCount++;
    else if(num(inv.currentQty,0)>0 && allocatedToAnySupplierQty>0) partialCoverageItemCount++;
    else if(num(inv.currentQty,0)>0) noCoverageItemCount++;
    if(unallocatedCurrentQty>0.0001){
      unknownInventoryLayers.push(makeUnknownAllocationLayer({ snapshotId:sid, code, inv, remainingQty:unallocatedCurrentQty, reason:'SCAN_LIMIT_OR_OPENING', now }));
    }
    allocations.push({ snapshotId:sid, itemCode:code, itemName:inv.itemName, currentQty:inv.currentQty, currentValue:inv.currentValue,
      selectedSupplierPurchaseQty:selectedLayers.reduce((s,x)=>s+num(x.purchaseQty,0),0), selectedSupplierPurchaseValue:selectedLayers.reduce((s,x)=>s+num(x.purchaseValue,0),0),
      allocatedToSelectedSupplierQty, allocatedToSelectedSupplierValue, allocatedToAnySupplierQty, allocatedToAnySupplierValue,
      unallocatedCurrentQty, unallocatedCurrentValue, coverageStatus: unallocatedCurrentQty<=0.0001 ? 'FULL_GLOBAL_PURCHASE_COVERAGE' : (allocatedToAnySupplierQty>0 ? 'PARTIAL_GLOBAL_PURCHASE_COVERAGE' : 'NO_GLOBAL_PURCHASE_COVERAGE'),
      warehouses:[...inv.warehouses], allocationMethod:'TRUE_REVERSE_FIFO_ALL_SUPPLIERS_THEN_FILTER_SELECTED',
      globalLayerCount:allLayers.length, selectedRemainingLayerCount:selectedWrittenForCode.length, createdAt:now });
  }
  const coverageDiagnostic={ fullCoverageItemCount, partialCoverageItemCount, noCoverageItemCount, totalUnallocatedCurrentQty, totalUnallocatedCurrentValue, unknownInventoryLayerCount:unknownInventoryLayers.length };
  profitDiagnostic.globalAllocation.coverage = coverageDiagnostic;
  jobCheckpoint(opts);
  jobProgress(opts,'Saving Snapshot',0,1,'Saving Supplier Sleep snapshot');
  await db.collection('supplierPurchaseLayers').deleteMany({ snapshotId:sid }); if(writtenLayers.length) await db.collection('supplierPurchaseLayers').insertMany(writtenLayers,{ordered:false});
  await db.collection('supplierInventoryAllocation').deleteMany({ snapshotId:sid }); if(allocations.length) await db.collection('supplierInventoryAllocation').insertMany(allocations,{ordered:false});
  // 0.9.19.27.5: Separate accounting purchase total from analyzed goods-layer total.
  // Accounting reference must come from the valid purchase invoice list, not from parsed item layers.
  const periodInvoiceTotalValue=invs.reduce((s,x)=>s+num(x.totalAmount,0),0);
  const periodInvoiceCount=invs.length;
  const periodInvoiceRowCount=invs.reduce((s,x)=>s+num(x.rowCount,0),0);
  const totalSelectedPurchaseValue=purchaseLayers.reduce((s,x)=>s+num(x.purchaseValue,0),0);
  const periodLayerGoodsValue=totalSelectedPurchaseValue;
  const periodParsedLayerCount=purchaseLayers.length;
  const invoiceLayerByNo=new Map();
  for(const l of purchaseLayers){
    const k=String(l.purchaseInvoiceNo||'');
    const cur=invoiceLayerByNo.get(k)||{ layerValue:0, layerCount:0, parsedQty:0 };
    cur.layerValue+=num(l.purchaseValue,0); cur.layerCount++; cur.parsedQty+=num(l.purchaseQty,0);
    invoiceLayerByNo.set(k,cur);
  }
  const invoiceReconciliation=invs.map(inv=>{
    const k=String(inv.invNo||''); const x=invoiceLayerByNo.get(k)||{ layerValue:0, layerCount:0, parsedQty:0 };
    const invoiceTotal=num(inv.totalAmount,0); const layerValue=num(x.layerValue,0); const diff=invoiceTotal-layerValue;
    const diffAbs=Math.abs(diff); const diffPercent=invoiceTotal?Math.round(diffAbs*10000/invoiceTotal)/100:0;
    let status='OK'; let severity='ok';
    if(num(inv.rowCount,0)>0 && num(x.layerCount,0)===0){ status='BODY_MISSING_OR_NOT_PARSED'; severity='danger'; }
    else if(num(x.layerCount,0)<num(inv.rowCount,0)){ status='PARTIAL_LINES_PARSED_RISK'; severity='warn'; }
    else if(diff>0 && diffPercent>0.5){ status='UNDER_PARSED_RISK_OR_NON_ITEM_CHARGE'; severity='warn'; }
    else if(diff<0 && diffPercent>0.5){ status='COST_ALLOCATED_OVER_OR_LANDED_COST'; severity='info'; }
    else if(diffAbs>0){ status='MINOR_ADJUSTMENT'; severity='info'; }
    return { invNo:inv.invNo, invDate:inv.invDate, supplierAccountNo:inv.supplierAccountNo, supplierName:inv.supplierName, invoiceTotal, layerValue, difference:diff, differencePercent:diffPercent, rowCountExpected:num(inv.rowCount,0), layerCount:num(x.layerCount,0), parsedQty:num(x.parsedQty,0), status, severity };
  });

  const purchaseByInvoice=new Map();
  for(const l of purchaseLayers){
    const invKey=String(l.purchaseInvoiceNo||'');
    const pv=purchaseByInvoice.get(invKey)||{ purchaseItemCodes:new Set(), purchaseLayerIds:new Set(), purchaseQty:0, purchaseValue:0 };
    pv.purchaseItemCodes.add(l.itemCode); pv.purchaseLayerIds.add(l.layerId||l.persistentLayerId||'');
    pv.purchaseQty+=num(l.purchaseQty,0); pv.purchaseValue+=num(l.purchaseValue,0);
    purchaseByInvoice.set(invKey,pv);
  }

  // 0.9.19.28: invoice-level sleep and category/group dashboards are derived from persistent LayerId rows.
  const allocatedByInvoice=new Map();
  const groupAgg=new Map();
  for(const l of writtenLayers){
    const invKey=String(l.purchaseInvoiceNo||'');
    const iv=allocatedByInvoice.get(invKey)||{ remainingValue:0, remainingQty:0, ageValueSum:0, ageWeight:0, staleOver30Value:0, staleOver60Value:0, itemCodes:new Set(), layerIds:new Set() };
    const rv=num(l.allocatedRemainingValue,0), rq=num(l.allocatedRemainingQty,0);
    iv.remainingValue+=rv; iv.remainingQty+=rq; iv.itemCodes.add(l.itemCode); iv.layerIds.add(l.layerId||l.persistentLayerId||'');
    if(l.ageDays!=null){ iv.ageValueSum+=num(l.ageDays,0)*rv; iv.ageWeight+=rv; if(num(l.ageDays,0)>30) iv.staleOver30Value+=rv; if(num(l.ageDays,0)>60) iv.staleOver60Value+=rv; }
    allocatedByInvoice.set(invKey,iv);
    const gk=clean(l.mainGroupCode||'__UNKNOWN__'); const gLabel=clean(l.mainGroup||'نامشخص');
    const gv=groupAgg.get(gk)||{ mainGroupCode:gk, mainGroup:gLabel, purchaseValue:0, purchaseQty:0, remainingValue:0, remainingQty:0, ageValueSum:0, ageWeight:0, staleOver30Value:0, staleOver60Value:0, itemCodes:new Set(), invoiceNos:new Set(), layerIds:new Set() };
    gv.remainingValue+=rv; gv.remainingQty+=rq; gv.itemCodes.add(l.itemCode); gv.invoiceNos.add(String(l.purchaseInvoiceNo||'')); gv.layerIds.add(l.layerId||l.persistentLayerId||'');
    if(l.ageDays!=null){ gv.ageValueSum+=num(l.ageDays,0)*rv; gv.ageWeight+=rv; if(num(l.ageDays,0)>30) gv.staleOver30Value+=rv; if(num(l.ageDays,0)>60) gv.staleOver60Value+=rv; }
    groupAgg.set(gk,gv);
  }
  for(const l of purchaseLayers){
    const gk=clean(l.mainGroupCode||'__UNKNOWN__'); const gLabel=clean(l.mainGroup||'نامشخص');
    const gv=groupAgg.get(gk)||{ mainGroupCode:gk, mainGroup:gLabel, purchaseValue:0, purchaseQty:0, remainingValue:0, remainingQty:0, ageValueSum:0, ageWeight:0, staleOver30Value:0, staleOver60Value:0, itemCodes:new Set(), invoiceNos:new Set(), layerIds:new Set() };
    gv.purchaseValue+=num(l.purchaseValue,0); gv.purchaseQty+=num(l.purchaseQty,0); gv.itemCodes.add(l.itemCode); gv.invoiceNos.add(String(l.purchaseInvoiceNo||'')); gv.layerIds.add(l.layerId||l.persistentLayerId||'');
    groupAgg.set(gk,gv);
  }
  const invoiceSleepRows=invs.map(inv=>{
    const rec=invoiceReconciliation.find(r=>Number(r.invNo)===Number(inv.invNo))||{};
    const invKey=String(inv.invNo||'');
    const a=allocatedByInvoice.get(invKey)||{ remainingValue:0, remainingQty:0, ageValueSum:0, ageWeight:0, staleOver30Value:0, staleOver60Value:0, itemCodes:new Set(), layerIds:new Set() };
    const pinfo=purchaseByInvoice.get(invKey)||{ purchaseItemCodes:new Set(), purchaseLayerIds:new Set(), purchaseQty:0, purchaseValue:0 };
    const purchaseValue=num(rec.layerValue||pinfo.purchaseValue||0,0);
    const remainingValue=num(a.remainingValue,0);
    const soldOrConsumedValue=Math.max(0,purchaseValue-remainingValue);
    const ip=profitAlloc.invoiceProfit.get(invKey)||{};
    let validationStatus = rec.status || 'UNKNOWN';
    if (purchaseValue > 0 && remainingValue <= 0 && validationStatus === 'OK') validationStatus = 'FULLY_CONSUMED_OR_SOLD';
    return {
      snapshotId:sid, supplierAccountNo:sync.supplier?.accountNumber||supplier.accountNumber||'', supplierName:(invs[0]?.supplierName)||sync.supplier?.accountName||supplier.accountName||'تأمین‌کننده انتخاب‌شده',
      purchaseInvoiceNo:inv.invNo, purchaseDate:inv.invDate, invoiceTotal:num(inv.totalAmount,0), layerPurchaseValue:purchaseValue,
      purchaseItemCount:pinfo.purchaseItemCodes.size, purchaseLayerCount:pinfo.purchaseLayerIds.size, purchaseQty:num(pinfo.purchaseQty,0),
      remainingValue, remainingQty:num(a.remainingQty,0), soldOrConsumedValue, turnoverPercent:pct(soldOrConsumedValue,purchaseValue), remainingPercent:pct(remainingValue,purchaseValue),
      averageAgeDays:a.ageWeight?Math.round(a.ageValueSum/a.ageWeight):null, staleOver30Value:num(a.staleOver30Value,0), staleOver60Value:num(a.staleOver60Value,0), staleOver30Percent:pct(a.staleOver30Value,remainingValue), staleOver60Percent:pct(a.staleOver60Value,remainingValue),
      itemCount:pinfo.purchaseItemCodes.size, layerCount:pinfo.purchaseLayerIds.size, remainingItemCount:a.itemCodes.size, remainingLayerCount:a.layerIds.size,
      validationStatus, validationSeverity:rec.severity||'', reconciliationDifference:num(rec.difference,0), reconciliationDifferencePercent:num(rec.differencePercent,0),
      saleValue:num(ip.saleValue,0), fifoCost:num(ip.fifoCost,0), estimatedProfitAmount:num(ip.fifoProfit,0), roiPercent:ip.roiOnCostPercent??null, profitPercentOfSale:ip.profitPercentOfSale??null, profitStatus:ip.saleValue?'MANAGEMENT_FIFO_SALES_INVOICE':'NO_MATCHED_SALE_OR_UNSOLD', updatedAt:now
    };
  });
  const groupRows=[...groupAgg.values()].map(g=>{
    const soldOrConsumedValue=Math.max(0,num(g.purchaseValue,0)-num(g.remainingValue,0));
    const gp=profitAlloc.groupProfit.get(g.mainGroupCode||'__UNKNOWN__')||{};
    return { snapshotId:sid, supplierAccountNo:sync.supplier?.accountNumber||supplier.accountNumber||'', supplierName:(invs[0]?.supplierName)||sync.supplier?.accountName||supplier.accountName||'تأمین‌کننده انتخاب‌شده', mainGroupCode:g.mainGroupCode||'', mainGroup:g.mainGroup, purchaseValue:num(g.purchaseValue,0), purchaseQty:num(g.purchaseQty,0), remainingValue:num(g.remainingValue,0), remainingQty:num(g.remainingQty,0), soldOrConsumedValue, turnoverPercent:pct(soldOrConsumedValue,g.purchaseValue), remainingPercent:pct(g.remainingValue,g.purchaseValue), averageAgeDays:g.ageWeight?Math.round(g.ageValueSum/g.ageWeight):null, staleOver30Value:num(g.staleOver30Value,0), staleOver60Value:num(g.staleOver60Value,0), staleOver30Percent:pct(g.staleOver30Value,g.remainingValue), staleOver60Percent:pct(g.staleOver60Value,g.remainingValue), itemCount:g.itemCodes.size, invoiceCount:[...g.invoiceNos].filter(Boolean).length, layerCount:[...g.layerIds].filter(Boolean).length, saleValue:num(gp.saleValue,0), fifoCost:num(gp.fifoCost,0), estimatedProfitAmount:num(gp.fifoProfit,0), roiPercent:gp.roiOnCostPercent??null, profitPercentOfSale:gp.profitPercentOfSale??null, profitStatus:gp.saleValue?'MANAGEMENT_FIFO_SALES_INVOICE':'NO_MATCHED_SALE_OR_UNSOLD', updatedAt:now };
  }).sort((a,b)=>b.remainingValue-a.remainingValue);
  const totalReconciliationDiff=periodInvoiceTotalValue-periodLayerGoodsValue;
  const totalReconciliationDiffPercent=periodInvoiceTotalValue?Math.round(Math.abs(totalReconciliationDiff)*10000/periodInvoiceTotalValue)/100:0;
  let reconciliationStatus='OK';
  if(periodInvoiceCount && periodParsedLayerCount===0) reconciliationStatus='FAIL_NO_LAYERS';
  else if(totalReconciliationDiff>0 && totalReconciliationDiffPercent>0.5) reconciliationStatus='WARN_LAYER_LESS_THAN_INVOICE';
  else if(totalReconciliationDiff<0 && totalReconciliationDiffPercent>0.5) reconciliationStatus='INFO_LAYER_MORE_THAN_INVOICE';
  else if(Math.abs(totalReconciliationDiff)>0) reconciliationStatus='MINOR_ADJUSTMENT';
  const remainingValue=writtenLayers.reduce((s,x)=>s+num(x.allocatedRemainingValue,0),0);
  const remainingQty=writtenLayers.reduce((s,x)=>s+num(x.allocatedRemainingQty,0),0);
  const ageValueSum=writtenLayers.reduce((s,x)=>s+(x.ageDays==null?0:num(x.ageDays,0)*num(x.allocatedRemainingValue,0)),0);
  const ageWeight=writtenLayers.reduce((s,x)=>s+(x.ageDays==null?0:num(x.allocatedRemainingValue,0)),0);
  const staleOver30Value=writtenLayers.filter(x=>num(x.ageDays,0)>30).reduce((s,x)=>s+num(x.allocatedRemainingValue,0),0);
  const staleOver60Value=writtenLayers.filter(x=>num(x.ageDays,0)>60).reduce((s,x)=>s+num(x.allocatedRemainingValue,0),0);
  const supNo=sync.supplier?.accountNumber||supplier.accountNumber||''; const supName=(invs[0]?.supplierName)||sync.supplier?.accountName||supplier.accountName||'تأمین‌کننده انتخاب‌شده';
  const summary={ snapshotId:sid, supplierAccountNo:supNo, supplierName:supName,
    // Management/accounting purchase reference
    periodPurchaseValue:periodInvoiceTotalValue, periodInvoiceTotalValue, periodInvoiceCount, periodInvoiceRowCount,
    // Parsed goods-layer value used for inventory sleep analysis
    periodLayerGoodsValue, periodParsedLayerCount, periodReconciliationDiff:totalReconciliationDiff, periodReconciliationDiffPercent:totalReconciliationDiffPercent, reconciliationStatus,
    periodPurchaseQty:purchaseLayers.reduce((s,x)=>s+num(x.purchaseQty,0),0), remainingValue, remainingQty, shareOfTotalInventoryPercent:pct(remainingValue, allocations.reduce((s,x)=>s+num(x.currentValue,0),0)), averageAgeDays:ageWeight?Math.round(ageValueSum/ageWeight):null, itemCount:new Set(writtenLayers.map(x=>x.itemCode)).size, layerCount:writtenLayers.length, staleOver30Value, staleOver60Value, staleOver30Percent:pct(staleOver30Value,remainingValue), staleOver60Percent:pct(staleOver60Value,remainingValue),
    saleValue:0, fifoCost:0, estimatedProfitAmount:0, roiPercent:null, profitStatus:'PAUSED_SALE_SNAPSHOT_PHASE', profitConfidence:'PRE_PROFIT_PHASE_SALE_SNAPSHOT_REQUIRED', updatedAt:now };
  await db.collection('supplierSleepSummary').deleteMany({ snapshotId:sid }); await db.collection('supplierSleepSummary').insertOne(summary);
  await db.collection('supplierSleepInvoiceSummary').deleteMany({ snapshotId:sid }); if(invoiceSleepRows.length) await db.collection('supplierSleepInvoiceSummary').insertMany(invoiceSleepRows,{ordered:false});
  await db.collection('supplierSleepGroupSummary').deleteMany({ snapshotId:sid }); if(groupRows.length) await db.collection('supplierSleepGroupSummary').insertMany(groupRows,{ordered:false});
  const snap={ snapshotId:sid, version:VERSION, status:'completed', mode:'selected-supplier-true-reverse-fifo', dateFrom,dateTo, selectedSupplier:{ accountNumber:supNo, accountName:supName, accountGuid:supplier.accountGuid||'' }, activeWarehouses, createdAt:now, finishedAt:new Date(), purchaseInvoicesSynced:invs.length, purchaseLayerCount:purchaseLayers.length, allocatedLayerCount:writtenLayers.length, inventoryItemCount:allocations.length, invoiceSleepSummaryCount:invoiceSleepRows.length, groupSummaryCount:groupRows.length, totalActiveInventoryValue:allocations.reduce((s,x)=>s+num(x.currentValue,0),0), totalAllocatedValue:remainingValue, totalUnknownValue:totalUnallocatedCurrentValue, totalUnknownQty:totalUnallocatedCurrentQty, coverageDiagnostic, statementRows:sync.statementRows, invoiceNoCandidates:sync.invoiceNoCandidates, fallbackUsed:!!sync.fallbackUsed, syncSource:sync.source||'', globalAllocation:{ source:globalAllocation.source, scannedNumbers:globalAllocation.scannedNumbers, matchedInvoiceCount:(globalAllocation.matchedInvoices||[]).length, globalLayerCount:(globalAllocation.layers||[]).length, coverage:coverageDiagnostic, errors:(globalAllocation.errors||[]).slice(0,20) }, sales:{ source:saleRead.source, scannedInvoices:saleRead.scannedInvoices, detailFetched:saleRead.detailFetched||0, headersWithBody:saleRead.headersWithBody||0, saleBodyRowsParsed:saleRead.saleBodyRowsParsed||0, saleRows:saleRead.list?.length||0, errors:(saleRead.errors||[]).slice(0,20) }, profit:{ source:profitAlloc.source, allocations:profitAlloc.allocations.length, unmatched:profitAlloc.unmatched.length, diagnostic:profitAlloc.diagnostic||{} }, snapshotLabel:snapshotLabelFromDoc({ selectedSupplier:{accountName:supName,accountNumber:supNo}, createdAt:now }), supplierDisplayName:supName, reportJalaliDate:formatJalaliDateTime(now), profitDiagnostic,
    periodInvoiceTotalValue, periodLayerGoodsValue, periodReconciliationDiff:totalReconciliationDiff, periodReconciliationDiffPercent:totalReconciliationDiffPercent, reconciliationStatus, invoiceReconciliation,
    dashboard:{ invoiceSummary:invoiceSleepRows.slice(0,300), groupSummary:groupRows.slice(0,100) },
    diagnostics:sync.diagnostics||{}, errors:sync.errors||[], note:'0.9.19.48: Integrated supplier sleep UI/reconciliation fix. 0.9.19.45 allocation stability preserved. Profit remains paused; selected supplier sleep uses bounded true reverse FIFO for current stock, hydrates header-only purchase invoices, and exposes unknown/opening/scan-limit inventory instead of hiding it.' };
  await db.collection('supplierSleepSnapshots').insertOne(snap);
  await db.collection('supplierSleepDiagnostics').insertOne({ type:'selected-supplier-reconciliation', at:new Date(), snapshotId:sid, supplier:{accountNumber:supNo,accountName:supName}, periodInvoiceTotalValue, periodLayerGoodsValue, totalReconciliationDiff, totalReconciliationDiffPercent, reconciliationStatus, invoiceReconciliation }).catch(()=>{});
  await db.collection('supplierSleepDiagnostics').insertOne({ type:'selected-supplier-profit-diagnostic-v34-paused', at:new Date(), snapshotId:sid, supplier:{accountNumber:supNo,accountName:supName}, profitDiagnostic }).catch(()=>{});
  opts?.jobControl?.heartbeat?.();
  jobProgress(opts,'Saving Snapshot',1,1,'Supplier Sleep snapshot saved');
  return { ok:true, snapshot:snap, summary:[summary], invoiceSummary:invoiceSleepRows, groupSummary:groupRows, invoices:invs.map(x=>{ const rec=invoiceReconciliation.find(r=>Number(r.invNo)===Number(x.invNo))||{}; return {invNo:x.invNo,invDate:x.invDate,totalAmount:x.totalAmount,rowCount:x.rowCount,supplierName:x.supplierName,supplierAccountNo:x.supplierAccountNo, layerValue:rec.layerValue, difference:rec.difference, differencePercent:rec.differencePercent, reconciliationStatus:rec.status, layerCount:rec.layerCount}; }), reconciliation:{ periodInvoiceTotalValue, periodLayerGoodsValue, difference:totalReconciliationDiff, differencePercent:totalReconciliationDiffPercent, status:reconciliationStatus, invoices:invoiceReconciliation }, source:'selected-supplier-true-reverse-fifo-stability-v45' };
}


async function updateSnapshot(db, snapshotIdValue, patch={}, actor=''){
  await ensureIndexes(db);
  const sid=clean(snapshotIdValue);
  if(!sid) return {ok:false,error:'snapshotId required'};
  const allowedStatus=new Set(['completed','archived','invalid']);
  const set={ updatedAt:new Date(), updatedBy:clean(actor||'system') };
  if(Object.prototype.hasOwnProperty.call(patch,'snapshotLabel')) set.snapshotLabel=clean(patch.snapshotLabel).slice(0,180);
  if(Object.prototype.hasOwnProperty.call(patch,'note')) set.userNote=clean(patch.note).slice(0,1000);
  if(Object.prototype.hasOwnProperty.call(patch,'status')){
    const st=clean(patch.status);
    if(!allowedStatus.has(st)) return {ok:false,error:'invalid snapshot status'};
    set.status=st;
  }
  const r=await db.collection('supplierSleepSnapshots').updateOne({snapshotId:sid},{$set:set});
  if(!r.matchedCount) return {ok:false,error:'snapshot not found'};
  const snapshot=await db.collection('supplierSleepSnapshots').findOne({snapshotId:sid});
  return {ok:true,snapshot};
}

async function deleteSnapshot(db, snapshotIdValue, actor=''){
  await ensureIndexes(db);
  const sid=clean(snapshotIdValue);
  if(!sid) return {ok:false,error:'snapshotId required'};
  const snap=await db.collection('supplierSleepSnapshots').findOne({snapshotId:sid});
  if(!snap) return {ok:false,error:'snapshot not found'};
  const collections=['supplierSleepSummary','supplierPurchaseLayers','supplierInventoryAllocation','supplierSleepDiagnostics','supplierSleepInvoiceSummary','supplierSleepGroupSummary'];
  const deleted={};
  for(const name of collections){ const r=await db.collection(name).deleteMany({snapshotId:sid}); deleted[name]=r.deletedCount||0; }
  const r=await db.collection('supplierSleepSnapshots').deleteOne({snapshotId:sid});
  await db.collection('appLogs').insertOne({type:'supplier_sleep_snapshot_deleted',snapshotId:sid,deleted,by:clean(actor||'system'),at:new Date(),snapshotMeta:{supplier:snap.supplierDisplayName||snap.selectedSupplier?.accountName||'',createdAt:snap.createdAt||null}}).catch(()=>{});
  return {ok:true,snapshotId:sid,deletedSnapshot:r.deletedCount||0,deleted};
}

async function listSnapshots(db, limit=20){ await ensureIndexes(db); const list=await db.collection('supplierSleepSnapshots').find({}).sort({ createdAt:-1 }).limit(Math.min(Number(limit||20),100)).toArray(); return { ok:true, list:list.map(x=>({ ...x, snapshotLabel:x.snapshotLabel||snapshotLabelFromDoc(x), reportJalaliDate:x.reportJalaliDate||formatJalaliDateTime(x.createdAt||x.finishedAt), supplierDisplayName:x.supplierDisplayName||x.selectedSupplier?.accountName||x.supplierName||'' })) }; }
async function getProfitDiagnostics(db, opts={}){ await ensureIndexes(db); const snapshotId=clean(opts.snapshotId||''); const q=snapshotId?{ snapshotId, type:'selected-supplier-profit-diagnostic-v34-paused' }:{ type:'selected-supplier-profit-diagnostic-v34-paused' }; const doc=await db.collection('supplierSleepDiagnostics').findOne(q,{ sort:{ at:-1 } }); return { ok:true, snapshotId:doc?.snapshotId||snapshotId, diagnostics:doc?.profitDiagnostic||null, at:doc?.at||null }; }
async function getSummary(db, snapshotId='', limit=300){ const sid=snapshotId || (await db.collection('supplierSleepSnapshots').findOne({ status:'completed' }, { sort:{ createdAt:-1 } }))?.snapshotId; if(!sid) return { ok:true, snapshotId:'', list:[] }; const list=await db.collection('supplierSleepSummary').find({ snapshotId:sid }).sort({ remainingValue:-1 }).limit(Math.min(Number(limit||300),1000)).toArray(); return { ok:true, snapshotId:sid, list }; }
async function getLayers(db, opts={}){
  const sid=opts.snapshotId || (await db.collection('supplierSleepSnapshots').findOne({ status:'completed' }, { sort:{ createdAt:-1 } }))?.snapshotId;
  if(!sid) return { ok:true, snapshotId:'', list:[] };
  const limit=Math.min(Number(opts.limit||500),2000);
  const q={ snapshotId:sid };
  if(opts.supplierAccountNo) q.supplierAccountNo=opts.supplierAccountNo;
  if(opts.itemCode) q.itemCode=opts.itemCode;
  if(opts.mainGroupCode) q.mainGroupCode=opts.mainGroupCode;
  let list=await db.collection('supplierPurchaseLayers').find(q).sort({ allocatedRemainingValue:-1 }).limit(limit).toArray();
  // 0.9.19.47: selected-supplier snapshots may have matched supplier by name/guid while layer supplierAccountNo differs/blank.
  // In that case the UI must still show layers for the selected snapshot instead of a false empty table.
  if(!list.length && opts.supplierAccountNo && !opts.itemCode){
    list=await db.collection('supplierPurchaseLayers').find(opts.mainGroupCode ? { snapshotId:sid, mainGroupCode:opts.mainGroupCode } : { snapshotId:sid }).sort({ allocatedRemainingValue:-1 }).limit(limit).toArray();
  }
  return { ok:true, snapshotId:sid, list };
}
async function getInvoiceSummary(db, opts={}){ const sid=opts.snapshotId || (await db.collection('supplierSleepSnapshots').findOne({ status:'completed' }, { sort:{ createdAt:-1 } }))?.snapshotId; if(!sid) return { ok:true, snapshotId:'', list:[] }; const q={ snapshotId:sid }; if(opts.supplierAccountNo) q.supplierAccountNo=opts.supplierAccountNo; const list=await db.collection('supplierSleepInvoiceSummary').find(q).sort({ remainingValue:-1 }).limit(Math.min(Number(opts.limit||500),2000)).toArray(); return { ok:true, snapshotId:sid, list }; }
async function getGroupSummary(db, opts={}){ const sid=opts.snapshotId || (await db.collection('supplierSleepSnapshots').findOne({ status:'completed' }, { sort:{ createdAt:-1 } }))?.snapshotId; if(!sid) return { ok:true, snapshotId:'', list:[] }; const q={ snapshotId:sid }; if(opts.supplierAccountNo) q.supplierAccountNo=opts.supplierAccountNo; if(opts.mainGroupCode) q.mainGroupCode=opts.mainGroupCode; const list=await db.collection('supplierSleepGroupSummary').find(q).sort({ remainingValue:-1 }).limit(Math.min(Number(opts.limit||300),1000)).toArray(); return { ok:true, snapshotId:sid, list }; }
module.exports={ VERSION, ensureIndexes, readPurchaseInvoicesByDateRange, readPurchaseInvoicesDescending, readPurchaseInvoicesForSupplier, getSupplierIndex, getSupplierInvoices, buildPurchaseLayerSnapshot, buildSelectedSupplierSnapshot, listSnapshots, updateSnapshot, deleteSnapshot, getSummary, getLayers, getInvoiceSummary, getGroupSummary, getProfitDiagnostics };
