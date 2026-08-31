'use strict';

const MAX_SAMPLES_PER_CLASS = 500;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const samples = new Map();

function trafficClass(pathname='') {
  const path=String(pathname||'');
  if (/^\/api\/sales\/(?:issue|issuance\/)/.test(path)||path==='/admin/accounting/putInvoice') return 'P0_INVOICE';
  if (/^\/api\/(?:items\/search|inventory\/search|legacy\/(?:productName|stock)\/search)/.test(path)) return path.includes('inventory')||path.includes('/stock/')?'P1_INVENTORY':'P1_SEARCH';
  if (/^\/api\/(?:cardex|item\/cardex|items\/[^/]+\/cardex)/.test(path)) return 'P1_KARDEX';
  return '';
}

function observe(pathname,durationMs,statusCode,at=new Date()) {
  const key=trafficClass(pathname);if(!key)return;
  const list=samples.get(key)||[];
  list.push({at:new Date(at),durationMs:Math.max(0,Number(durationMs||0)),statusCode:Number(statusCode||0)});
  if(list.length>MAX_SAMPLES_PER_CLASS)list.splice(0,list.length-MAX_SAMPLES_PER_CLASS);
  samples.set(key,list);
}

function percentile(values,ratio){if(!values.length)return 0;const ordered=values.slice().sort((a,b)=>a-b);return ordered[Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*ratio)-1))];}
function snapshot(options={}) {
  const now=options.now?new Date(options.now):new Date(),windowMs=Math.max(1000,Number(options.windowMs||DEFAULT_WINDOW_MS)),from=now.getTime()-windowMs;
  const classes={};
  for(const key of ['P0_INVOICE','P1_SEARCH','P1_INVENTORY','P1_KARDEX']){
    const current=(samples.get(key)||[]).filter(row=>new Date(row.at).getTime()>=from),durations=current.map(row=>row.durationMs),failures=current.filter(row=>row.statusCode>=500||row.statusCode===0).length;
    classes[key]={count:current.length,failures,errorRate:current.length?failures/current.length:0,p50Ms:percentile(durations,0.5),p95Ms:percentile(durations,0.95),lastAt:current.at(-1)?.at||null};
  }
  return {at:now,windowMs,classes};
}

function reset(){samples.clear();}

module.exports={trafficClass,observe,snapshot,_reset:reset};
