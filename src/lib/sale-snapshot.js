'use strict';

const shaygan = require('./shaygan');
const { APP_VERSION: VERSION } = require('./app-version');
const { normalizeJalaliRange, canonicalSaleDate } = require('./jalali-date');
const AMOUNT_TOLERANCE_RIAL = 0.01;
const DATASET_HEADERS = 'saleSnapshotDatasetHeaders';
const DATASET_LINES = 'saleSnapshotDatasetLines';
const LEGACY_HEADERS = 'saleInvoiceHeaders';
const LEGACY_LINES = 'saleInvoiceLines';
const DEFAULT_PAGE_ATTEMPTS = 3;

function clean(v){ return String(v == null ? '' : v).trim(); }
function num(v,d=0){ const n=Number(String(v??'').replace(/[,،\s]/g,'')); return Number.isFinite(n)?n:d; }
function safeError(value, maxLength=1000){
  return clean(value)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[REDACTED]')
    .replace(/((?:authorization|password|passwd|token|api[-_ ]?key)\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]')
    .slice(0,Math.max(1,Math.min(Number(maxLength)||1000,4000)));
}
function snapshotId(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `SSALE-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2,8)}`; }
function lineItemCode(x){ return clean(x.ItemCode || x.ItemNumber || x.Code || x.itemCode || x.itemNumber); }
function lineItemName(x){ return clean(x.ItemDescription || x.ItemDesc || x.ItemName || x.Description || x.itemDescription || x.name); }
function lineQty(x){ return num(x.Quan ?? x.Quantity ?? x.Qty ?? x.Quantity1 ?? x.MainUnitQuantity ?? x.itemQty, 0); }
function lineAmount(x){ return num(x.Amount ?? x.TotalAmount ?? x.LineAmount ?? x.PriceTotal ?? x.NetAmount ?? x.SaleAmount ?? x.TotalPrice ?? 0, 0); }
function lineUnitPrice(x){ const q=lineQty(x); const amount=lineAmount(x); return num(x.Price ?? x.UnitPrice ?? x.SalePrice ?? x.Fee ?? (q ? amount/q : 0), 0); }
function invNo(inv){ return Number(inv.InvNo || inv.InvoiceNumber || inv.Number || 0); }
function invDate(inv){ return clean(inv.InvDate || inv.InvoiceDate || inv.Date || ''); }
function invGuid(inv){ return clean(inv.GuId || inv.Guid || inv.InvGuId || inv.InvHeaderGuId || ''); }
function invAccountNo(inv){ return clean(inv.AccountNumber || inv.CustomerNumber || inv.AccNo || inv.accountNumber || ''); }
function invAccountName(inv){ return clean(inv.AccountName || inv.CustomerName || inv.AccName || inv.accountName || ''); }
function invSellerAccountNo(inv){ return clean(inv.SAccountNumber || inv.SellerAccountNumber || inv.SalesAccountNumber || inv.RepAccountNumber || ''); }
function invSellerAccountName(inv){ return clean(inv.SAccountName || inv.SellerAccountName || inv.SalesAccountName || inv.RepAccountName || ''); }
function invIssuerFirst(inv){ return clean(inv.FirstIssuerUsername || inv.FirstIssuer || inv.CreatedBy || ''); }
function invIssuerLast(inv){ return clean(inv.LastIssuerUsername || inv.LastIssuer || inv.UpdatedBy || ''); }
function invGeneralRef(inv){ return clean(inv.GeneralRef || inv.GeneralReference || inv.RefNo || ''); }
function invTypeLabel(invTyp){
  const t=Number(invTyp||0);
  if(t===2) return 'Sale';
  if(t===3) return 'Buy';
  if(t===6) return 'SaleReturn';
  if(t===7) return 'PurchaseReturn';
  return `Ignored_Type${t||''}`;
}
function invBody(inv){ return Array.isArray(inv.Body) ? inv.Body : (Array.isArray(inv.Items) ? inv.Items : []); }
function invTotal(inv){ const body=invBody(inv); const sum=body.reduce((s,x)=>s+lineAmount(x),0); return num(inv.SourceTotalAmount ?? inv.TotalAmount ?? inv.Amount ?? sum, sum); }
function parseDateScore(v){ const s=clean(v).replace(/[^0-9]/g,''); return Number(s.slice(0,8) || 0); }

function saleDate8(v, field='saleDate'){ return canonicalSaleDate(v, { field }); }
function saleDateScore(v){ return parseDateScore(saleDate8(v)); }
function lineDateScoreFromDoc(x){ return saleDateScore(x.saleDate || x.invDate || ''); }
function layerStableKey(l){ return clean(l.persistentLayerId || l.layerId || `${l.supplierAccountNo||''}-${l.purchaseInvoiceNo||''}-${l.row||''}-${l.itemCode||''}`); }
function layerQty(l){ return num(l.purchaseQty ?? l.qty ?? l.quantity ?? 0, 0); }
function layerUnitCost(l){
  const q=layerQty(l);
  const direct=num(l.unitCost ?? l.buyUnitPrice ?? l.purchaseUnitPrice ?? l.costPrice ?? 0, 0);
  if(direct>0) return direct;
  const val=num(l.purchaseValue ?? l.layerValue ?? 0, 0);
  return q ? val/q : 0;
}
async function loadLatestPurchaseLayersForProfit(db){
  // Build one de-duplicated purchase-layer pool. A purchase can exist in multiple supplier sleep snapshots;
  // keep the newest copy per stable LayerId so FIFO profit is not double-counted.
  const docs=await db.collection('supplierPurchaseLayers').find({ itemCode:{ $exists:true, $ne:'' } }).sort({ syncedAt:-1, _id:-1 }).limit(200000).toArray().catch(()=>[]);
  const byKey=new Map();
  for(const d of docs||[]){
    const key=layerStableKey(d); if(!key || byKey.has(key)) continue;
    const qty=layerQty(d); const unitCost=layerUnitCost(d);
    if(!clean(d.itemCode) || qty<=0 || unitCost<=0) continue;
    byKey.set(key,{ ...d, stableLayerId:key, fifoRemainingQty:qty, fifoUnitCost:unitCost, purchaseDateScore:parseDateScore(d.purchaseDate||''), purchaseInvoiceNoNum:num(d.purchaseInvoiceNo,0), purchaseRowNum:num(d.row||d.purchaseRow||0,0) });
  }
  const byItem=new Map();
  for(const l of byKey.values()){
    const code=clean(l.itemCode); if(!byItem.has(code)) byItem.set(code,[]);
    byItem.get(code).push(l);
  }
  for(const arr of byItem.values()) arr.sort((a,b)=>(a.purchaseDateScore-b.purchaseDateScore)||(a.purchaseInvoiceNoNum-b.purchaseInvoiceNoNum)||(a.purchaseRowNum-b.purchaseRowNum));
  return { byItem, layerCount:byKey.size, sourceRows:docs.length, scanLimitReached:docs.length>=200000 };
}
async function computeSellerProfitFifo(db, filters={}){
  const seller=clean(filters.sellerAccountNumber || filters.seller || '');
  const store=clean(filters.store||'');
  const { dateFrom, dateTo }=normalizeJalaliRange(filters);
  const saleSource=filters._saleSource||await activeDataset(db);
  const saleQ={ ...saleSource.lineQuery, saleInvoiceType:2 };
  // We must consume all sales up to dateTo, not just the chosen seller/date range; otherwise older layers are assigned incorrectly.
  const profitScanLimit=Math.max(1, Math.min(Number(filters.profitScanLimit||250000), 500000));
  const allSalesRaw=await db.collection(saleSource.lineCollection).find(saleQ).sort({ saleInvoiceNo:1, row:1 }).limit(profitScanLimit).toArray().catch(()=>[]);
  const allSales=allSalesRaw.filter(row=>!dateTo||saleDateScore(row.saleDate||'')<=parseDateScore(dateTo)).sort((a,b)=>lineDateScoreFromDoc(a)-lineDateScoreFromDoc(b)||num(a.saleInvoiceNo)-num(b.saleInvoiceNo)||num(a.row)-num(b.row));
  const purchasePool=await loadLatestPurchaseLayersForProfit(db);
  const targetKey=(l)=>{
    if(seller && clean(l.sellerAccountNumber)!==seller) return false;
    if(store && !clean(l.sellerStoreName).includes(store)) return false;
    const ds=saleDateScore(l.saleDate||'');
    if(dateFrom && ds<parseDateScore(dateFrom)) return false;
    if(dateTo && ds>parseDateScore(dateTo)) return false;
    return true;
  };
  const resultByLine=new Map(); const invoiceProfit=new Map(); const groupProfit=new Map();
  const diagnostics={ saleRowsScanned:allSales.length, saleSourceRowsRead:allSalesRaw.length, saleScanLimit:profitScanLimit, saleScanLimitReached:allSalesRaw.length>=profitScanLimit, purchaseLayerPool:purchasePool.layerCount, purchaseLayerSourceRows:purchasePool.sourceRows, purchaseLayerScanLimitReached:purchasePool.scanLimitReached, purchaseHistoryComplete:false, purchaseHistoryScope:'supplierPurchaseLayers may contain only suppliers selected by Supplier Sleep runs', allocatedRows:0, targetAllocatedRows:0, partialRows:0, unknownRows:0, skippedFutureLayers:0, noPurchaseLayerRows:0, insufficientLayerRows:0, unmatchedReasons:{}, note:'FIFO consumes all sale lines up to dateTo; only selected seller/date rows are reported. Profit is coverage-only until a complete purchase-history source is established.' };
  for(const sale of allSales){
    const code=clean(sale.itemCode); const arr=purchasePool.byItem.get(code)||[];
    let need=num(sale.qty,0); const originalQty=need; const saleValueTotal=num(sale.saleValue,0); const unitSale= originalQty ? saleValueTotal/originalQty : num(sale.unitSale,0);
    const saleDs=saleDateScore(sale.saleDate||'');
    let cost=0, saleValue=0, allocatedQty=0; const allocations=[];
    if(!arr.length){ diagnostics.noPurchaseLayerRows++; }
    for(const layer of arr){
      if(need<=0) break;
      if(num(layer.fifoRemainingQty,0)<=0) continue;
      if(layer.purchaseDateScore && saleDs && layer.purchaseDateScore>saleDs){ diagnostics.skippedFutureLayers++; continue; }
      const q=Math.min(need, num(layer.fifoRemainingQty,0)); if(q<=0) continue;
      layer.fifoRemainingQty-=q; need-=q; allocatedQty+=q;
      const c=q*num(layer.fifoUnitCost,0); const sv=q*unitSale; cost+=c; saleValue+=sv;
      allocations.push({ layerId:layer.stableLayerId, supplierAccountNo:layer.supplierAccountNo||'', supplierName:layer.supplierName||'', purchaseInvoiceNo:layer.purchaseInvoiceNo||'', purchaseDate:layer.purchaseDate||'', qty:q, unitCost:num(layer.fifoUnitCost,0), cost:Math.round(c), saleValue:Math.round(sv), profit:Math.round(sv-c) });
    }
    let status='calculated'; let reason='';
    if(allocatedQty<=0){ status='unknown'; reason=arr.length?'NO_ELIGIBLE_PURCHASE_BEFORE_SALE':'NO_PURCHASE_LAYER'; diagnostics.unknownRows++; diagnostics.unmatchedReasons[reason]=(diagnostics.unmatchedReasons[reason]||0)+1; }
    else if(need>0.0001){ status='partial'; reason='INSUFFICIENT_PURCHASE_LAYER_QTY'; diagnostics.partialRows++; diagnostics.insufficientLayerRows++; diagnostics.unmatchedReasons[reason]=(diagnostics.unmatchedReasons[reason]||0)+1; }
    diagnostics.allocatedRows += allocations.length;
    const lineProfit={ saleLineId:sale.saleLineId||'', saleInvoiceNo:sale.saleInvoiceNo, saleDate:saleDate8(sale.saleDate), row:sale.row, itemCode:code, itemName:sale.itemName||'', sellerAccountNumber:sale.sellerAccountNumber||'', sellerName:sale.sellerName||'', sellerStoreName:sale.sellerStoreName||'', qty:originalQty, allocatedQty, saleValue:Math.round(saleValue || (status==='unknown'?0:saleValueTotal)), fifoCost:Math.round(cost), fifoProfit: status==='unknown'?null:Math.round((saleValue||0)-cost), profitStatus:status, profitReason:reason, allocations };
    resultByLine.set(`${sale.saleInvoiceType}-${sale.saleInvoiceNo}-${sale.row}`, lineProfit);
    if(targetKey(sale)){
      if(status!=='unknown') diagnostics.targetAllocatedRows += allocations.length;
      const ik=`${sale.saleInvoiceType}-${sale.saleInvoiceNo}`;
      const inv=invoiceProfit.get(ik)||{ saleInvoiceType:sale.saleInvoiceType, saleInvoiceNo:sale.saleInvoiceNo, saleDate:saleDate8(sale.saleDate), sellerAccountNumber:sale.sellerAccountNumber, sellerName:sale.sellerName, amount:0, fifoCost:0, fifoProfit:0, lines:0, calculatedLines:0, partialLines:0, unknownLines:0, itemCodes:new Set() };
      inv.amount += num(sale.saleValue,0); inv.fifoCost += cost; if(status!=='unknown') inv.fifoProfit += ((saleValue||0)-cost); inv.lines++; inv.itemCodes.add(code);
      if(status==='calculated') inv.calculatedLines++; else if(status==='partial') inv.partialLines++; else inv.unknownLines++;
      invoiceProfit.set(ik, inv);
      const gk=clean(sale.mainGroupCode||'__UNKNOWN__');
      const gp=groupProfit.get(gk)||{ mainGroupCode:gk, mainGroup:sale.mainGroup||'نامشخص', amount:0, fifoCost:0, fifoProfit:0, lines:0, qty:0, calculatedLines:0, partialLines:0, unknownLines:0, invoices:new Set(), itemCodes:new Set() };
      gp.amount += num(sale.saleValue,0); gp.fifoCost += cost; if(status!=='unknown') gp.fifoProfit += ((saleValue||0)-cost); gp.lines++; gp.qty += num(sale.qty,0); gp.invoices.add(ik); gp.itemCodes.add(code);
      if(status==='calculated') gp.calculatedLines++; else if(status==='partial') gp.partialLines++; else gp.unknownLines++;
      groupProfit.set(gk,gp);
    }
  }
  function roi(profit,cost){ return cost ? Math.round(profit*10000/cost)/100 : null; }
  const targetResults=[...resultByLine.values()].filter(x=>{
    if(seller && clean(x.sellerAccountNumber)!==seller) return false;
    if(store && !clean(x.sellerStoreName).includes(store)) return false;
    const ds=saleDateScore(x.saleDate||'');
    if(dateFrom && ds<parseDateScore(dateFrom)) return false;
    if(dateTo && ds>parseDateScore(dateTo)) return false;
    return true;
  });
  const totals=targetResults.reduce((a,x)=>{
    const q=num(x.qty,0), aq=num(x.allocatedQty,0), fullSale=num(x.saleValue,0);
    a.amount+=num(x.saleValue,0); a.coveredSales+=fullSale; a.cost+=num(x.fifoCost,0); if(x.fifoProfit!=null)a.profit+=num(x.fifoProfit,0);
    a.qty+=q; a.coveredQty+=aq; a.lines++;
    if(x.profitStatus==='calculated')a.calculated++; else if(x.profitStatus==='partial')a.partial++; else a.unknown++;
    return a;
  },{amount:0,coveredSales:0,cost:0,profit:0,qty:0,coveredQty:0,lines:0,calculated:0,partial:0,unknown:0});
  const targetSales=[...invoiceProfit.values()].reduce((sum,x)=>sum+num(x.amount,0),0);
  const coveredQtyPercent=totals.qty?Math.round(totals.coveredQty*10000/totals.qty)/100:0;
  const coveredSalesPercent=targetSales?Math.round(totals.coveredSales*10000/targetSales)/100:0;
  const hasCoverage=totals.coveredQty>0;
  const profitStatus=hasCoverage?'partial':'unknown';
  const coverage={ totalLines:totals.lines, calculatedLines:totals.calculated, partialLines:totals.partial, unknownLines:totals.unknown, totalQty:totals.qty, coveredQty:totals.coveredQty, coveredQtyPercent, totalSales:Math.round(targetSales), coveredSales:Math.round(totals.coveredSales), coveredSalesPercent, purchaseHistoryComplete:false };
  return { resultByLine, invoiceProfit, groupProfit, totals:{ totalSales:Math.round(targetSales), fifoCost:hasCoverage?Math.round(totals.cost):null, fifoProfit:hasCoverage?Math.round(totals.profit):null, roiPercent:hasCoverage?roi(totals.profit,totals.cost):null, lineCount:totals.lines, calculatedLines:totals.calculated, partialLines:totals.partial, unknownLines:totals.unknown, profitStatus, coverage }, diagnostics };
}
function scopeKeyFor(dateFrom, dateTo){ return `sale-type2|${clean(dateFrom)}|${clean(dateTo)}`; }

async function writeRows(collection, rows, keyFor){
  if(!rows.length) return;
  if(typeof collection.bulkWrite==='function'){
    for(let offset=0; offset<rows.length; offset+=500){
      const part=rows.slice(offset,offset+500);
      await collection.bulkWrite(part.map(row=>({
        updateOne:{ filter:keyFor(row), update:{ $set:row }, upsert:true }
      })), { ordered:false });
    }
    return;
  }
  for(const row of rows) await collection.updateOne(keyFor(row), { $set:row }, { upsert:true });
}
async function countQuery(collection, query){
  if(typeof collection.countDocuments==='function')return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
async function cloneDataset(db, source, targetSnapshotId){
  const sourceHeaders=await db.collection(source.headerCollection).find(source.headerQuery).toArray();
  const sourceLines=await db.collection(source.lineCollection).find(source.lineQuery).toArray();
  const clonedAt=new Date();
  const headers=sourceHeaders.map(({ _id, ...row })=>({ ...row, snapshotId:targetSnapshotId, datasetSnapshotId:targetSnapshotId, clonedAt, clonedFromSnapshotId:source.snapshotId||'', updatedAt:clonedAt }));
  const lines=sourceLines.map(({ _id, ...row })=>({ ...row, snapshotId:targetSnapshotId, datasetSnapshotId:targetSnapshotId, clonedAt, clonedFromSnapshotId:source.snapshotId||'', updatedAt:clonedAt }));
  await writeRows(db.collection(DATASET_HEADERS), headers, row=>({ snapshotId:targetSnapshotId, invTyp:row.invTyp, invNo:row.invNo }));
  await writeRows(db.collection(DATASET_LINES), lines, row=>({ snapshotId:targetSnapshotId, saleInvoiceType:row.saleInvoiceType, saleInvoiceNo:row.saleInvoiceNo, row:row.row }));
  return {
    validationScope:'sale-type2',
    headerCount:headers.filter(row=>Number(row.invTyp)===2).length,
    lineCount:lines.filter(row=>Number(row.saleInvoiceType)===2).length,
    allHeaderCount:headers.length,
    allLineCount:lines.length
  };
}
async function activeDataset(db){
  const states=await db.collection('saleSnapshotState').find(
    { activeSnapshotId:{ $exists:true, $ne:'' } }
  ).sort({ activatedAt:-1, updatedAt:-1 }).limit(50).toArray().catch(()=>[]);
  for(const state of states){
    const snapshot=await db.collection('saleSnapshots').findOne({ snapshotId:state.activeSnapshotId }).catch(()=>null);
    if(snapshot?.status==='completed'){
      return {
        snapshotId:state.activeSnapshotId,
        scopeKey:state.scopeKey,
        status:'active',
        source:'versioned-active-snapshot',
        headerCollection:DATASET_HEADERS,
        lineCollection:DATASET_LINES,
        headerQuery:{ snapshotId:state.activeSnapshotId },
        lineQuery:{ snapshotId:state.activeSnapshotId },
        state,
        snapshot
      };
    }
  }
  return {
    snapshotId:'',
    scopeKey:'',
    status:'legacy_unversioned',
    source:'legacy-unversioned-fallback',
    headerCollection:LEGACY_HEADERS,
    lineCollection:LEGACY_LINES,
    headerQuery:{},
    lineQuery:{}
  };
}
function retryablePageError(error){
  const value=clean(error).toLowerCase();
  return /timeout|timed out|econnreset|econnrefused|socket|network|fetch|transport|429|5\d\d|temporar/.test(value);
}
function pageErrorCategory(error, status=0){
  const value=clean(error).toLowerCase();
  if(/timeout|timed out/.test(value))return 'REQUEST_TIMEOUT';
  if(/401|403|token|auth|unauthor/.test(value)||[401,403].includes(Number(status)))return 'AUTHENTICATION';
  if(/econnreset|econnrefused|socket|network|fetch|transport/.test(value))return 'TRANSPORT';
  if(Number(status)>=500)return 'SHAYGAN_SERVER_ERROR';
  if(Number(status)>=400)return 'SHAYGAN_ERROR_RESPONSE';
  return 'SHAYGAN_REQUEST_ERROR';
}
function waitMs(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

function knownMainGroupName(code){
  const c=clean(code);
  const map={ '1':'Notebook', '01':'Notebook' };
  return map[c] || (c ? `گروه اصلی ${c}` : 'نامشخص');
}
function deriveMainGroupFromCode(itemCode){
  const s=clean(itemCode);
  const c=s ? s.slice(0,1) : '';
  return { mainGroupCode:c, mainGroupName:knownMainGroupName(c), mainGroup:c ? `${c} - ${knownMainGroupName(c)}` : 'نامشخص', source:'item-code-prefix-fallback' };
}
async function loadMainGroupMap(db, itemCodes=[]){
  const codes=[...new Set((itemCodes||[]).map(clean).filter(Boolean))];
  const map=new Map();
  const cols=['itemInventoryCatalog','itemCatalogAll','itemCatalog'];
  for(const col of cols){
    try{
      const docs=await db.collection(col).find({ $or:[ { itemCode:{ $in:codes } }, { ItemCode:{ $in:codes } }, { 'raw.ItemCode':{ $in:codes } } ] }).limit(Math.max(1,codes.length||1)).toArray();
      for(const d of docs||[]){
        const raw=d.raw||d;
        const code=clean(d.itemCode||d.ItemCode||raw.ItemCode||raw.ItemNumber||'');
        if(!code || map.has(code)) continue;
        const gcode=clean(raw.ItemMainGroupCode||raw.MainGroupCode||raw.ProductMainGroupCode||d.mainGroupCode||'');
        const gname=clean(raw.ItemMainGroupName||raw.MainGroupName||raw.ProductMainGroupName||d.mainGroupName||'') || knownMainGroupName(gcode);
        if(gcode) map.set(code,{ mainGroupCode:gcode, mainGroupName:gname, mainGroup:`${gcode} - ${gname}`, source:col });
      }
    }catch{}
  }
  for(const c of codes) if(!map.has(c)) map.set(c, deriveMainGroupFromCode(c));
  return map;
}

async function getSellerMaps(db){
  const byEmployee=new Map(); const byCashbox=new Map();
  try{
    const maps=await db.collection('userShayganMappings').find({}).toArray();
    for(const m of maps||[]){
      const fullName=clean(m.fullName || m.employeeAccountName || m.username || m.cashboxAccountName || '');
      const rec={
        username: clean(m.username||''),
        sellerName: fullName,
        sellerAccountNumber: clean(m.employeeAccountNumber||''),
        sellerAccountName: clean(m.employeeAccountName||fullName||''),
        cashboxAccountNumber: clean(m.cashboxAccountNumber||''),
        cashboxAccountName: clean(m.cashboxAccountName||''),
        storeName: clean(m.storeName||'')
      };
      if(rec.sellerAccountNumber) byEmployee.set(rec.sellerAccountNumber, rec);
      if(rec.cashboxAccountNumber) byCashbox.set(rec.cashboxAccountNumber, rec);
    }
  }catch{}
  return { byEmployee, byCashbox };
}
function resolveSellerForInvoice(inv, maps){
  const sellerNo=invSellerAccountNo(inv);
  const cashNo=invAccountNo(inv);
  const m = (sellerNo && maps?.byEmployee?.get(sellerNo)) || (cashNo && maps?.byCashbox?.get(cashNo)) || null;
  if(m) return { ...m, sellerAccountNumber: sellerNo || m.sellerAccountNumber, rawSellerAccountName: invSellerAccountName(inv), mappingStatus:'mapped', mappingSource:sellerNo && maps?.byEmployee?.get(sellerNo) ? 'employeeAccountNumber' : 'cashboxAccountNumber' };
  return { username:'', sellerName: invSellerAccountName(inv) || (sellerNo ? `نماینده ${sellerNo}` : 'نامشخص'), sellerAccountNumber:sellerNo, sellerAccountName:invSellerAccountName(inv), cashboxAccountNumber:cashNo, cashboxAccountName:invAccountName(inv), storeName:'', rawSellerAccountName:invSellerAccountName(inv), mappingStatus:'unmapped', mappingSource:'shaygan-raw-fallback' };
}

function saleHeaderDoc(inv, snapshotIdValue, sellerMaps){
  const typ = Number(inv.InvTyp || inv.InvoiceType || 0);
  const seller = resolveSellerForInvoice(inv, sellerMaps || {});
  return {
    snapshotId: snapshotIdValue,
    invNo: invNo(inv),
    invTyp: typ,
    invTypeLabel: invTypeLabel(typ),
    // Invoice/Get accepts a Jalali filter but returns Gregorian invoice dates.
    // Persist the accounting date in the canonical Jalali YYYYMMDD form while
    // retaining the untouched response value for audit.
    invDate: saleDate8(invDate(inv), 'InvDate'),
    invDateRaw: invDate(inv),
    createdDate: clean(inv.CreatedDate || ''),
    guId: invGuid(inv),
    accountNumber: invAccountNo(inv),
    accountName: invAccountName(inv),
    // In Shaygan sale invoices AccountName can be cashbox/customer depending on InvTyp/workflow. Keep raw fields.
    cashboxAccountNumber: invAccountNo(inv),
    cashboxAccountName: invAccountName(inv),
    sellerAccountNumber: seller.sellerAccountNumber,
    sellerAccountName: seller.sellerAccountName || seller.sellerName,
    sellerName: seller.sellerName || seller.sellerAccountName || 'نامشخص',
    sellerUsername: seller.username || '',
    sellerStoreName: seller.storeName || '',
    sellerMappingStatus: seller.mappingStatus || 'unmapped',
    sellerMappingSource: seller.mappingSource || 'shaygan-raw-fallback',
    mappedCashboxAccountNumber: seller.cashboxAccountNumber || '',
    mappedCashboxAccountName: seller.cashboxAccountName || '',
    firstIssuerUsername: invIssuerFirst(inv),
    lastIssuerUsername: invIssuerLast(inv),
    generalRef: invGeneralRef(inv),
    totalAmount: invTotal(inv),
    expenseTotal: Array.isArray(inv.Expense) ? inv.Expense.reduce((s,x)=>s+num(x.InvExpRowAmount||0),0) : 0,
    rowCount: invBody(inv).length,
    syncedAt: new Date(),
    source: 'shaygan-invoice-get-type2-rowcount20-sale-snapshot'
  };
}
function saleLineDocs(inv, snapshotIdValue, sellerMaps, groupMap){
  const header=saleHeaderDoc(inv, snapshotIdValue, sellerMaps);
  return invBody(inv).map((x,i)=>{
    const qty=lineQty(x); const amount=lineAmount(x); const unit=lineUnitPrice(x) || (qty ? amount/qty : 0);
    const group=(groupMap && groupMap.get(lineItemCode(x))) || deriveMainGroupFromCode(lineItemCode(x));
    return {
      snapshotId: snapshotIdValue,
      saleLineId: `SL-${header.invTyp}-${header.invNo}-${String(i+1).padStart(3,'0')}-${lineItemCode(x)}`,
      saleInvoiceNo: header.invNo,
      saleInvoiceType: header.invTyp,
      saleInvoiceTypeLabel: header.invTypeLabel,
      saleDate: header.invDate,
      createdDate: header.createdDate,
      saleGuid: header.guId,
      accountNumber: header.accountNumber,
      accountName: header.accountName,
      cashboxAccountNumber: header.cashboxAccountNumber,
      cashboxAccountName: header.cashboxAccountName,
      sellerAccountNumber: header.sellerAccountNumber,
      sellerAccountName: header.sellerAccountName,
      sellerName: header.sellerName,
      sellerUsername: header.sellerUsername,
      sellerStoreName: header.sellerStoreName,
      sellerMappingStatus: header.sellerMappingStatus,
      sellerMappingSource: header.sellerMappingSource,
      firstIssuerUsername: header.firstIssuerUsername,
      lastIssuerUsername: header.lastIssuerUsername,
      generalRef: header.generalRef,
      row: i+1,
      lineItemId: num(x.LineItemId || x.LineId || 0,0),
      itemCode: lineItemCode(x),
      itemName: lineItemName(x),
      mainGroupCode: group.mainGroupCode,
      mainGroupName: group.mainGroupName,
      mainGroup: group.mainGroup,
      mainGroupSource: group.source,
      itemGuid: clean(x.ItemGuId || x.ItemGuid || x.itemGuid || ''),
      stockNumber: clean(x.STNumber || x.StoreNumber || x.StockNumber || ''),
      stockName: clean(x.STDesc || x.StoreName || x.StockName || ''),
      qty,
      unitSale: unit,
      saleValue: amount || qty*unit,
      raw: x,
      syncedAt: new Date()
    };
  }).filter(x=>x.itemCode && x.qty>0);
}

async function dropLegacyUniqueIndexes(db){
  try{
    const hidx = await db.collection('saleInvoiceHeaders').indexes();
    for(const ix of hidx){
      const k = JSON.stringify(ix.key || {});
      if(ix.unique && k === JSON.stringify({ invNo:1 })) await db.collection('saleInvoiceHeaders').dropIndex(ix.name).catch(()=>{});
    }
  }catch{}
  try{
    const lidx = await db.collection('saleInvoiceLines').indexes();
    for(const ix of lidx){
      const k = JSON.stringify(ix.key || {});
      if(ix.unique && k === JSON.stringify({ saleInvoiceNo:1, row:1 })) await db.collection('saleInvoiceLines').dropIndex(ix.name).catch(()=>{});
    }
  }catch{}
}

async function ensureIndexes(db){
  const names=['saleSnapshots',LEGACY_HEADERS,LEGACY_LINES,DATASET_HEADERS,DATASET_LINES,'saleSnapshotDiagnostics','saleSnapshotState'];
  const existing=new Set((await db.listCollections().toArray()).map(x=>x.name));
  for(const n of names) if(!existing.has(n)) await db.createCollection(n).catch(()=>{});
  await dropLegacyUniqueIndexes(db);
  await db.collection('saleSnapshots').createIndex({ snapshotId:1 }, { unique:true });
  await db.collection('saleSnapshots').createIndex({ createdAt:-1 });
  await db.collection('saleInvoiceHeaders').createIndex({ invTyp:1, invNo:1 }, { unique:true });
  await db.collection('saleInvoiceHeaders').createIndex({ snapshotId:1, invDate:1 });
  await db.collection('saleInvoiceLines').createIndex({ saleInvoiceType:1, saleInvoiceNo:1, row:1 }, { unique:true });
  await db.collection('saleInvoiceLines').createIndex({ snapshotId:1, itemCode:1 });
  await db.collection('saleInvoiceLines').createIndex({ itemCode:1, saleDate:1 });
  await db.collection('saleInvoiceLines').createIndex({ sellerAccountNumber:1, saleDate:1 });
  await db.collection('saleInvoiceLines').createIndex({ sellerAccountNumber:1, mainGroupCode:1, saleDate:1 });
  await db.collection('saleInvoiceHeaders').createIndex({ sellerAccountNumber:1, invDate:1 });
  await db.collection(DATASET_HEADERS).createIndex({ snapshotId:1, invTyp:1, invNo:1 }, { unique:true });
  await db.collection(DATASET_HEADERS).createIndex({ snapshotId:1, sellerAccountNumber:1, invDate:1 });
  await db.collection(DATASET_LINES).createIndex({ snapshotId:1, saleInvoiceType:1, saleInvoiceNo:1, row:1 }, { unique:true });
  await db.collection(DATASET_LINES).createIndex({ snapshotId:1, itemCode:1, saleDate:1 });
  await db.collection(DATASET_LINES).createIndex({ snapshotId:1, sellerAccountNumber:1, saleDate:1 });
  await db.collection(DATASET_LINES).createIndex({ snapshotId:1, sellerAccountNumber:1, mainGroupCode:1, saleDate:1 });
  await db.collection('saleSnapshotDiagnostics').createIndex({ snapshotId:1, at:-1 });
  await db.collection('saleSnapshotState').createIndex({ scopeKey:1 }, { unique:true });
  await db.collection('saleSnapshotState').createIndex({ activeSnapshotId:1, activatedAt:-1 });
}

async function init(db){ await ensureIndexes(db); return { ok:true, version:VERSION }; }

function saleInvoicesOnly(rows, typ=2){
  return (Array.isArray(rows)?rows:[]).filter(inv=>Number(inv.InvTyp || inv.InvoiceType || 0)===Number(typ));
}

async function buildSaleSnapshot(db, opts={}){
  await ensureIndexes(db);
  const startedAtMs=Date.now();
  const jobControl=opts.jobControl;
  const progress=(phase,current,total,message)=>jobControl?.progress?.({phase,current,total,message});
  const checkpoint=()=>{ jobControl?.heartbeat?.(); jobControl?.checkCancellation?.(); };
  progress('Resolving Salespeople and Cashiers',0,1,'Loading salesperson and cashier mappings');
  checkpoint();
  const requestedResumeId=clean(opts.resumeSnapshotId||'');
  const resumedSnapshot=requestedResumeId
    ? await db.collection('saleSnapshots').findOne({ snapshotId:requestedResumeId })
    : null;
  if(requestedResumeId && !resumedSnapshot){
    return { ok:false, code:'SNAPSHOT_NOT_FOUND', error:'Sale Snapshot موردنظر برای ادامه پیدا نشد.', snapshotId:requestedResumeId };
  }
  if(resumedSnapshot && resumedSnapshot.candidateStorage!=='isolated'){
    return { ok:false, code:'LEGACY_SNAPSHOT_NOT_RESUMABLE', error:'این Snapshot با معماری قدیمی ساخته شده و Candidate ایزوله قابل ادامه ندارد. یک اجرای Incremental امن برای بازیابی بسازید.', snapshotId:requestedResumeId };
  }
  if(resumedSnapshot && !['completed_with_errors','failed','cancelled'].includes(clean(resumedSnapshot.status))){
    return { ok:false, code:'SNAPSHOT_NOT_RESUMABLE', error:`Snapshot با وضعیت ${clean(resumedSnapshot.status)||'نامشخص'} قابل ادامه نیست.`, snapshotId:requestedResumeId };
  }
  const sid=resumedSnapshot?.snapshotId || snapshotId(); const now=new Date();
  const { dateFrom, dateTo }=normalizeJalaliRange({
    dateFrom: resumedSnapshot?.dateFrom || opts.dateFrom || '14050101',
    dateTo: resumedSnapshot?.dateTo || opts.dateTo || ''
  }, { requireFrom:true });
  const pageSize=Math.max(1, Math.min(Number(resumedSnapshot?.pageSize || opts.pageSize || 20), 20));
  const maxPages=Math.max(1, Math.min(Number(opts.maxPages || resumedSnapshot?.maxPages || 1000), 10000));
  const maxPageAttempts=Math.max(1,Math.min(Number(opts.maxPageAttempts||resumedSnapshot?.maxPageAttempts||DEFAULT_PAGE_ATTEMPTS),5));
  const reset = resumedSnapshot ? !resumedSnapshot.incremental : (opts.reset === true || opts.reset === 'true' || opts.mode === 'full');
  const scopeKey = resumedSnapshot?.scopeKey || scopeKeyFor(dateFrom, dateTo);
  const mode=reset?'full-sale-type2-scan':'new-sale-type2-by-invno';
  const sellerMaps = await getSellerMaps(db);
  checkpoint();
  const previousActive=await activeDataset(db);
  let datasetBaseCounts=resumedSnapshot?.datasetBaseCounts||{ headerCount:0, lineCount:0 };
  if(resumedSnapshot?.incremental && datasetBaseCounts.validationScope!=='sale-type2'){
    datasetBaseCounts={
      validationScope:'sale-type2',
      headerCount:await countQuery(db.collection(DATASET_HEADERS),{ snapshotId:sid, invTyp:2, clonedAt:{ $exists:true } }),
      lineCount:await countQuery(db.collection(DATASET_LINES),{ snapshotId:sid, saleInvoiceType:2, clonedAt:{ $exists:true } }),
      allHeaderCount:await countQuery(db.collection(DATASET_HEADERS),{ snapshotId:sid, clonedAt:{ $exists:true } }),
      allLineCount:await countQuery(db.collection(DATASET_LINES),{ snapshotId:sid, clonedAt:{ $exists:true } })
    };
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ datasetBaseCounts, updatedAt:new Date() } });
  }
  if(!resumedSnapshot){
    const snap={ snapshotId:sid, version:VERSION, datasetSchemaVersion:1, candidateStorage:'isolated', status:'running', activationStatus:'candidate', dateFrom, dateTo, pageSize, maxPages, maxPageAttempts, incremental:!reset, mode, scopeKey, createdAt:now, updatedAt:now, invoiceHeadersFound:0, invoiceBodiesLoaded:0, saleLinesParsed:0, emptyBodyInvoices:0, errors:[], failedPages:[], retryCount:0, resumeCount:0 };
    await db.collection('saleSnapshots').insertOne(snap);
    if(!reset){
      progress('Preparing Isolated Dataset',0,1,'Copying the active read-only dataset into an incremental successor');
      checkpoint();
      datasetBaseCounts=await cloneDataset(db, previousActive, sid);
      await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ datasetBaseCounts, baseSnapshotId:previousActive.snapshotId||'', baseSource:previousActive.source, updatedAt:new Date() } });
    }
  }else{
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ status:'running', activationStatus:'candidate', maxPages, maxPageAttempts, resumeCount:Number(resumedSnapshot.resumeCount||0)+1, resumedAt:now, updatedAt:now } });
  }

  const errors=[]; const samples=Array.isArray(resumedSnapshot?.samples)?resumedSnapshot.samples.slice(0,20):[];
  const counterNames=['insertedHeaders','updatedHeaders','insertedLines','updatedLines','removedOrReconciledLines','duplicatePrevented','unmappedSellerInvoices','groupFallbackLines','amountMismatchInvoices'];
  const counters=Object.fromEntries(counterNames.map(name=>[name,Number(resumedSnapshot?.[name]||0)]));
  let headersFound=Number(resumedSnapshot?.invoiceHeadersFound||0);
  let bodiesLoaded=Number(resumedSnapshot?.invoiceBodiesLoaded||0);
  let linesParsed=Number(resumedSnapshot?.saleLinesParsed||0);
  let emptyBody=Number(resumedSnapshot?.emptyBodyInvoices||0);
  let detailFetched=Number(resumedSnapshot?.detailFetched||0);
  let pagesScanned=Number(resumedSnapshot?.pagesScanned||0);
  let retryCount=Number(resumedSnapshot?.retryCount||0);
  let startInvNo=Number(resumedSnapshot?.startInvNo||0);
  let endInvNo=Number(resumedSnapshot?.endInvNo||0);
  let nextRowStart=Number(resumedSnapshot?.nextRowStart||0);
  let lastSuccessfulPage=Number.isInteger(resumedSnapshot?.lastSuccessfulPage)?Number(resumedSnapshot.lastSuccessfulPage):-1;
  let failedPages=Array.isArray(resumedSnapshot?.failedPages)?resumedSnapshot.failedPages.slice(0,100):[];
  let pageDiagnostics=Array.isArray(resumedSnapshot?.pageDiagnostics)?resumedSnapshot.pageDiagnostics.slice(-200):[];
  const typeStats=resumedSnapshot?.typeStats
    ? structuredClone(resumedSnapshot.typeStats)
    : { '2': { label:'Sale', invoices:0, lines:0, amount:0, startInvNo:0, nextInvNoFrom:0, pagesScanned:0, reachedEnd:false } };
  typeStats['2']={ label:'Sale', invoices:0, lines:0, amount:0, startInvNo:0, nextInvNoFrom:0, pagesScanned:0, reachedEnd:false, ...(typeStats['2']||{}) };
  const sellerStatsMap = new Map((resumedSnapshot?.sellerStats||[]).map(value=>[value.key,value]));

  async function processInvoice(inv, pageGroupMap){
    const no=invNo(inv); if(!no) return;
    const typ=Number(inv.InvTyp || inv.InvoiceType || 0);
    const body=invBody(inv);
    headersFound += 1;
    if(body.length) bodiesLoaded++; else emptyBody++;
    const h=saleHeaderDoc(inv, sid, sellerMaps);
    if(h.sellerMappingStatus!=='mapped') counters.unmappedSellerInvoices++;
    const headerWrite=await db.collection(DATASET_HEADERS).updateOne(
      { snapshotId:sid, invTyp:h.invTyp, invNo:h.invNo },
      { $set:{ ...h, lastSnapshotId:sid, updatedAt:new Date() }, $setOnInsert:{ firstSyncedAt:new Date() } },
      { upsert:true }
    );
    if(Number(headerWrite.upsertedCount||0)>0) counters.insertedHeaders++; else { counters.updatedHeaders++; counters.duplicatePrevented++; }
    const lines=saleLineDocs(inv, sid, sellerMaps, pageGroupMap);
    linesParsed += lines.length;
    counters.groupFallbackLines += lines.filter(x=>x.mainGroupSource==='item-code-prefix-fallback').length;
    const lineAmountTotal=lines.reduce((sum,line)=>sum+num(line.saleValue,0),0);
    if(Math.abs(num(h.totalAmount,0)-lineAmountTotal)>AMOUNT_TOLERANCE_RIAL) counters.amountMismatchInvoices++;
    if(typeStats[String(h.invTyp)]){ typeStats[String(h.invTyp)].invoices += 1; typeStats[String(h.invTyp)].lines += lines.length; typeStats[String(h.invTyp)].amount += Number(h.totalAmount||0); }
    const skey = h.sellerAccountNumber || h.sellerName || h.accountName || 'UNKNOWN';
    const ss = sellerStatsMap.get(skey) || { key:skey, sellerAccountNumber:h.sellerAccountNumber, sellerAccountName:h.sellerAccountName, sellerName:h.sellerName, sellerUsername:h.sellerUsername, sellerStoreName:h.sellerStoreName, cashboxAccountName:h.cashboxAccountName, invoices:0, lines:0, amount:0 };
    ss.invoices += 1; ss.lines += lines.length; ss.amount += Number(h.totalAmount||0);
    sellerStatsMap.set(skey, ss);
    for(const line of lines){
      const lineWrite=await db.collection(DATASET_LINES).updateOne(
        { snapshotId:sid, saleInvoiceType:line.saleInvoiceType, saleInvoiceNo:line.saleInvoiceNo, row:line.row },
        { $set:{ ...line, lastSnapshotId:sid, updatedAt:new Date() }, $setOnInsert:{ firstSyncedAt:new Date() } },
        { upsert:true }
      );
      if(Number(lineWrite.upsertedCount||0)>0) counters.insertedLines++; else { counters.updatedLines++; counters.duplicatePrevented++; }
    }
    if(lines.length){
      const reconciled=await db.collection(DATASET_LINES).deleteMany({ snapshotId:sid, saleInvoiceType:h.invTyp, saleInvoiceNo:h.invNo, row:{ $nin:lines.map(x=>x.row) } });
      counters.removedOrReconciledLines += Number(reconciled.deletedCount||0);
    }
    endInvNo=Math.max(endInvNo,Number(h.invNo||0));
    if(samples.length<20) samples.push({ invTyp:h.invTyp, invTypeLabel:h.invTypeLabel, invNo:h.invNo, invDate:h.invDate, accountName:h.accountName, sellerAccountNumber:h.sellerAccountNumber, sellerAccountName:h.sellerAccountName, sellerName:h.sellerName, sellerUsername:h.sellerUsername, generalRef:h.generalRef, rowCount:body.length, saleLines:lines.length, totalAmount:h.totalAmount });
  }

  try{
    const startNoByType={ ...(resumedSnapshot?.startNoByType||{}) };
    for(const typ of [2]){
      const key=String(typ);
      const committedState=await db.collection('saleSnapshotState').findOne({ scopeKey }).catch(()=>null);
      let committedNo=Number(committedState?.latestType2||previousActive.state?.latestType2||0);
      if(!reset && !committedNo){
        const newest=await db.collection(previousActive.headerCollection).findOne(
          { ...previousActive.headerQuery, invTyp:2 },
          { sort:{ invNo:-1 } }
        ).catch(()=>null);
        committedNo=Number(newest?.invNo||0);
      }
      const lastNo = resumedSnapshot ? Number(resumedSnapshot.startInvNo||0) : (reset ? 0 : committedNo);
      const invNoFrom = clean(resumedSnapshot?.invNoFrom || (lastNo > 0 ? String(lastNo + 1) : ''));
      startInvNo=lastNo; if(!resumedSnapshot)endInvNo=lastNo;
      startNoByType[key]=lastNo;
      typeStats[key].startInvNo=lastNo;
      typeStats[key].nextInvNoFrom=lastNo+1;
      let typeReachedEnd=false;
      const firstPage=Math.floor(nextRowStart/pageSize);
      for(let page=firstPage,rowStart=nextRowStart; page<maxPages; page++, rowStart+=pageSize){
        progress('Reading Sale Invoices',page,maxPages,`Candidate ${sid} | page ${page+1} | rowStart ${rowStart}`);
        checkpoint();
        let r={ok:false,error:'Invoice/Get was not attempted',result:[]};
        let attempts=0;
        const attemptDiagnostics=[];
        for(; attempts<maxPageAttempts; attempts++){
          const attemptStartedAt=Date.now();
          r=await shaygan.getInvoicePageByTypeNumberRange(rowStart, typ, invNoFrom, '', dateFrom, dateTo, pageSize).catch(e=>({ok:false,error:String(e.message||e),result:[]}));
          attemptDiagnostics.push({ attempt:attempts+1, ok:!!r.ok, durationMs:Date.now()-attemptStartedAt, status:Number(r.status||r.statusCode||0)||null, category:r.ok?'OK':pageErrorCategory(r.error,r.status||r.statusCode), error:r.ok?'':safeError(r.error), at:new Date() });
          if(r.ok) break;
          const retryable=retryablePageError(r.error);
          if(!retryable || attempts+1>=maxPageAttempts) break;
          retryCount++;
          await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ updatedAt:new Date(), retryCount, lastRetry:{ page, rowStart, attempt:attempts+1, category:pageErrorCategory(r.error,r.status||r.statusCode), error:safeError(r.error), at:new Date() } } });
          await waitMs(Math.min(2000,250*(2**attempts)));
          checkpoint();
        }
        pagesScanned++; typeStats[key].pagesScanned++;
        if(!r.ok){
          const failure={ stage:'sale-invoice-page', category:pageErrorCategory(r.error,r.status||r.statusCode), typ, page, rowStart, invNoFrom, dateFrom, dateTo, rowCount:pageSize, attempts:attempts+1, attemptDiagnostics, status:Number(r.status||r.statusCode||0)||null, retryable:retryablePageError(r.error), error:safeError(r.error||`Invoice/Get type ${typ} page failed`), at:new Date() };
          errors.push(failure);
          failedPages=[...failedPages.filter(x=>Number(x.rowStart)!==rowStart),failure].slice(-100);
          pageDiagnostics=[...pageDiagnostics,{ page, rowStart, ok:false, attemptDiagnostics, at:new Date() }].slice(-200);
          nextRowStart=rowStart;
          break;
        }
        pageDiagnostics=[...pageDiagnostics,{ page, rowStart, ok:true, rowCount:Array.isArray(r.result)?r.result.length:0, attemptDiagnostics, at:new Date() }].slice(-200);
        failedPages=failedPages.filter(x=>Number(x.rowStart)!==rowStart);
        lastSuccessfulPage=page;
        nextRowStart=rowStart+pageSize;
        const rawRows=Array.isArray(r.result)?r.result:[];
        if(!rawRows.length){ typeReachedEnd=true; typeStats[key].reachedEnd=true; break; }
        const rows=saleInvoicesOnly(rawRows,typ);
        if(!rows.length) continue;
        const pageItemCodes=[]; for(const inv of rows){ for(const b of invBody(inv)) pageItemCodes.push(lineItemCode(b)); }
        const pageGroupMap=await loadMainGroupMap(db, pageItemCodes);
        for(let index=0; index<rows.length; index++){
          await processInvoice(rows[index], pageGroupMap);
          if((index+1)%10===0 || index===rows.length-1) checkpoint();
        }
        // Do not stop on short pages. Shaygan sometimes returns short pages before the real end.
        await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ updatedAt:new Date(), pagesScanned, retryCount, failedPages, pageDiagnostics, lastSuccessfulPage, nextRowStart, startNoByType, startInvNo, endInvNo, invNoFrom, nextInvNo:endInvNo+1, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, ...counters, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100) } });
      }
      if(!typeReachedEnd && nextRowStart>=maxPages*pageSize && !errors.length) errors.push({ stage:'max-pages-reached', typ, maxPages, nextRowStart, note:'برای خواندن ادامه، maxPages را بالاتر بگذار و همین Snapshot را Resume کن.' });
    }

    progress('Calculating Snapshot',1,1,'Finalizing Sale Snapshot counters');
    checkpoint();
    const reachedEnd = !!(typeStats['2'] && typeStats['2'].reachedEnd);
    const validationHeaders=await db.collection(DATASET_HEADERS).find({ snapshotId:sid, invTyp:2 }).toArray();
    const validationLines=await db.collection(DATASET_LINES).find({ snapshotId:sid, saleInvoiceType:2 }).toArray();
    const datasetHeaderCount=validationHeaders.length;
    const datasetLineCount=validationLines.length;
    const uniqueHeaderCount=new Set(validationHeaders.map(row=>`${row.invTyp}-${row.invNo}`)).size;
    const uniqueLineCount=new Set(validationLines.map(row=>`${row.saleInvoiceType}-${row.saleInvoiceNo}-${row.row}`)).size;
    const validation={
      valid:false,
      reachedEnd,
      noErrors:errors.length===0,
      noFailedPages:failedPages.length===0,
      headerCount:datasetHeaderCount,
      lineCount:datasetLineCount,
      duplicateHeaderCount:datasetHeaderCount-uniqueHeaderCount,
      duplicateLineCount:datasetLineCount-uniqueLineCount,
      duplicatesAbsent:datasetHeaderCount===uniqueHeaderCount&&datasetLineCount===uniqueLineCount,
      bodyAccountingMatches:headersFound===bodiesLoaded+emptyBody,
      preservesIncrementalBase:reset || (datasetHeaderCount>=Number(datasetBaseCounts.headerCount||0) && datasetLineCount>=Number(datasetBaseCounts.lineCount||0)),
      checkedAt:new Date()
    };
    validation.valid=validation.reachedEnd&&validation.noErrors&&validation.noFailedPages&&validation.headerCount>0&&validation.lineCount>0&&validation.duplicatesAbsent&&validation.bodyAccountingMatches&&validation.preservesIncrementalBase;
    if(!validation.valid && errors.length===0) errors.push({ stage:'snapshot-validation', code:'SNAPSHOT_VALIDATION_FAILED', validation });
    progress('Saving Snapshot',0,1,'Saving final Sale Snapshot');
    checkpoint();
    const successful=validation.valid;
    const previousActiveSnapshotId=previousActive.snapshotId||'';
    if(successful){
      await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ status:'completed', activationStatus:'validated', validation, finishedAt:new Date(), updatedAt:new Date() } });
      const activatedAt=new Date();
      await db.collection('saleSnapshotState').updateOne({ scopeKey }, { $set:{ scopeKey, dateFrom, dateTo, reachedEnd, updatedAt:activatedAt, activatedAt, activeSnapshotId:sid, activeSnapshotStatus:'completed', previousActiveSnapshotId, lastSnapshotId:sid, lastHeadersFound:datasetHeaderCount, lastLinesParsed:datasetLineCount, latestType2:endInvNo, nextInvNo:endInvNo+1, invoiceTypes:{ sale:2, buy:3, saleReturn:6, purchaseReturn:7 } } }, { upsert:true });
      await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ activationStatus:'active', activatedAt, previousActiveSnapshotId, updatedAt:activatedAt } });
      if(previousActiveSnapshotId && previousActiveSnapshotId!==sid){
        await db.collection('saleSnapshots').updateOne({ snapshotId:previousActiveSnapshotId, activationStatus:'active' }, { $set:{ activationStatus:'superseded', supersededAt:activatedAt, supersededBySnapshotId:sid, updatedAt:activatedAt } });
      }
    }
    const status=successful?'completed':'completed_with_errors';
    const durationMs=Date.now()-startedAtMs;
    const result={ ok:successful, code:successful?'SNAPSHOT_ACTIVATED':'SNAPSHOT_INCOMPLETE', error:successful?'':clean(errors[0]?.error||errors[0]?.code||'Sale Snapshot ناقص است و فعال نشد.'), snapshotId:sid, activeSnapshotId:successful?sid:previousActiveSnapshotId, previousActiveSnapshotId, activationStatus:successful?'active':'rejected', status, incremental:!reset, resumed:!!resumedSnapshot, mode, scopeKey, reachedEnd, startNoByType, startInvNo, endInvNo, invNoFrom:clean(resumedSnapshot?.invNoFrom||(startInvNo>0?String(startInvNo+1):'')), nextInvNo:endInvNo+1, pagesScanned, retryCount, failedPages, pageDiagnostics, lastSuccessfulPage, nextRowStart, datasetBaseCounts, datasetHeaderCount, datasetLineCount, validation, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, ...counters, durationMs, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100), samples };
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ ...result, activationStatus:successful?'active':'rejected', finishedAt:new Date(), updatedAt:new Date() } });
    await db.collection('saleSnapshotDiagnostics').insertOne({ ...result, at:new Date(), version:VERSION, dateFrom, dateTo });
    return { ...result, errors:errors.slice(0,20) };
  }catch(e){
    const status=e?.code==='JOB_CANCELLED'?'cancelled':'failed';
    const durationMs=Date.now()-startedAtMs;
    const error=safeError(e?.message||e);
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ status, activationStatus:'rejected', error, updatedAt:new Date(), finishedAt:new Date(), scopeKey, mode, startInvNo, endInvNo, nextInvNo:endInvNo+1, pagesScanned, retryCount, failedPages, pageDiagnostics, lastSuccessfulPage, nextRowStart, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, ...counters, durationMs, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100) } });
    if(e?.code==='JOB_CANCELLED') throw e;
    return { ok:false, code:'SNAPSHOT_BUILD_FAILED', snapshotId:sid, activeSnapshotId:previousActive.snapshotId||'', activationStatus:'rejected', status, error, incremental:!reset, mode, scopeKey, startInvNo, endInvNo, nextInvNo:endInvNo+1, pagesScanned, retryCount, failedPages, lastSuccessfulPage, nextRowStart, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, ...counters, durationMs, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,20) };
  }
}

async function listSnapshots(db, limit=20){
  await ensureIndexes(db);
  const list=await db.collection('saleSnapshots').find({}).sort({ createdAt:-1 }).limit(Math.max(1,Math.min(Number(limit||20),100))).toArray();
  const active=await activeDataset(db);
  return { ok:true, activeSnapshotId:active.snapshotId, activeSource:active.source, list:list.map(item=>({ ...item, isActive:!!active.snapshotId&&item.snapshotId===active.snapshotId })) };
}
async function status(db, snapshotId=''){
  await ensureIndexes(db);
  const snap=snapshotId ? await db.collection('saleSnapshots').findOne({ snapshotId }) : await db.collection('saleSnapshots').findOne({}, { sort:{ createdAt:-1 } });
  const active=await activeDataset(db);
  if(!snap) return { ok:true, snapshot:null, activeSnapshotId:active.snapshotId, activeSource:active.source };
  const diag=await db.collection('saleSnapshotDiagnostics').findOne({ snapshotId:snap.snapshotId }, { sort:{ at:-1 } }).catch(()=>null);
  return { ok:true, snapshot:{ ...snap, isActive:!!active.snapshotId&&snap.snapshotId===active.snapshotId }, activeSnapshotId:active.snapshotId, activeSource:active.source, activeSnapshot:active.snapshot||null, diagnostics:diag };
}
async function lines(db, filters={}){
  await ensureIndexes(db);
  const { dateFrom, dateTo }=normalizeJalaliRange(filters);
  const requestedSnapshotId=clean(filters.snapshotId||'');
  const source=requestedSnapshotId
    ? { snapshotId:requestedSnapshotId, status:'explicit', source:'versioned-explicit-snapshot', lineCollection:DATASET_LINES, lineQuery:{ snapshotId:requestedSnapshotId } }
    : await activeDataset(db);
  const q={ ...source.lineQuery };
  if(filters.itemCode) q.itemCode=clean(filters.itemCode);
  if(filters.sellerAccountNumber) q.sellerAccountNumber=clean(filters.sellerAccountNumber);
  const limit=Math.max(1,Math.min(Number(filters.limit||500),5000));
  const rows=await db.collection(source.lineCollection).find(q).sort({ saleInvoiceNo:-1, row:1 }).limit(limit).toArray();
  const list=rows
    .map(row=>({ ...row, saleDate:saleDate8(row.saleDate) }))
    .filter(row=>(!dateFrom||row.saleDate>=dateFrom)&&(!dateTo||row.saleDate<=dateTo))
    .sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate))||num(b.saleInvoiceNo)-num(a.saleInvoiceNo)||num(a.row)-num(b.row));
  return { ok:true, snapshotId:source.snapshotId, snapshotStatus:source.status, source:source.source, list };
}


async function sellerPerformance(db, filters={}){
  await ensureIndexes(db);
  const saleSource=await activeDataset(db);
  const seller=clean(filters.sellerAccountNumber || filters.seller || '');
  const q={ ...saleSource.lineQuery, saleInvoiceType: 2 };
  if(seller) q.sellerAccountNumber=seller;
  if(filters.store) q.sellerStoreName={ $regex:clean(filters.store).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), $options:'i' };
  const { dateFrom, dateTo }=normalizeJalaliRange(filters);
  const reportScanLimit=Math.max(1,Math.min(Number(filters.limit||250000),500000));
  const sourceLines=await db.collection(saleSource.lineCollection).find(q).sort({ saleInvoiceNo:1, row:1 }).limit(reportScanLimit).toArray();
  const lines=sourceLines
    .map(line=>({ ...line, saleDate:saleDate8(line.saleDate) }))
    .filter(line=>(!dateFrom||line.saleDate>=dateFrom)&&(!dateTo||line.saleDate<=dateTo))
    .sort((a,b)=>lineDateScoreFromDoc(a)-lineDateScoreFromDoc(b)||num(a.saleInvoiceNo)-num(b.saleInvoiceNo)||num(a.row)-num(b.row));
  const profit=await computeSellerProfitFifo(db, { ...filters, sellerAccountNumber:seller, dateFrom, dateTo, _saleSource:saleSource });
  const invoiceMap=new Map(); const groupMap=new Map(); const sellerMap=new Map(); const itemCodes=new Set();
  let total=0, qty=0;
  for(const l of lines){
    const pk=`${l.saleInvoiceType}-${l.saleInvoiceNo}-${l.row}`; const pr=profit.resultByLine.get(pk)||{};
    total+=num(l.saleValue,0); qty+=num(l.qty,0);
    const ik=`${l.saleInvoiceType}-${l.saleInvoiceNo}`;
    const inv=invoiceMap.get(ik)||{ saleInvoiceType:l.saleInvoiceType, saleInvoiceNo:l.saleInvoiceNo, saleDate:l.saleDate, sellerAccountNumber:l.sellerAccountNumber, sellerName:l.sellerName, sellerUsername:l.sellerUsername, sellerStoreName:l.sellerStoreName, cashboxAccountName:l.cashboxAccountName, accountName:l.accountName, generalRef:l.generalRef, amount:0, fifoCost:0, fifoProfit:0, coveredQty:0, coveredSales:0, qty:0, lines:0, calculatedLines:0, partialLines:0, unknownLines:0, itemCodes:new Set() };
    inv.amount+=num(l.saleValue,0); inv.qty+=num(l.qty,0); inv.lines+=1; inv.fifoCost+=num(pr.fifoCost,0); if(pr.fifoProfit!=null) inv.fifoProfit+=num(pr.fifoProfit,0);
    inv.coveredQty+=num(pr.allocatedQty,0); inv.coveredSales+=num(pr.saleValue,0);
    if(pr.profitStatus==='calculated') inv.calculatedLines++; else if(pr.profitStatus==='partial') inv.partialLines++; else inv.unknownLines++;
    if(l.itemCode) inv.itemCodes.add(l.itemCode); invoiceMap.set(ik,inv);
    const gk=clean(l.mainGroupCode||'__UNKNOWN__'); const g=groupMap.get(gk)||{ mainGroupCode:gk, mainGroup:l.mainGroup||'نامشخص', mainGroupSource:l.mainGroupSource||'', amount:0, fifoCost:0, fifoProfit:0, coveredQty:0, coveredSales:0, lines:0, qty:0, calculatedLines:0, partialLines:0, unknownLines:0, invoices:new Set(), itemCodes:new Set() };
    g.amount+=num(l.saleValue,0); g.fifoCost+=num(pr.fifoCost,0); if(pr.fifoProfit!=null) g.fifoProfit+=num(pr.fifoProfit,0); g.lines+=1; g.qty+=num(l.qty,0);
    g.coveredQty+=num(pr.allocatedQty,0); g.coveredSales+=num(pr.saleValue,0);
    if(pr.profitStatus==='calculated') g.calculatedLines++; else if(pr.profitStatus==='partial') g.partialLines++; else g.unknownLines++;
    g.invoices.add(ik); if(l.itemCode) g.itemCodes.add(l.itemCode); groupMap.set(gk,g);
    const sellerKey=clean(l.sellerAccountNumber||'__UNMAPPED__');
    const sr=sellerMap.get(sellerKey)||{ sellerAccountNumber:sellerKey==='__UNMAPPED__'?'':sellerKey, sellerName:l.sellerName||'نامشخص', sellerUsername:l.sellerUsername||'', sellerStoreName:l.sellerStoreName||'', amount:0, fifoCost:0, fifoProfit:0, coveredQty:0, coveredSales:0, qty:0, lines:0, calculatedLines:0, partialLines:0, unknownLines:0, invoices:new Set(), itemCodes:new Set() };
    sr.amount+=num(l.saleValue,0); sr.qty+=num(l.qty,0); sr.fifoCost+=num(pr.fifoCost,0); if(pr.fifoProfit!=null)sr.fifoProfit+=num(pr.fifoProfit,0); sr.coveredQty+=num(pr.allocatedQty,0); sr.coveredSales+=num(pr.saleValue,0); sr.lines++; sr.invoices.add(ik); if(l.itemCode)sr.itemCodes.add(l.itemCode);
    if(pr.profitStatus==='calculated')sr.calculatedLines++; else if(pr.profitStatus==='partial')sr.partialLines++; else sr.unknownLines++;
    sellerMap.set(sellerKey,sr); if(l.itemCode)itemCodes.add(l.itemCode);
    l.allocatedQty=num(pr.allocatedQty,0); l.coveredSales=num(pr.saleValue,0); l.fifoCost=pr.profitStatus==='unknown'?null:pr.fifoCost; l.fifoProfit=pr.fifoProfit; l.profitStatus=pr.profitStatus||'unknown'; l.profitReason=pr.profitReason||''; l.purchaseAllocations=pr.allocations||[];
  }
  const coverageFor=x=>({ totalLines:x.lines, calculatedLines:x.calculatedLines, partialLines:x.partialLines, unknownLines:x.unknownLines, totalQty:x.qty, coveredQty:x.coveredQty, coveredQtyPercent:x.qty?Math.round(x.coveredQty*10000/x.qty)/100:0, totalSales:Math.round(x.amount), coveredSales:Math.round(x.coveredSales), coveredSalesPercent:x.amount?Math.round(x.coveredSales*10000/x.amount)/100:0, purchaseHistoryComplete:false });
  const statusFor=x=>x.coveredQty>0?'partial':'unknown';
  const invoices=[...invoiceMap.values()].map(x=>{const status=statusFor(x);return { ...x, fifoCost:status==='unknown'?null:Math.round(x.fifoCost), fifoProfit:status==='unknown'?null:Math.round(x.fifoProfit), roiPercent:status!=='unknown'&&x.fifoCost?Math.round(x.fifoProfit*10000/x.fifoCost)/100:null, profitStatus:status, coverage:coverageFor(x), itemCount:x.itemCodes.size, itemCodes:undefined }}).sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate)) || Number(b.saleInvoiceNo)-Number(a.saleInvoiceNo));
  const invoiceOutputLimit=Math.min(Number(filters.invoiceLimit||1000),5000);
  let outputInvoices=invoices.slice(0,invoiceOutputLimit);
  const outputInvoiceNumbers=[...new Set(outputInvoices.map(x=>Number(x.saleInvoiceNo)).filter(Boolean))];
  if(outputInvoiceNumbers.length){
    const headers=await db.collection(saleSource.headerCollection).find({ ...saleSource.headerQuery, invTyp:2, invNo:{ $in:outputInvoiceNumbers } }).limit(outputInvoiceNumbers.length).toArray().catch(()=>[]);
    const headerMap=new Map(headers.map(header=>[`2-${header.invNo}`,header]));
    outputInvoices=outputInvoices.map(inv=>{
      const header=headerMap.get(`2-${inv.saleInvoiceNo}`);
      if(!header)return inv;
      return { ...inv, saleDate:saleDate8(header.invDate||inv.saleDate), sellerAccountNumber:header.sellerAccountNumber||inv.sellerAccountNumber, sellerName:header.sellerName||inv.sellerName, sellerUsername:header.sellerUsername||inv.sellerUsername, sellerStoreName:header.sellerStoreName||inv.sellerStoreName, cashboxAccountName:header.cashboxAccountName||inv.cashboxAccountName, accountName:header.accountName||inv.accountName, generalRef:header.generalRef||inv.generalRef, headerFound:true };
    });
  }
  const groups=[...groupMap.values()].map(g=>{const status=statusFor(g);return { mainGroupCode:g.mainGroupCode==='__UNKNOWN__'?'':g.mainGroupCode, mainGroup:g.mainGroup, mainGroupSource:g.mainGroupSource, amount:Math.round(g.amount), fifoCost:status==='unknown'?null:Math.round(g.fifoCost), fifoProfit:status==='unknown'?null:Math.round(g.fifoProfit), roiPercent:status!=='unknown'&&g.fifoCost?Math.round(g.fifoProfit*10000/g.fifoCost)/100:null, profitStatus:status, coverage:coverageFor(g), lines:g.lines, qty:g.qty, calculatedLines:g.calculatedLines, partialLines:g.partialLines, unknownLines:g.unknownLines, invoiceCount:g.invoices.size, itemCount:g.itemCodes.size }}).sort((a,b)=>b.amount-a.amount);
  const sellers=[...sellerMap.values()].map(s=>{const status=statusFor(s);return { sellerAccountNumber:s.sellerAccountNumber, sellerName:s.sellerName, sellerUsername:s.sellerUsername, sellerStoreName:s.sellerStoreName, amount:Math.round(s.amount), fifoCost:status==='unknown'?null:Math.round(s.fifoCost), fifoProfit:status==='unknown'?null:Math.round(s.fifoProfit), roiPercent:status!=='unknown'&&s.fifoCost?Math.round(s.fifoProfit*10000/s.fifoCost)/100:null, profitStatus:status, coverage:coverageFor(s), invoiceCount:s.invoices.size, lineCount:s.lines, qty:s.qty, itemCount:s.itemCodes.size }}).sort((a,b)=>b.amount-a.amount);
  return { ok:true, source:`mongo:${saleSource.headerCollection}+${saleSource.lineCollection}|fifo:supplierPurchaseLayers-coverage-only`, activeSnapshotId:saleSource.snapshotId, snapshotStatus:saleSource.status, snapshotSource:saleSource.source, sellerAccountNumber:seller, dateFrom, dateTo, invoiceCount:invoices.length, lineCount:lines.length, qty, itemCount:itemCodes.size, totalSales:Math.round(total), fifoCost:profit.totals.fifoCost, estimatedProfit:profit.totals.fifoProfit, fifoProfit:profit.totals.fifoProfit, roiPercent:profit.totals.roiPercent, profitStatus:profit.totals.profitStatus, coverage:profit.totals.coverage, profitLineStats:{ calculated:profit.totals.calculatedLines, partial:profit.totals.partialLines, unknown:profit.totals.unknownLines }, reportScanLimit, reportScanLimitReached:sourceLines.length>=reportScanLimit, profitDiagnostics:profit.diagnostics, sellers, groups, invoices:outputInvoices, lines:lines.slice(0,Math.min(Number(filters.lineLimit||5000),10000)), limitations:{ purchaseHistoryComplete:false, saleReturnsNettingImplemented:false, saleReturnsExcluded:true } };
}

module.exports={ VERSION, init, buildSaleSnapshot, listSnapshots, status, lines, sellerPerformance, _activeDataset:activeDataset, _saleInvoicesOnly:saleInvoicesOnly, _computeSellerProfitFifo:computeSellerProfitFifo, _saleHeaderDoc:saleHeaderDoc, _saleLineDocs:saleLineDocs, _resolveSellerForInvoice:resolveSellerForInvoice, _saleDate8:saleDate8, _safeError:safeError };
