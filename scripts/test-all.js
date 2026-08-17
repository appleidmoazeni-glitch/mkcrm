'use strict';

function resolveBase(env=process.env){
  const raw=String(env.MKCRM_TEST_BASE_URL||'').trim();
  if(!raw)throw new Error('MKCRM_TEST_BASE_URL is required; automated tests have no implicit runtime target.');
  const url=new URL(raw);
  if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Runtime smoke tests are limited to an explicit local tunnel/server.');
  if(url.port==='1385')throw new Error('Production port 1385 is forbidden for automated tests.');
  const target=String(env.MKCRM_TEST_TARGET||'').trim().toLowerCase();
  if(url.port==='1386'&&target!=='staging')throw new Error('Port 1386 requires MKCRM_TEST_TARGET=staging.');
  if(target==='production')throw new Error('Production is forbidden for automated tests.');
  return url.origin;
}
async function get(url){const r=await fetch(url,{signal:AbortSignal.timeout(5000)});const t=await r.text();console.log('\n###',url,r.status);console.log(t.slice(0,2000));}
async function main(env=process.env){const base=resolveBase(env);for(const path of ['/health','/api/mongo/health','/api/shaygan/health','/api/items/11I0305535/inventory','/api/items/11I0305535/kardex','/api/invoices/last-sale','/api/template-map'])await get(base+path);}
if(require.main===module)main().then(()=>process.exit(0)).catch(error=>{console.error(error.message);process.exit(1);});
module.exports={resolveBase,main};
