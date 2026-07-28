'use strict';

const path=require('path');
const {connectMongo,closeMongo}=require(path.join(process.cwd(),'src/lib/mongo'));

function clean(value){return String(value??'').trim();}
function safeError(value){
  return clean(value)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,'mongodb://[REDACTED]')
    .replace(/((?:authorization|password|passwd|token|api[-_ ]?key)\s*[:=]\s*)[^\s,;"'<>]+/gi,'$1[REDACTED]')
    .slice(0,1000);
}
function digits(value){return clean(value).replace(/[^0-9]/g,'').slice(0,8);}
function gregorianToJalali(year,month,day){
  const offsets=[0,31,59,90,120,151,181,212,243,273,304,334];
  let jy=year<=1600?0:979;
  let gy=year-(year<=1600?621:1600);
  const gy2=month>2?gy+1:gy;
  let days=365*gy+Math.floor((gy2+3)/4)-Math.floor((gy2+99)/100)+Math.floor((gy2+399)/400)-80+day+offsets[month-1];
  jy+=33*Math.floor(days/12053);days%=12053;
  jy+=4*Math.floor(days/1461);days%=1461;
  if(days>365){jy+=Math.floor((days-1)/365);days=(days-1)%365;}
  const jm=days<186?1+Math.floor(days/31):7+Math.floor((days-186)/30);
  const jd=1+(days<186?days%31:(days-186)%30);
  return `${jy}${String(jm).padStart(2,'0')}${String(jd).padStart(2,'0')}`;
}
function canonicalSaleDate(value){
  const value8=digits(value);
  if(!/^\d{8}$/.test(value8))return '';
  const year=Number(value8.slice(0,4));
  return year>=1700
    ?gregorianToJalali(year,Number(value8.slice(4,6)),Number(value8.slice(6,8)))
    :value8;
}
function projectedKeys(document){return document?Object.keys(document).sort():[];}
function errorSummary(snapshot){
  return (Array.isArray(snapshot?.errors)?snapshot.errors:[]).slice(0,20).map(error=>({
    stage:error?.stage||'',
    page:error?.page,
    rowStart:error?.rowStart,
    invNoFrom:error?.invNoFrom,
    error:safeError(error?.error||error?.message||'').slice(0,500)
  }));
}
function snapshotView(snapshot){
  const type2=snapshot?.typeStats?.['2']||{};
  const errors=errorSummary(snapshot);
  return {
    snapshotId:snapshot.snapshotId,
    status:snapshot.status,
    mode:snapshot.mode,
    dateFrom:snapshot.dateFrom,
    dateTo:snapshot.dateTo,
    createdAt:snapshot.createdAt,
    updatedAt:snapshot.updatedAt,
    finishedAt:snapshot.finishedAt,
    pagesScanned:snapshot.pagesScanned,
    lastSuccessfulPage:snapshot.lastSuccessfulPage,
    finalPage:Number(snapshot.pagesScanned||0)>0?Number(snapshot.pagesScanned)-1:null,
    invoiceHeadersFound:snapshot.invoiceHeadersFound,
    invoiceBodiesLoaded:snapshot.invoiceBodiesLoaded,
    saleLinesParsed:snapshot.saleLinesParsed,
    emptyBodyInvoices:snapshot.emptyBodyInvoices,
    retryCount:snapshot.retryCount||0,
    failedPageCount:Array.isArray(snapshot.failedPages)?snapshot.failedPages.length:errors.length,
    reachedEnd:snapshot.reachedEnd??type2.reachedEnd,
    startInvNo:snapshot.startInvNo,
    endInvNo:snapshot.endInvNo,
    nextInvNo:snapshot.nextInvNo,
    errors
  };
}
function sellerFieldView(document){
  const fields=[
    'sellerCode','sellerNumber','visitorCode','visitorNumber','employeeCode','employeeNumber',
    'sellerAccountNumber','salespersonCode','salespersonNumber','SAccountNumber'
  ];
  return fields.reduce((result,key)=>{
    if(document?.[key]!==undefined&&document?.[key]!==null&&clean(document[key])!=='')result[key]=document[key];
    return result;
  },{});
}

async function main(){
  const db=await connectMongo();
  if(!/staging/i.test(db.databaseName))throw new Error(`Refusing non-staging database: ${db.databaseName}`);
  const collectionNames=(await db.listCollections().toArray()).map(item=>item.name).sort();
  const relevantNames=[
    'appJobs','saleSnapshots','saleSnapshotDiagnostics','saleSnapshotState',
    'saleInvoiceHeaders','saleInvoiceLines','saleSnapshotDatasetHeaders','saleSnapshotDatasetLines',
    'sellerPerformanceHistory',
    'supplierPurchaseLayers','supplierSleepSnapshots'
  ].filter(name=>collectionNames.includes(name));
  const collections={};
  for(const name of relevantNames){
    const collection=db.collection(name);
    const sample=await collection.findOne({});
    collections[name]={
      count:await collection.estimatedDocumentCount(),
      sampleKeys:projectedKeys(sample),
      indexes:(await collection.indexes()).map(index=>({name:index.name,key:index.key,unique:!!index.unique}))
    };
  }

  const recentSnapshots=await db.collection('saleSnapshots').find({}).sort({createdAt:-1}).limit(20).toArray();
  const recentJobs=await db.collection('appJobs').find({type:'sale-snapshot'}).sort({createdAt:-1}).limit(20).toArray();
  const states=await db.collection('saleSnapshotState').find({}).sort({updatedAt:-1}).limit(50).toArray();
  const headerCountsBySnapshot=await db.collection('saleSnapshotDatasetHeaders').aggregate([
    {$match:{invTyp:2}},
    {$group:{_id:'$snapshotId',count:{$sum:1},minInvNo:{$min:'$invNo'},maxInvNo:{$max:'$invNo'}}},
    {$sort:{count:-1}}
  ]).toArray();
  const lineCountsBySnapshot=await db.collection('saleSnapshotDatasetLines').aggregate([
    {$match:{saleInvoiceType:2}},
    {$group:{_id:'$snapshotId',count:{$sum:1},minInvNo:{$min:'$saleInvoiceNo'},maxInvNo:{$max:'$saleInvoiceNo'}}},
    {$sort:{count:-1}}
  ]).toArray();

  const dateFrom='14050501',dateTo='14050506',sellerCode=clean(process.argv[2]);
  if(!sellerCode)throw new Error('Usage: node scripts/diagnose-sale-snapshot-recovery.js <seller-account-number>');
  const activeState=states.find(state=>clean(state.activeSnapshotId));
  const activeSnapshotId=clean(activeState?.activeSnapshotId);
  const headerCollection=activeSnapshotId?'saleSnapshotDatasetHeaders':'saleInvoiceHeaders';
  const lineCollection=activeSnapshotId?'saleSnapshotDatasetLines':'saleInvoiceLines';
  const headers=await db.collection(headerCollection).find({invTyp:2,...(activeSnapshotId?{snapshotId:activeSnapshotId}:{})}).toArray();
  const lines=await db.collection(lineCollection).find({saleInvoiceType:2,...(activeSnapshotId?{snapshotId:activeSnapshotId}:{})}).toArray();
  const headersInRange=headers.filter(row=>{
    const date=canonicalSaleDate(row.invDate||row.saleDate);
    return date>=dateFrom&&date<=dateTo;
  });
  const linesInRange=lines.filter(row=>{
    const date=canonicalSaleDate(row.saleDate||row.invDate);
    return date>=dateFrom&&date<=dateTo;
  });
  const codeMatches=row=>Object.values(sellerFieldView(row)).some(value=>clean(value)===sellerCode);
  const sellerHeaders=headersInRange.filter(codeMatches);
  const sellerLines=linesInRange.filter(codeMatches);
  const representative=sellerLines.slice(0,10).map(row=>({
    saleInvoiceNo:row.saleInvoiceNo,
    row:row.row,
    rawSaleDate:row.saleDate,
    canonicalSaleDate:canonicalSaleDate(row.saleDate),
    snapshotId:row.snapshotId,
    lastSnapshotId:row.lastSnapshotId,
    itemCode:row.itemCode,
    sellerFields:sellerFieldView(row)
  }));

  const output={
    generatedAt:new Date().toISOString(),
    databaseName:db.databaseName,
    collections,
    snapshots:recentSnapshots.map(snapshotView),
    jobs:recentJobs.map(job=>({
      jobId:job.jobId,status:job.status,phase:job.phase,createdAt:job.createdAt,
      startedAt:job.startedAt,finishedAt:job.finishedAt,updatedAt:job.updatedAt,
      request:job.request,
      result:job.result?{
        ok:job.result.ok,
        code:job.result.code,
        snapshotId:job.result.snapshotId,
        activeSnapshotId:job.result.activeSnapshotId,
        status:job.result.status,
        pagesScanned:job.result.pagesScanned,
        retryCount:job.result.retryCount,
        datasetHeaderCount:job.result.datasetHeaderCount,
        datasetLineCount:job.result.datasetLineCount
      }:null,
      error:safeError(job.error)
    })),
    states,
    activeSelection:{
      activeSnapshotId,
      source:activeSnapshotId?'versioned-active-snapshot':'legacy-unversioned-fallback',
      activeSnapshotFields:states.map(state=>({
        scopeKey:state.scopeKey,
        activeSnapshotId:state.activeSnapshotId,
        lastSnapshotId:state.lastSnapshotId,
        latestType2:state.latestType2,
        nextInvNo:state.nextInvNo,
        reachedEnd:state.reachedEnd,
        updatedAt:state.updatedAt
      })),
      headerCountsBySnapshot,
      lineCountsBySnapshot
    },
    targetSeller:{
      sellerCode,dateFrom,dateTo,
      totalHeaders:headers.length,totalLines:lines.length,
      headersInRange:headersInRange.length,linesInRange:linesInRange.length,
      sellerHeaders:sellerHeaders.length,sellerLines:sellerLines.length,
      codeMatchedHeaders:headersInRange.filter(codeMatches).length,
      codeMatchedLines:linesInRange.filter(codeMatches).length,
      snapshotIds:[...new Set(sellerLines.map(row=>row.snapshotId).filter(Boolean))],
      dateFormats:[...new Set(sellerLines.map(row=>clean(row.saleDate)))].slice(0,30),
      representative
    }
  };
  process.stdout.write(`${JSON.stringify(output,null,2)}\n`);
}

const timeout=setTimeout(()=>{process.stderr.write('diagnostic timeout\n');process.exit(124);},14000);
main().then(async()=>{clearTimeout(timeout);await closeMongo();}).catch(async error=>{
  clearTimeout(timeout);
  process.stderr.write(`${error.stack||error}\n`);
  await closeMongo().catch(()=>{});
  process.exitCode=1;
});
