#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEADER_FIELDS = ['InvTyp','InvNo','InvDescription','InvDate','InvPayDue','AccountNumber','AccountName','CurrencyAbb1','Rate','SAccountNumber','CreatedDate','DiscountPercent','DiscAmount','RelatedInvHeaderId','InvHeaderIdRoot','ControlCheck','Printed','FirstIssuerUsername','LastIssuerUsername','RowVersionAsNumber','UpdateKind','GuId'];
const LINE_FIELDS = ['LineItemId','ItemNumber','ItemDescription','STNumber','STDesc','Quan','Quan2','Price','Price2','Amount','AmortizePercent','LineDiscAmount','LineDiscPer','ReturnRial','OrderRemain1','OrderRemain2','FinalOrderQuan','FinalOrderQuan2','UpdateKind'];
const EXPENSE_FIELDS = ['ExpenseId','ExpenseType','ExpenseCode','ExpenseName','Description','Amount','Percent','Rate','CurrencyAbb1','AccountNumber','UpdateKind'];
const ACCOUNTING_HEADER_FIELDS = ['InvDate','AccountNumber','CurrencyAbb1','Rate','DiscountPercent','DiscAmount','RelatedInvHeaderId','InvHeaderIdRoot','Expense'];
const ACCOUNTING_LINE_FIELDS = ['LineItemId','ItemNumber','STNumber','Quan','Quan2','Price','Price2','Amount','LineDiscAmount','LineDiscPer','ReturnRial','UpdateKind'];
const COMPARE_HEADER_FIELDS = ['InvDate','AccountNumber','AccountName','CurrencyAbb1','Rate','SAccountNumber','DiscountPercent','DiscAmount','RelatedInvHeaderId','InvHeaderIdRoot','ControlCheck','Printed','FirstIssuerUsername','LastIssuerUsername','RowVersionAsNumber','UpdateKind','GuId'];
const COMPARE_LINE_FIELDS = ['ItemNumber','STNumber','Quan','Quan2','Price','Price2','Amount','LineDiscAmount','LineDiscPer','ReturnRial','UpdateKind'];
const SENSITIVE = /^(tokenstring|token|authorization|password|pass|secret|connectionstring|connectionname|credential|apikey|cookie|set-cookie)$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INVOICE_IDENTITY_CONTRACT = {
  retrievalKey: ['InvoiceType','InvoiceNumber'],
  stableIdentity: ['GuId','LineItemId']
};
const OPTIONS = {
  exact: new Set(['type','invoice-no','hydrate','timeout-ms','provisional-threshold']),
  page: new Set(['type','start-date','end-date','row-start','row-count','timeout-ms','provisional-threshold']),
  paging: new Set(['type','start-date','end-date','row-count','max-pages','max-invoices','hydrate','timeout-ms','provisional-threshold']),
  repeat: new Set(['type','invoice-no','reads','interval-ms','timeout-ms','provisional-threshold']),
  compare: new Set(['left-file','right-file'])
};

class DiagnosticError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message); this.code = code; this.exitCode = exitCode; this.details = details;
  }
}
const clean = value => value === undefined ? null : value;
const bodyOf = inv => Array.isArray(inv?.Body) ? inv.Body : (Array.isArray(inv?.Items) ? inv.Items : (Array.isArray(inv?.InvoiceBody) ? inv.InvoiceBody : []));
const expensesOf = inv => Array.isArray(inv?.Expense) ? inv.Expense : (Array.isArray(inv?.Expenses) ? inv.Expenses : []);
const invoiceTypeOf = inv => Number(inv?.InvTyp ?? inv?.InvoiceType ?? 0);
const invoiceNoOf = inv => Number(inv?.InvNo ?? inv?.InvoiceNumber ?? 0);
const guidOf = inv => String(inv?.GuId ?? inv?.Guid ?? inv?.InvGuId ?? inv?.InvHeaderGuId ?? '').trim();

function warning(code, scope, inv, line, details = {}) {
  return { code, scope, invoiceNo: invoiceNoOf(inv) || null, lineItemId: line?.LineItemId ?? null, details };
}
function redact(value, warnings = []) {
  if (Array.isArray(value)) return value.map(v => redact(v, warnings));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE.test(key)) {
      out[key] = '[REDACTED]';
      warnings.push({ code:'SENSITIVE_FIELD_REDACTED', scope:'output', invoiceNo:null, lineItemId:null, details:{ key } });
    } else out[key] = redact(item, warnings);
  }
  return out;
}
function sanitizeError(value) {
  return String(value || '').slice(0,1000)
    .replace(/\bBearer\s+\S+/gi,'Bearer [REDACTED]')
    .replace(/\b(tokenstring|token|authorization|password|pass|secret|connectionstring|connectionname|credential|apikey|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[REDACTED]@');
}
function transportErrorDetails(result) {
  return { status:result?.status || 0, error:sanitizeError(result?.error) };
}
function pick(obj, fields) {
  const out = {};
  for (const key of fields) out[key] = clean(obj?.[key]);
  return out;
}
function sanitizeExpense(exp, warnings) {
  const known = pick(exp, EXPENSE_FIELDS);
  const unknown = Object.keys(exp || {}).filter(k => !EXPENSE_FIELDS.includes(k) && !SENSITIVE.test(k));
  if (unknown.length) warnings.push({ code:'EXPENSE_FIELDS_OMITTED', scope:'expense', invoiceNo:null, lineItemId:null, details:{ fields:unknown.sort() } });
  return known;
}
function lineSortKey(line, index = 0) {
  const id = line.LineItemId;
  return `${id === null || id === undefined || id === '' ? '1' : '0'}:${String(id ?? '').padStart(24,'0')}:${String(line.row ?? line.Row ?? index).padStart(12,'0')}:${String(line.ItemNumber ?? '')}:${String(line.STNumber ?? '')}`;
}
function canonicalize(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = canonicalize(value[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
function sanitizedInvoice(inv, threshold = 1) {
  const warnings = [];
  const header = pick(inv || {}, HEADER_FIELDS);
  const sourceLines = bodyOf(inv);
  const lines = sourceLines.map((line, index) => ({ ...pick(line, LINE_FIELDS), _sourceIndex:index }));
  lines.sort((a,b) => lineSortKey(a,a._sourceIndex).localeCompare(lineSortKey(b,b._sourceIndex)));
  for (const line of lines) delete line._sourceIndex;
  const expense = expensesOf(inv).map(x => sanitizeExpense(x, warnings));
  expense.sort((a,b) => JSON.stringify(canonicalize(a)).localeCompare(JSON.stringify(canonicalize(b))));
  const safe = { identity:{ invoiceGuid:guidOf(inv)||null, invoiceType:invoiceTypeOf(inv)||null, invoiceNo:invoiceNoOf(inv)||null }, header, lines, expense };
  const analysis = analyzeInvoice(inv, lines, threshold, warnings);
  const versionSignals = {
    CurrentVersion: clean(inv?.CurrentVersion),
    RowVersionAsNumber: clean(inv?.RowVersionAsNumber),
    UpdateKind: clean(inv?.UpdateKind),
    CreatedDate: clean(inv?.CreatedDate),
    LastIssuerUsername: clean(inv?.LastIssuerUsername)
  };
  return { invoice:safe, contract:analysis.contract, observations:analysis.observations, versionSignals, warnings, hashes:hashInvoice(safe) };
}
function analyzeInvoice(inv, lines, threshold, warnings) {
  if (!inv || typeof inv !== 'object') warnings.push(warning('HEADER_MISSING','invoice',inv));
  if (!guidOf(inv)) warnings.push(warning('GUID_MISSING','invoice',inv));
  if (!lines.length) warnings.push(warning('BODY_MISSING','invoice',inv));
  const ids = new Map();
  let provisional = 0;
  const observations = [];
  for (let i=0;i<lines.length;i++) {
    const line=lines[i], id=line.LineItemId;
    if (id === null || id === undefined || id === '') warnings.push(warning('LINE_ITEM_ID_MISSING','line',inv,line,{ index:i }));
    else { ids.set(String(id),(ids.get(String(id))||0)+1); }
    if (!String(line.ItemNumber ?? '').trim()) warnings.push(warning('ITEM_NUMBER_MISSING','line',inv,line,{ index:i }));
    if (!String(line.STNumber ?? '').trim()) warnings.push(warning('WAREHOUSE_MISSING','line',inv,line,{ index:i }));
    const q=Number(line.Quan), p=Number(line.Price), a=Number(line.Amount);
    for (const [field,value] of [['Quan',line.Quan],['Price',line.Price],['Amount',line.Amount],['Quan2',line.Quan2],['Price2',line.Price2]]) {
      if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value)>Number.MAX_SAFE_INTEGER)) warnings.push(warning('UNSAFE_NUMERIC_VALUE','line',inv,line,{ field, value:String(value) }));
    }
    if (q === 0) warnings.push(warning('ZERO_QUANTITY','line',inv,line));
    if (q < 0) warnings.push(warning('NEGATIVE_QUANTITY','line',inv,line));
    if (p === 0) warnings.push(warning('PRICE_ZERO','line',inv,line));
    if (p === 1) warnings.push(warning('PRICE_ONE','line',inv,line));
    if (a === 1) warnings.push(warning('AMOUNT_ONE','line',inv,line));
    const derived = q ? a/q : null;
    if (derived === 1) warnings.push(warning('DERIVED_UNIT_COST_ONE','line',inv,line));
    const isProv = Number.isFinite(p) && p <= threshold;
    if (isProv) { provisional++; warnings.push(warning('PRICE_BELOW_PROVISIONAL_THRESHOLD','line',inv,line,{ threshold })); }
    const expected = Number.isFinite(q)&&Number.isFinite(p) ? q*p : null;
    const diff = expected !== null&&Number.isFinite(a) ? a-expected : null;
    if (diff !== null && Math.abs(diff)>0.01) warnings.push(warning('AMOUNT_INCONSISTENT','line',inv,line,{ expectedAmount:expected, amountDifference:diff }));
    observations.push({ lineItemId:id??null, itemNumber:line.ItemNumber, priceEqualsOne:p===1, amountEqualsOne:a===1, derivedUnitCostEqualsOne:derived===1, priceBelowConfiguredThreshold:isProv, expectedAmount:expected, amountDifference:diff, quan2:line.Quan2, price2:line.Price2, allocatedExpenseAmount:line.AmortizePercent });
  }
  for (const [id,count] of ids) if (count>1) warnings.push(warning('DUPLICATE_LINE_ITEM_ID','invoice',inv,null,{ lineItemId:id,count }));
  if (provisional>0 && provisional<lines.length) warnings.push(warning('MIXED_PROVISIONAL_COST','invoice',inv,null,{ provisionalLines:provisional,totalLines:lines.length }));
  return { contract:{ hasBody:lines.length>0, lineIdsPresent:lines.length>0&&lines.every(x=>x.LineItemId!==null&&x.LineItemId!==undefined&&x.LineItemId!==''), provisionalCostDetected:provisional>0, isProvisional:provisional>0, allLinesProvisional:lines.length>0&&provisional===lines.length, mixedProvisionalAndFinalLines:provisional>0&&provisional<lines.length }, observations };
}
function hashInvoice(invoice) {
  const headerHash = sha(invoice.header);
  const bodyHash = sha(invoice.lines);
  const identityLines = invoice.lines.map((l,i) => l.LineItemId !== null && l.LineItemId !== undefined && l.LineItemId !== '' ? { LineItemId:l.LineItemId } : { fallback:{ ItemNumber:l.ItemNumber, STNumber:l.STNumber, index:i } });
  const identityHash = sha({ InvTyp:invoice.identity.invoiceType, InvNo:invoice.identity.invoiceNo, GuId:invoice.identity.invoiceGuid, lines:identityLines });
  const accountingHeader = pick({ ...invoice.header, Expense:invoice.expense }, ACCOUNTING_HEADER_FIELDS);
  const accountingLines = invoice.lines.map(l=>pick(l,ACCOUNTING_LINE_FIELDS));
  const accountingHash = sha({ header:accountingHeader, lines:accountingLines });
  return { identityHash, accountingHash, headerHash, bodyHash, fullHash:sha(invoice) };
}
function parseArgs(argv) {
  const operation=argv[0];
  if (!OPTIONS[operation]) throw new DiagnosticError('INVALID_OPERATION','Unknown operation');
  const args={};
  for(let i=1;i<argv.length;i+=2){
    const token=argv[i];
    if(!token?.startsWith('--') || i+1>=argv.length) throw new DiagnosticError('INVALID_INPUT','Options require --name value pairs');
    const key=token.slice(2);
    if(!OPTIONS[operation].has(key)) throw new DiagnosticError('UNKNOWN_OPTION',`Unknown option: --${key}`);
    if(Object.hasOwn(args,key)) throw new DiagnosticError('DUPLICATE_OPTION',`Duplicate option: --${key}`);
    args[key]=argv[i+1];
  }
  return { operation,args:validateArgs(operation,args) };
}
function intArg(args,key,min,max,required=true,def) {
  if(args[key]===undefined){ if(required) throw new DiagnosticError('MISSING_OPTION',`--${key} is required`); return def; }
  if(!/^-?\d+$/.test(args[key])) throw new DiagnosticError('INVALID_INPUT',`--${key} must be an integer`);
  const n=Number(args[key]); if(!Number.isSafeInteger(n)||n<min||n>max) throw new DiagnosticError('INVALID_INPUT',`--${key} must be between ${min} and ${max}`); return n;
}
function numberArg(args,key,min=0,def=1) {
  if(args[key]===undefined) return def;
  const n=Number(args[key]); if(!Number.isFinite(n)||n<min) throw new DiagnosticError('INVALID_INPUT',`--${key} must be a finite number >= ${min}`); return n;
}
function boolArg(args,key,def=false) {
  if(args[key]===undefined)return def;
  if(!/^(true|false)$/i.test(args[key]))throw new DiagnosticError('INVALID_INPUT',`--${key} must be true or false`);
  return args[key].toLowerCase()==='true';
}
function validateArgs(op,a) {
  if(op==='compare') {
    for(const k of ['left-file','right-file']) if(!a[k]) throw new DiagnosticError('MISSING_OPTION',`--${k} is required`);
    return { leftFile:a['left-file'],rightFile:a['right-file'] };
  }
  const out={ type:intArg(a,'type',3,7), timeoutMs:intArg(a,'timeout-ms',1000,15000,false,10000), provisionalThreshold:numberArg(a,'provisional-threshold',0,1) };
  if(![3,7].includes(out.type))throw new DiagnosticError('INVALID_INVOICE_TYPE','--type must be 3 or 7');
  if(op==='exact'||op==='repeat')out.invoiceNo=intArg(a,'invoice-no',1,Number.MAX_SAFE_INTEGER);
  if(op==='exact')out.hydrate=boolArg(a,'hydrate',false);
  if(op==='page'||op==='paging'){
    for(const k of ['start-date','end-date'])if(!/^\d{8}$/.test(a[k]||''))throw new DiagnosticError('INVALID_DATE',`--${k} must contain exactly 8 digits`);
    if(a['start-date']>a['end-date'])throw new DiagnosticError('INVALID_DATE_RANGE','startDate must be <= endDate');
    out.startDate=a['start-date'];out.endDate=a['end-date'];out.rowCount=intArg(a,'row-count',1,20);
  }
  if(op==='page')out.rowStart=intArg(a,'row-start',0,Number.MAX_SAFE_INTEGER);
  if(op==='paging'){out.maxPages=intArg(a,'max-pages',1,25);out.maxInvoices=intArg(a,'max-invoices',1,500);out.hydrate=boolArg(a,'hydrate',false);}
  if(op==='repeat'){out.reads=intArg(a,'reads',2,5);out.intervalMs=intArg(a,'interval-ms',0,5000,false,0);}
  return out;
}
function apiDefault() {
  const { getInvoice,getInvoicePageByDate } = require('../src/lib/shaygan');
  return { getInvoice,getInvoicePageByDate };
}
function findExact(result,type,no) {
  const rows=Array.isArray(result?.list)?result.list:(Array.isArray(result?.result)?result.result:[]);
  return rows.find(x=>invoiceTypeOf(x)===type && invoiceNoOf(x)===no) || null;
}
async function exactOperation(args,api=apiDefault()) {
  const started=Date.now(), first=await api.getInvoice(args.invoiceNo,args.type,{timeoutMs:args.timeoutMs});
  if(!first?.ok)throw new DiagnosticError('TRANSPORT_ERROR','Invoice/Get failed',2,transportErrorDetails(first));
  let inv=findExact(first,args.type,args.invoiceNo), requests=1, hydrated=false;
  if(!inv){
    const any=(first.list||first.result||[])[0];
    const code=any&&invoiceTypeOf(any)!==args.type?'INVOICE_TYPE_MISMATCH':'INVOICE_NUMBER_MISMATCH';
    throw new DiagnosticError(code,'Response did not contain the requested invoice',3);
  }
  const initialHeaderOnly=bodyOf(inv).length===0;
  if(initialHeaderOnly&&args.hydrate){
    const second=await api.getInvoice(args.invoiceNo,args.type,{timeoutMs:args.timeoutMs}); requests++;
    if(!second?.ok)throw new DiagnosticError('TRANSPORT_ERROR','Hydration Invoice/Get failed',2,transportErrorDetails(second));
    const candidate=findExact(second,args.type,args.invoiceNo);
    if(candidate&&bodyOf(candidate).length){inv=candidate;hydrated=true;}
  }
  const out=sanitizedInvoice(inv,args.provisionalThreshold);
  out.contract.identity=INVOICE_IDENTITY_CONTRACT;
  out.contract.headerOnlyInitialResponse=initialHeaderOnly;out.contract.hydrated=hydrated;
  if(initialHeaderOnly)out.warnings.push(warning('HEADER_ONLY_RESPONSE','invoice',inv));
  if(initialHeaderOnly&&args.hydrate&&!hydrated)out.warnings.push(warning('HYDRATION_FAILED','invoice',inv));
  return {ok:true,operation:'exact',request:{invoiceType:args.type,invoiceNo:args.invoiceNo,hydrate:args.hydrate,timeoutMs:args.timeoutMs},transport:{status:first.status||0,durationMs:Date.now()-started,requestCount:requests},...out};
}
async function pageOperation(args,api=apiDefault()) {
  const started=Date.now(),r=await api.getInvoicePageByDate(args.rowStart,args.type,args.startDate,args.endDate,args.rowCount,{timeoutMs:args.timeoutMs});
  if(!r?.ok)throw new DiagnosticError('TRANSPORT_ERROR','Invoice/Get page failed',2,transportErrorDetails(r));
  const rows=Array.isArray(r.result)?r.result:[];
  const invoices=rows.map(x=>sanitizedInvoice(x,args.provisionalThreshold));
  return {ok:true,operation:'page',request:{invoiceType:args.type,startDate:args.startDate,endDate:args.endDate,rowStart:args.rowStart,rowCount:args.rowCount,timeoutMs:args.timeoutMs},transport:{status:r.status||0,durationMs:Date.now()-started,requestCount:1},page:{count:rows.length,shortPage:rows.length<args.rowCount,emptyPage:rows.length===0},invoices,sequence:invoices.map(x=>x.invoice.identity),sequenceHash:sha(invoices.map(x=>x.invoice.identity)),warnings:invoices.flatMap(x=>x.warnings)};
}
function invoiceIdentity(inv){return inv.identity.invoiceGuid?`${inv.identity.invoiceType}:g:${inv.identity.invoiceGuid.toLowerCase()}`:`${inv.identity.invoiceType}:n:${inv.identity.invoiceNo}`;}
async function pagingOperation(args,api=apiDefault()) {
  const pages=[],invoices=[],warnings=[],seenInv=new Map(),seenLine=new Map();let hydrateRequests=0,stoppedBy='MAX_PAGES',transportStatus=0,transportError='';
  outer:for(let page=0;page<args.maxPages;page++){
    const rowStart=page*args.rowCount,r=await api.getInvoicePageByDate(rowStart,args.type,args.startDate,args.endDate,args.rowCount,{timeoutMs:args.timeoutMs});
    transportStatus=r?.status||0;
    if(!r?.ok){stoppedBy='TRANSPORT_ERROR';transportError=sanitizeError(r?.error);break;}
    const rows=Array.isArray(r.result)?r.result:[];
    pages.push({page,rowStart,count:rows.length,shortPage:rows.length<args.rowCount,emptyPage:rows.length===0});
    if(!rows.length){stoppedBy='EMPTY_PAGE';break;}
    for(const raw of rows){
      if(invoiceTypeOf(raw)!==args.type){stoppedBy='CONTRACT_ERROR';warnings.push(warning('INVOICE_TYPE_MISMATCH','invoice',raw));break outer;}
      let inv=raw;
      if(args.hydrate&&!bodyOf(inv).length&&invoiceNoOf(inv)){
        const h=await api.getInvoice(invoiceNoOf(inv),args.type,{timeoutMs:args.timeoutMs});hydrateRequests++;
        const found=h?.ok?findExact(h,args.type,invoiceNoOf(inv)):null;
        if(found&&bodyOf(found).length)inv=found;else warnings.push(warning('HYDRATION_FAILED','invoice',inv));
      }
      const s=sanitizedInvoice(inv,args.provisionalThreshold),key=invoiceIdentity(s.invoice);
      if(seenInv.has(key))warnings.push(warning('DUPLICATE_INVOICE_ACROSS_PAGES','invoice',inv,null,{firstPage:seenInv.get(key),page}));
      else seenInv.set(key,page);
      s.invoice.lines.forEach((line,index)=>{
        const lk=line.LineItemId!==null&&line.LineItemId!==undefined&&line.LineItemId!==''?`${key}:id:${line.LineItemId}`:`${key}:fallback:${line.ItemNumber}:${line.STNumber}:${index}`;
        if(seenLine.has(lk))warnings.push(warning('DUPLICATE_LINE_ACROSS_PAGES','line',inv,line,{firstPage:seenLine.get(lk),page}));
        else seenLine.set(lk,page);
      });
      invoices.push(s);warnings.push(...s.warnings);
      if(invoices.length>=args.maxInvoices){stoppedBy='MAX_INVOICES';break outer;}
    }
  }
  const complete=stoppedBy==='EMPTY_PAGE';
  if(!complete&&['MAX_PAGES','MAX_INVOICES'].includes(stoppedBy))warnings.push({code:'SAFETY_LIMIT_REACHED',scope:'paging',invoiceNo:null,lineItemId:null,details:{stoppedBy}});
  const sequence=invoices.map(x=>x.invoice.identity);
  return {ok:!['TRANSPORT_ERROR','CONTRACT_ERROR'].includes(stoppedBy),operation:'paging',request:{invoiceType:args.type,startDate:args.startDate,endDate:args.endDate,rowCount:args.rowCount,maxPages:args.maxPages,maxInvoices:args.maxInvoices,hydrate:args.hydrate,timeoutMs:args.timeoutMs},transport:{status:transportStatus,error:transportError,requestCount:pages.length+hydrateRequests},pages,invoices,summary:{invoiceCount:invoices.length,hydrateRequests,complete,stoppedBy,shortPageFollowedByData:pages.some((p,i)=>p.shortPage&&!p.emptyPage&&pages[i+1]?.count>0),duplicateInvoiceCount:warnings.filter(x=>x.code==='DUPLICATE_INVOICE_ACROSS_PAGES').length,duplicateLineCount:warnings.filter(x=>x.code==='DUPLICATE_LINE_ACROSS_PAGES').length,sequence,sequenceHash:sha(sequence)},warnings};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function repeatOperation(args,api=apiDefault()) {
  const reads=[];
  for(let i=0;i<args.reads;i++){
    const r=await exactOperation({...args,hydrate:false},api);reads.push({invoice:r.invoice,hashes:r.hashes,versionSignals:r.versionSignals,warnings:r.warnings});
    if(i+1<args.reads&&args.intervalMs)await delay(args.intervalMs);
  }
  const unique=k=>new Set(reads.map(x=>x.hashes[k])).size===1;
  const versions=reads.map(x=>x.versionSignals);
  return {ok:true,operation:'repeat',request:{invoiceType:args.type,invoiceNo:args.invoiceNo,reads:args.reads,intervalMs:args.intervalMs,timeoutMs:args.timeoutMs},reads,stability:{guidStable:new Set(reads.map(x=>x.invoice.identity.invoiceGuid)).size===1,lineItemIdsStable:new Set(reads.map(x=>sha(x.invoice.lines.map(l=>l.LineItemId)))).size===1,identityHashStable:unique('identityHash'),accountingHashStable:unique('accountingHash')},versionSignals:versions,warnings:reads.flatMap(x=>x.warnings)};
}
function lineMatchKey(line,index){return line.LineItemId!==null&&line.LineItemId!==undefined&&line.LineItemId!==''?`id:${line.LineItemId}`:`fallback:${line.ItemNumber}:${line.STNumber}:${index}`;}
function diffFields(a,b,fields){return fields.filter(k=>JSON.stringify(a?.[k]??null)!==JSON.stringify(b?.[k]??null)).map(field=>({field,left:a?.[field]??null,right:b?.[field]??null}));}
function snapshotFrom(doc) {
  if(doc?.invoice&&doc?.hashes)return doc;
  if(Array.isArray(doc?.reads)&&doc.reads[0])return doc.reads[0];
  throw new DiagnosticError('INVALID_COMPARE_FILE','File is not a sanitised snapshot produced by this CLI');
}
function compareSnapshots(leftDoc,rightDoc) {
  if(leftDoc?.operation==='paging'||rightDoc?.operation==='paging'){
    if(leftDoc?.operation!=='paging'||rightDoc?.operation!=='paging')throw new DiagnosticError('INVALID_COMPARE_FILE','Both compare files must contain the same diagnostic operation');
    const leftSequence=leftDoc.summary?.sequence||[],rightSequence=rightDoc.summary?.sequence||[];
    const leftSet=leftSequence.map(x=>JSON.stringify(canonicalize(x))).sort(),rightSet=rightSequence.map(x=>JSON.stringify(canonicalize(x))).sort();
    const sameContent=JSON.stringify(leftSet)===JSON.stringify(rightSet),orderingChanged=JSON.stringify(leftSequence)!==JSON.stringify(rightSequence);
    const warnings=[];
    if(sameContent&&orderingChanged)warnings.push({code:'UNSTABLE_PAGE_ORDER',scope:'paging',invoiceNo:null,lineItemId:null,details:{leftSequenceHash:leftDoc.summary?.sequenceHash||sha(leftSequence),rightSequenceHash:rightDoc.summary?.sequenceHash||sha(rightSequence)}});
    return {ok:true,operation:'compare',sameInvoice:null,changes:{header:[],linesAdded:[],linesRemoved:[],linesChanged:[]},identityChanges:{guidChanged:false,lineItemIdsChanged:false,identityHashChanged:false},accountingHashChanged:false,ordering:{sameContent,orderingChanged,leftSequenceHash:leftDoc.summary?.sequenceHash||sha(leftSequence),rightSequenceHash:rightDoc.summary?.sequenceHash||sha(rightSequence)},versionSignals:{},warnings};
  }
  const left=snapshotFrom(leftDoc),right=snapshotFrom(rightDoc),la=left.invoice.lines||[],ra=right.invoice.lines||[];
  const lm=new Map(la.map((x,i)=>[lineMatchKey(x,i),x])),rm=new Map(ra.map((x,i)=>[lineMatchKey(x,i),x]));
  const linesAdded=[],linesRemoved=[],linesChanged=[];
  for(const [k,v] of rm)if(!lm.has(k))linesAdded.push({key:k,line:v});
  for(const [k,v] of lm)if(!rm.has(k))linesRemoved.push({key:k,line:v});
  for(const [k,v] of lm)if(rm.has(k)){const fields=diffFields(v,rm.get(k),COMPARE_LINE_FIELDS);if(fields.length)linesChanged.push({key:k,fields});}
  const header=diffFields(left.invoice.header,right.invoice.header,COMPARE_HEADER_FIELDS);
  const versionSignals={};
  for(const k of ['CurrentVersion','RowVersionAsNumber','UpdateKind','CreatedDate','LastIssuerUsername'])versionSignals[k]={left:left.versionSignals?.[k]??null,right:right.versionSignals?.[k]??null,changed:JSON.stringify(left.versionSignals?.[k]??null)!==JSON.stringify(right.versionSignals?.[k]??null)};
  return {ok:true,operation:'compare',sameInvoice:left.invoice.identity.invoiceType===right.invoice.identity.invoiceType&&left.invoice.identity.invoiceNo===right.invoice.identity.invoiceNo,changes:{header,linesAdded,linesRemoved,linesChanged},identityChanges:{guidChanged:left.invoice.identity.invoiceGuid!==right.invoice.identity.invoiceGuid,lineItemIdsChanged:sha(la.map(x=>x.LineItemId))!==sha(ra.map(x=>x.LineItemId)),identityHashChanged:left.hashes.identityHash!==right.hashes.identityHash},accountingHashChanged:left.hashes.accountingHash!==right.hashes.accountingHash,versionSignals,warnings:[]};
}
function readJsonFile(file) {
  if(/^[a-z]+:\/\//i.test(file))throw new DiagnosticError('INVALID_FILE_PATH','URLs are not accepted');
  const resolved=path.resolve(file),stat=fs.statSync(resolved);
  if(!stat.isFile())throw new DiagnosticError('INVALID_FILE_PATH','Compare input must be a local file');
  if(stat.size>MAX_FILE_BYTES)throw new DiagnosticError('FILE_TOO_LARGE','Compare file exceeds 10MB');
  try{return JSON.parse(fs.readFileSync(resolved,'utf8'));}catch(e){throw new DiagnosticError('INVALID_JSON','Compare file is not valid JSON');}
}
async function run(operation,args,api) {
  if(operation==='exact')return exactOperation(args,api);
  if(operation==='page')return pageOperation(args,api);
  if(operation==='paging')return pagingOperation(args,api);
  if(operation==='repeat')return repeatOperation(args,api);
  if(operation==='compare')return compareSnapshots(readJsonFile(args.leftFile),readJsonFile(args.rightFile));
  throw new DiagnosticError('INVALID_OPERATION','Unknown operation');
}
function exitCodeForResult(operation,result) {
  if(operation==='paging'&&!result.summary?.complete&&['MAX_PAGES','MAX_INVOICES'].includes(result.summary?.stoppedBy))return 4;
  if(!result.ok)return result.summary?.stoppedBy==='TRANSPORT_ERROR'?2:3;
  return 0;
}
function errorOutput(operation,e){return {ok:false,operation:operation||null,error:{code:e.code||'UNEXPECTED_ERROR',message:e.code?'Diagnostic request failed':'Unexpected diagnostic failure',details:e.details||{}}};}
async function main(argv=process.argv.slice(2)) {
  let operation=null;
  try{const parsed=parseArgs(argv);operation=parsed.operation;const result=await run(operation,parsed.args);process.stdout.write(`${JSON.stringify(redact(result))}\n`);return exitCodeForResult(operation,result);}
  catch(e){process.stdout.write(`${JSON.stringify(errorOutput(operation||argv[0],e))}\n`);return e.exitCode||1;}
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.stdout.write(`${JSON.stringify(errorOutput(null,new Error()))}\n`);process.exitCode=3;});

module.exports={ DiagnosticError,parseArgs,redact,sanitizeError,canonicalize,sha,sanitizedInvoice,hashInvoice,exactOperation,pageOperation,pagingOperation,repeatOperation,compareSnapshots,readJsonFile,run,exitCodeForResult,main,MAX_FILE_BYTES,INVOICE_IDENTITY_CONTRACT };
