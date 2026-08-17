'use strict';
const http=require('node:http');

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
async function get(url){return new Promise((resolve,reject)=>{const request=http.get(url,{agent:false},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>{if(text.length<2000)text+=chunk;});response.on('end',()=>{console.log('\n###',url,response.statusCode);console.log(text.slice(0,2000));resolve();});});request.setTimeout(5000,()=>request.destroy(new Error('The operation timed out')));request.on('error',reject);});}
async function main(env=process.env){const base=resolveBase(env);for(const path of ['/health','/api/version','/api/server-time','/api/mongo/health'])await get(base+path);}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={resolveBase,main};
