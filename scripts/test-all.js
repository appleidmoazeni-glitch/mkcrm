async function get(url){const r=await fetch(url); const t=await r.text(); console.log('\n###',url,r.status); console.log(t.slice(0,2000));}
(async()=>{const base='http://127.0.0.1:1385';for(const u of ['/health','/api/mongo/health','/api/shaygan/health','/api/items/11I0305535/inventory','/api/items/11I0305535/kardex','/api/invoices/last-sale','/api/template-map']) await get(base+u);})();
