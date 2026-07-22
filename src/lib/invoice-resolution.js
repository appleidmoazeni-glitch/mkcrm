'use strict';

function createInvoiceResolver({getInvoice,supportedTypes,ttlMs=5*60*1000,maxEntries=200,now=Date.now}){
  const cache=new Map();
  async function resolve(invNo){
    const key=String(invNo),cached=cache.get(key);
    if(cached&&cached.expiresAt>now())return cached.candidates;
    if(cached)cache.delete(key);
    const responses=await Promise.all(supportedTypes.map(async invType=>({invType,response:await getInvoice(invNo,invType)})));
    if(responses.some(x=>!x.response?.ok))throw new Error('INVOICE_RESOLUTION_SERVICE_FAILED');
    const candidates=[],seen=new Set();
    for(const {invType,response} of responses)for(const inv of response.list||[]){
      if(Number(inv.InvNo||inv.InvoiceNumber||0)!==Number(invNo)||Number(inv.InvTyp||inv.InvoiceType||0)!==invType||seen.has(invType))continue;
      seen.add(invType);candidates.push({invType,invNo:Number(invNo),invDate:inv.InvDate||'',accountName:inv.AccountName||'',invoice:inv});
    }
    if(cache.size>=maxEntries)cache.delete(cache.keys().next().value);
    cache.set(key,{expiresAt:now()+ttlMs,candidates});
    return candidates;
  }
  return {resolve,clear:()=>cache.clear(),size:()=>cache.size};
}

module.exports={createInvoiceResolver};
