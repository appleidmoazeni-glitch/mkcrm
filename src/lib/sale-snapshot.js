'use strict';

const shaygan = require('./shaygan');
const VERSION = '0.9.19.44-stability-sync-sale-reset-background-jobs';

function clean(v){ return String(v == null ? '' : v).trim(); }
function num(v,d=0){ const n=Number(String(v??'').replace(/[,،\s]/g,'')); return Number.isFinite(n)?n:d; }
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

function normDate8(v){ return clean(v).replace(/-/g,'').replace(/[^0-9]/g,'').slice(0,8); }
function lineDateScoreFromDoc(x){ return parseDateScore(x.saleDate || x.invDate || x.purchaseDate || x.createdDate || ''); }
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
  return { byItem, layerCount:byKey.size };
}
async function computeSellerProfitFifo(db, filters={}){
  const seller=clean(filters.sellerAccountNumber || filters.seller || '');
  const dateFrom=normDate8(filters.dateFrom||''); const dateTo=normDate8(filters.dateTo||'');
  const saleQ={ saleInvoiceType:2 };
  if(dateTo) saleQ.saleDate={ $lte:dateTo };
  // We must consume all sales up to dateTo, not just the chosen seller/date range; otherwise older layers are assigned incorrectly.
  const allSales=await db.collection('saleInvoiceLines').find(saleQ).sort({ saleDate:1, saleInvoiceNo:1, row:1 }).limit(Math.max(1, Math.min(Number(filters.profitScanLimit||250000), 500000))).toArray().catch(()=>[]);
  const purchasePool=await loadLatestPurchaseLayersForProfit(db);
  const targetKey=(l)=>{
    if(seller && clean(l.sellerAccountNumber)!==seller) return false;
    const ds=parseDateScore(l.saleDate||'');
    if(dateFrom && ds<parseDateScore(dateFrom)) return false;
    if(dateTo && ds>parseDateScore(dateTo)) return false;
    return true;
  };
  const resultByLine=new Map(); const invoiceProfit=new Map(); const groupProfit=new Map();
  const diagnostics={ saleRowsScanned:allSales.length, purchaseLayerPool:purchasePool.layerCount, allocatedRows:0, targetAllocatedRows:0, partialRows:0, unknownRows:0, skippedFutureLayers:0, noPurchaseLayerRows:0, insufficientLayerRows:0, unmatchedReasons:{}, note:'FIFO consumes all sale lines up to dateTo; only selected seller/date rows are reported.' };
  for(const sale of allSales){
    const code=clean(sale.itemCode); const arr=purchasePool.byItem.get(code)||[];
    let need=num(sale.qty,0); const originalQty=need; const saleValueTotal=num(sale.saleValue,0); const unitSale= originalQty ? saleValueTotal/originalQty : num(sale.unitSale,0);
    const saleDs=parseDateScore(sale.saleDate||'');
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
    const lineProfit={ saleLineId:sale.saleLineId||'', saleInvoiceNo:sale.saleInvoiceNo, saleDate:sale.saleDate, row:sale.row, itemCode:code, itemName:sale.itemName||'', sellerAccountNumber:sale.sellerAccountNumber||'', sellerName:sale.sellerName||'', qty:originalQty, allocatedQty, saleValue:Math.round(saleValue || (status==='unknown'?0:saleValueTotal)), fifoCost:Math.round(cost), fifoProfit: status==='unknown'?null:Math.round((saleValue||0)-cost), profitStatus:status, profitReason:reason, allocations };
    resultByLine.set(`${sale.saleInvoiceType}-${sale.saleInvoiceNo}-${sale.row}`, lineProfit);
    if(targetKey(sale)){
      if(status!=='unknown') diagnostics.targetAllocatedRows += allocations.length;
      const ik=`${sale.saleInvoiceType}-${sale.saleInvoiceNo}`;
      const inv=invoiceProfit.get(ik)||{ saleInvoiceType:sale.saleInvoiceType, saleInvoiceNo:sale.saleInvoiceNo, saleDate:sale.saleDate, sellerAccountNumber:sale.sellerAccountNumber, sellerName:sale.sellerName, amount:0, fifoCost:0, fifoProfit:0, lines:0, calculatedLines:0, partialLines:0, unknownLines:0, itemCodes:new Set() };
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
  const totals=[...invoiceProfit.values()].reduce((a,x)=>{a.amount+=x.amount; a.cost+=x.fifoCost; a.profit+=x.fifoProfit; a.lines+=x.lines; a.calculated+=x.calculatedLines; a.partial+=x.partialLines; a.unknown+=x.unknownLines; return a;},{amount:0,cost:0,profit:0,lines:0,calculated:0,partial:0,unknown:0});
  const profitStatus = totals.unknown===0 && totals.partial===0 ? 'calculated' : (totals.calculated>0 || totals.partial>0 ? 'partial' : 'unknown');
  return { resultByLine, invoiceProfit, groupProfit, totals:{ totalSales:Math.round(totals.amount), fifoCost:Math.round(totals.cost), fifoProfit:Math.round(totals.profit), roiPercent:roi(totals.profit,totals.cost), lineCount:totals.lines, calculatedLines:totals.calculated, partialLines:totals.partial, unknownLines:totals.unknown, profitStatus }, diagnostics };
}
function scopeKeyFor(dateFrom, dateTo){ return `sale-type2|${clean(dateFrom)}|${clean(dateTo)}`; }

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
  if(m) return { ...m, sellerAccountNumber: sellerNo || m.sellerAccountNumber, rawSellerAccountName: invSellerAccountName(inv) };
  return { username:'', sellerName: invSellerAccountName(inv) || (sellerNo ? `نماینده ${sellerNo}` : 'نامشخص'), sellerAccountNumber:sellerNo, sellerAccountName:invSellerAccountName(inv), cashboxAccountNumber:cashNo, cashboxAccountName:invAccountName(inv), storeName:'', rawSellerAccountName:invSellerAccountName(inv) };
}

function saleHeaderDoc(inv, snapshotIdValue, sellerMaps){
  const typ = Number(inv.InvTyp || inv.InvoiceType || 0);
  const seller = resolveSellerForInvoice(inv, sellerMaps || {});
  return {
    snapshotId: snapshotIdValue,
    invNo: invNo(inv),
    invTyp: typ,
    invTypeLabel: invTypeLabel(typ),
    invDate: invDate(inv),
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
      firstIssuerUsername: header.firstIssuerUsername,
      lastIssuerUsername: header.lastIssuerUsername,
      generalRef: header.generalRef,
      row: i+1,
      lineItemId: num(x.LineItemId || x.LineId || 0,0),
      itemCode: lineItemCode(x),
      itemName: lineItemName(x),
      mainGroupCode: (groupMap && groupMap.get(lineItemCode(x)) && groupMap.get(lineItemCode(x)).mainGroupCode) || deriveMainGroupFromCode(lineItemCode(x)).mainGroupCode,
      mainGroupName: (groupMap && groupMap.get(lineItemCode(x)) && groupMap.get(lineItemCode(x)).mainGroupName) || deriveMainGroupFromCode(lineItemCode(x)).mainGroupName,
      mainGroup: (groupMap && groupMap.get(lineItemCode(x)) && groupMap.get(lineItemCode(x)).mainGroup) || deriveMainGroupFromCode(lineItemCode(x)).mainGroup,
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
  const names=['saleSnapshots','saleInvoiceHeaders','saleInvoiceLines','saleSnapshotDiagnostics','saleSnapshotState'];
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
  await db.collection('saleSnapshotDiagnostics').createIndex({ snapshotId:1, at:-1 });
  await db.collection('saleSnapshotState').createIndex({ scopeKey:1 }, { unique:true });
}

async function init(db){ await ensureIndexes(db); return { ok:true, version:VERSION }; }

async function latestInvNoByType(db, invTyp, dateFrom='', dateTo=''){
  const q={ invTyp:Number(invTyp) };
  // The stored saleDate is the invoice date from Shaygan. For the current 1405 workflow we primarily rely on InvNo.
  if(dateFrom || dateTo){
    q.invDate={};
    if(dateFrom) q.invDate.$gte=clean(dateFrom).replace(/-/g,'');
    if(dateTo) q.invDate.$lte=clean(dateTo).replace(/-/g,'');
  }
  const doc=await db.collection('saleInvoiceHeaders').findOne(q,{ sort:{ invNo:-1 } }).catch(()=>null);
  return Number(doc?.invNo || 0);
}

async function buildSaleSnapshot(db, opts={}){
  await ensureIndexes(db);
  const sid=snapshotId(); const now=new Date();
  const dateFrom=clean(opts.dateFrom || '14050101').replace(/-/g,'');
  const dateTo=clean(opts.dateTo || '').replace(/-/g,'');
  const pageSize=Math.max(1, Math.min(Number(opts.pageSize || 20), 20));
  const maxPages=Math.max(1, Math.min(Number(opts.maxPages || 1000), 10000));
  const reset = opts.reset === true || opts.reset === 'true' || opts.mode === 'full';
  const scopeKey = scopeKeyFor(dateFrom, dateTo);
  const sellerMaps = await getSellerMaps(db);
  const snap={ snapshotId:sid, version:VERSION, status:'running', dateFrom, dateTo, pageSize, maxPages, incremental:!reset, mode: reset?'full-sale-type2-scan':'new-sale-type2-by-invno', scopeKey, createdAt:now, updatedAt:now, invoiceHeadersFound:0, invoiceBodiesLoaded:0, saleLinesParsed:0, emptyBodyInvoices:0, errors:[] };
  await db.collection('saleSnapshots').insertOne(snap);

  const errors=[]; const samples=[];
  let headersFound=0, bodiesLoaded=0, linesParsed=0, emptyBody=0, detailFetched=0, pagesScanned=0;
  const typeStats = { '2': { label:'Sale', invoices:0, lines:0, amount:0, startInvNo:0, nextInvNoFrom:0, pagesScanned:0, reachedEnd:false } };
  const sellerStatsMap = new Map();

  async function processInvoice(inv, pageGroupMap){
    const no=invNo(inv); if(!no) return;
    const typ=Number(inv.InvTyp || inv.InvoiceType || 0);
    const body=invBody(inv);
    headersFound += 1;
    if(body.length) bodiesLoaded++; else emptyBody++;
    const h=saleHeaderDoc(inv, sid, sellerMaps);
    await db.collection('saleInvoiceHeaders').updateOne(
      { invTyp:h.invTyp, invNo:h.invNo },
      { $set:{ ...h, lastSnapshotId:sid, updatedAt:new Date() }, $setOnInsert:{ firstSyncedAt:new Date() } },
      { upsert:true }
    );
    const lines=saleLineDocs(inv, sid, sellerMaps, pageGroupMap);
    linesParsed += lines.length;
    if(typeStats[String(h.invTyp)]){ typeStats[String(h.invTyp)].invoices += 1; typeStats[String(h.invTyp)].lines += lines.length; typeStats[String(h.invTyp)].amount += Number(h.totalAmount||0); }
    const skey = h.sellerAccountNumber || h.sellerName || h.accountName || 'UNKNOWN';
    const ss = sellerStatsMap.get(skey) || { key:skey, sellerAccountNumber:h.sellerAccountNumber, sellerAccountName:h.sellerAccountName, sellerName:h.sellerName, sellerUsername:h.sellerUsername, sellerStoreName:h.sellerStoreName, cashboxAccountName:h.cashboxAccountName, invoices:0, lines:0, amount:0 };
    ss.invoices += 1; ss.lines += lines.length; ss.amount += Number(h.totalAmount||0);
    sellerStatsMap.set(skey, ss);
    for(const line of lines){
      await db.collection('saleInvoiceLines').updateOne(
        { saleInvoiceType:line.saleInvoiceType, saleInvoiceNo:line.saleInvoiceNo, row:line.row },
        { $set:{ ...line, lastSnapshotId:sid, updatedAt:new Date() }, $setOnInsert:{ firstSyncedAt:new Date() } },
        { upsert:true }
      );
    }
    if(samples.length<20) samples.push({ invTyp:h.invTyp, invTypeLabel:h.invTypeLabel, invNo:h.invNo, invDate:h.invDate, accountName:h.accountName, sellerAccountNumber:h.sellerAccountNumber, sellerAccountName:h.sellerAccountName, sellerName:h.sellerName, sellerUsername:h.sellerUsername, generalRef:h.generalRef, rowCount:body.length, saleLines:lines.length, totalAmount:h.totalAmount });
  }

  try{
    const startNoByType={};
    for(const typ of [2]){
      const key=String(typ);
      const lastNo = reset ? 0 : await latestInvNoByType(db, typ, dateFrom, dateTo);
      const invNoFrom = lastNo > 0 ? String(lastNo + 1) : '';
      startNoByType[key]=lastNo;
      typeStats[key].startInvNo=lastNo;
      typeStats[key].nextInvNoFrom=lastNo+1;
      let typeReachedEnd=false;
      for(let page=0,rowStart=0; page<maxPages; page++, rowStart+=pageSize){
        const r=await shaygan.getInvoicePageByTypeNumberRange(rowStart, typ, invNoFrom, '', dateFrom, dateTo, pageSize).catch(e=>({ok:false,error:String(e.message||e),result:[]}));
        pagesScanned++; typeStats[key].pagesScanned++;
        if(!r.ok){ errors.push({ stage:'sale-invoice-page', typ, page, rowStart, invNoFrom, error:r.error||`Invoice/Get type ${typ} page failed` }); break; }
        const rows=Array.isArray(r.result)?r.result:[];
        if(!rows.length){ typeReachedEnd=true; typeStats[key].reachedEnd=true; break; }
        const pageItemCodes=[]; for(const inv of rows){ for(const b of invBody(inv)) pageItemCodes.push(lineItemCode(b)); }
        const pageGroupMap=await loadMainGroupMap(db, pageItemCodes);
        for(const inv of rows) await processInvoice(inv, pageGroupMap);
        // Do not stop on short pages. Shaygan sometimes returns short pages before the real end.
        await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ updatedAt:new Date(), pagesScanned, startNoByType, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100) } });
      }
      if(!typeReachedEnd && typeStats[key].pagesScanned>=maxPages) errors.push({ stage:'max-pages-reached', typ, maxPages, note:'برای خواندن ادامه، maxPages را بالاتر بگذار یا دوباره اجرا کن.' });
    }

    const reachedEnd = !!(typeStats['2'] && typeStats['2'].reachedEnd);
    await db.collection('saleSnapshotState').updateOne({ scopeKey }, { $set:{ scopeKey, dateFrom, dateTo, reachedEnd, updatedAt:new Date(), lastSnapshotId:sid, lastHeadersFound:headersFound, lastLinesParsed:linesParsed, latestType2: await latestInvNoByType(db,2,dateFrom,dateTo), invoiceTypes:{ sale:2, buy:3, saleReturn:6, purchaseReturn:7 } } }, { upsert:true });
    const status=errors.length && !linesParsed ? 'completed_with_errors' : 'completed';
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ status, finishedAt:new Date(), updatedAt:new Date(), pagesScanned, reachedEnd, startNoByType, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100), samples } });
    await db.collection('saleSnapshotDiagnostics').insertOne({ snapshotId:sid, at:new Date(), version:VERSION, dateFrom, dateTo, incremental:!reset, mode:reset?'full-sale-type2-scan':'new-sale-type2-by-invno', reachedEnd, startNoByType, pagesScanned, headersFound, bodiesLoaded, linesParsed, emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100), samples });
    return { ok:true, snapshotId:sid, status, incremental:!reset, mode:reset?'full-sale-type2-scan':'new-sale-type2-by-invno', reachedEnd, startNoByType, pagesScanned, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,20), samples };
  }catch(e){
    await db.collection('saleSnapshots').updateOne({ snapshotId:sid }, { $set:{ status:'failed', error:String(e.message||e), updatedAt:new Date(), finishedAt:new Date(), pagesScanned, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,100) } });
    return { ok:false, snapshotId:sid, error:String(e.message||e), incremental:!reset, pagesScanned, invoiceHeadersFound:headersFound, invoiceBodiesLoaded:bodiesLoaded, saleLinesParsed:linesParsed, emptyBodyInvoices:emptyBody, detailFetched, typeStats, sellerStats:Array.from(sellerStatsMap.values()).slice(0,200), errors:errors.slice(0,20) };
  }
}

async function listSnapshots(db, limit=20){
  await ensureIndexes(db);
  const list=await db.collection('saleSnapshots').find({}).sort({ createdAt:-1 }).limit(Math.max(1,Math.min(Number(limit||20),100))).toArray();
  return { ok:true, list };
}
async function status(db, snapshotId=''){
  await ensureIndexes(db);
  const snap=snapshotId ? await db.collection('saleSnapshots').findOne({ snapshotId }) : await db.collection('saleSnapshots').findOne({}, { sort:{ createdAt:-1 } });
  if(!snap) return { ok:true, snapshot:null };
  const diag=await db.collection('saleSnapshotDiagnostics').findOne({ snapshotId:snap.snapshotId }, { sort:{ at:-1 } }).catch(()=>null);
  return { ok:true, snapshot:snap, diagnostics:diag };
}
async function lines(db, filters={}){
  await ensureIndexes(db);
  const q={};
  if(filters.snapshotId) q.snapshotId=clean(filters.snapshotId);
  if(filters.itemCode) q.itemCode=clean(filters.itemCode);
  if(filters.sellerAccountNumber) q.sellerAccountNumber=clean(filters.sellerAccountNumber);
  if(filters.dateFrom || filters.dateTo){ q.saleDate={}; if(filters.dateFrom) q.saleDate.$gte=clean(filters.dateFrom); if(filters.dateTo) q.saleDate.$lte=clean(filters.dateTo); }
  const list=await db.collection('saleInvoiceLines').find(q).sort({ saleDate:-1, saleInvoiceNo:-1, row:1 }).limit(Math.max(1,Math.min(Number(filters.limit||500),5000))).toArray();
  return { ok:true, list };
}


async function sellerPerformance(db, filters={}){
  await ensureIndexes(db);
  const seller=clean(filters.sellerAccountNumber || filters.seller || '');
  const q={ saleInvoiceType: 2 };
  if(seller) q.sellerAccountNumber=seller;
  const dateFrom=normDate8(filters.dateFrom||''); const dateTo=normDate8(filters.dateTo||'');
  if(dateFrom || dateTo){ q.saleDate={}; if(dateFrom) q.saleDate.$gte=dateFrom; if(dateTo) q.saleDate.$lte=dateTo; }
  const lines=await db.collection('saleInvoiceLines').find(q).sort({ saleDate:-1, saleInvoiceNo:-1, row:1 }).limit(Math.max(1,Math.min(Number(filters.limit||2000),10000))).toArray();
  const profit=await computeSellerProfitFifo(db, { ...filters, sellerAccountNumber:seller, dateFrom, dateTo });
  const invoiceMap=new Map(); const groupMap=new Map();
  let total=0, qty=0;
  for(const l of lines){
    const pk=`${l.saleInvoiceType}-${l.saleInvoiceNo}-${l.row}`; const pr=profit.resultByLine.get(pk)||{};
    total+=num(l.saleValue,0); qty+=num(l.qty,0);
    const ik=`${l.saleInvoiceType}-${l.saleInvoiceNo}`;
    const inv=invoiceMap.get(ik)||{ saleInvoiceType:l.saleInvoiceType, saleInvoiceNo:l.saleInvoiceNo, saleDate:l.saleDate, sellerAccountNumber:l.sellerAccountNumber, sellerName:l.sellerName, cashboxAccountName:l.cashboxAccountName, amount:0, fifoCost:0, fifoProfit:0, lines:0, calculatedLines:0, partialLines:0, unknownLines:0, itemCodes:new Set() };
    inv.amount+=num(l.saleValue,0); inv.lines+=1; inv.fifoCost+=num(pr.fifoCost,0); if(pr.fifoProfit!=null) inv.fifoProfit+=num(pr.fifoProfit,0);
    if(pr.profitStatus==='calculated') inv.calculatedLines++; else if(pr.profitStatus==='partial') inv.partialLines++; else inv.unknownLines++;
    if(l.itemCode) inv.itemCodes.add(l.itemCode); invoiceMap.set(ik,inv);
    const gk=clean(l.mainGroupCode||'__UNKNOWN__'); const g=groupMap.get(gk)||{ mainGroupCode:gk, mainGroup:l.mainGroup||'نامشخص', amount:0, fifoCost:0, fifoProfit:0, lines:0, qty:0, calculatedLines:0, partialLines:0, unknownLines:0, invoices:new Set(), itemCodes:new Set() };
    g.amount+=num(l.saleValue,0); g.fifoCost+=num(pr.fifoCost,0); if(pr.fifoProfit!=null) g.fifoProfit+=num(pr.fifoProfit,0); g.lines+=1; g.qty+=num(l.qty,0);
    if(pr.profitStatus==='calculated') g.calculatedLines++; else if(pr.profitStatus==='partial') g.partialLines++; else g.unknownLines++;
    g.invoices.add(ik); if(l.itemCode) g.itemCodes.add(l.itemCode); groupMap.set(gk,g);
    l.fifoCost=pr.fifoCost||0; l.fifoProfit=pr.fifoProfit; l.profitStatus=pr.profitStatus||'unknown'; l.profitReason=pr.profitReason||''; l.purchaseAllocations=pr.allocations||[];
  }
  const invoices=[...invoiceMap.values()].map(x=>({ ...x, fifoCost:Math.round(x.fifoCost), fifoProfit:Math.round(x.fifoProfit), roiPercent:x.fifoCost?Math.round(x.fifoProfit*10000/x.fifoCost)/100:null, profitStatus:x.unknownLines===0&&x.partialLines===0?'calculated':(x.calculatedLines||x.partialLines?'partial':'unknown'), itemCount:x.itemCodes.size, itemCodes:undefined })).sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate)) || Number(b.saleInvoiceNo)-Number(a.saleInvoiceNo));
  const groups=[...groupMap.values()].map(g=>({ mainGroupCode:g.mainGroupCode==='__UNKNOWN__'?'':g.mainGroupCode, mainGroup:g.mainGroup, amount:Math.round(g.amount), fifoCost:Math.round(g.fifoCost), fifoProfit:Math.round(g.fifoProfit), roiPercent:g.fifoCost?Math.round(g.fifoProfit*10000/g.fifoCost)/100:null, profitStatus:g.unknownLines===0&&g.partialLines===0?'calculated':(g.calculatedLines||g.partialLines?'partial':'unknown'), lines:g.lines, qty:g.qty, calculatedLines:g.calculatedLines, partialLines:g.partialLines, unknownLines:g.unknownLines, invoiceCount:g.invoices.size, itemCount:g.itemCodes.size })).sort((a,b)=>b.amount-a.amount);
  return { ok:true, sellerAccountNumber:seller, dateFrom:clean(filters.dateFrom||''), dateTo:clean(filters.dateTo||''), invoiceCount:invoices.length, lineCount:lines.length, qty, totalSales:Math.round(total), fifoCost:profit.totals.fifoCost, estimatedProfit:profit.totals.fifoProfit, fifoProfit:profit.totals.fifoProfit, roiPercent:profit.totals.roiPercent, profitStatus:profit.totals.profitStatus, profitLineStats:{ calculated:profit.totals.calculatedLines, partial:profit.totals.partialLines, unknown:profit.totals.unknownLines }, profitDiagnostics:profit.diagnostics, groups, invoices:invoices.slice(0,Math.min(Number(filters.invoiceLimit||500),2000)), lines:lines.slice(0,Math.min(Number(filters.lineLimit||500),2000)) };
}

module.exports={ VERSION, init, buildSaleSnapshot, listSnapshots, status, lines, sellerPerformance };
