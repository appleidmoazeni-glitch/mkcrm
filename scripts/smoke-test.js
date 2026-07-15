const { connectMongo, initMongo, closeMongo } = require('../src/lib/mongo');
const shaygan = require('../src/lib/shaygan');
const { config } = require('../src/lib/config');
(async()=>{
  console.log('Config:', { baseUrl: config.shayganBaseUrl, connectionName: config.shayganConnectionName, node: process.version });
  try { await initMongo(); const db=await connectMongo(); await db.command({ping:1}); console.log('Mongo ok: true'); } catch(e) { console.log('Mongo ok: false error:', e.message); process.exitCode=1; }
  const stock=await shaygan.getStocks(); console.log('Stock ok:',stock.ok,'count:',stock.list?.length||0,'error:',stock.error||'');
  const inv=await shaygan.getInventoryByItemCode('11I0305535'); console.log('Inventory ok:',inv.ok,'count:',inv.list?.length||0,'first:',inv.list?.[0]||null,'error:',inv.error||'');
  const kar=await shaygan.getKardexByItemCode('11I0305535'); console.log('Kardex ok:',kar.ok,'rows:',kar.rows?.length||0,'item:',kar.item,'error:',kar.error||'');
  const last=await shaygan.getLastSaleInvoiceNumber(); console.log('Last sale number ok:',last.ok,'last:',last.last,'count:',last.count,'error:',last.error||'');
  console.log('Search smoke skipped. Use UI Reports > Sync Catalog or /api/items/search?q=lenovo');
  await closeMongo();
})().catch(e=>{console.error(e);process.exit(1)});
