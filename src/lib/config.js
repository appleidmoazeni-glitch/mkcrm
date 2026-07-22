const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

function envFlag(value) {
  return /^(true|1|yes|on)$/i.test(String(value || '').trim());
}

const config = {
  port: Number(process.env.PORT || 1385),
  host: process.env.APP_HOST || '0.0.0.0',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  stagingReadOnly: envFlag(process.env.STAGING_READ_ONLY),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mkcrm',
  mongoBackupAllowedRoots: String(process.env.MONGO_BACKUP_ALLOWED_ROOTS || process.env.MONGO_BACKUP_ROOT || '').split(',').map(x=>x.trim()).filter(Boolean),
  mongoDumpBinary: process.env.MONGODUMP_BINARY || 'mongodump',
  shayganBaseUrl: process.env.SHAYGAN_BASE_URL || 'http://192.168.1.253:2030',
  shayganConnectionName: process.env.SHAYGAN_CONNECTION_NAME || 'SampleConnection',
  shayganApiVersion: process.env.SHAYGAN_API_VERSION || '1.0',
  defaultSaleInvType: Number(process.env.DEFAULT_SALE_INV_TYPE || 2),
  dateMode: process.env.SHAYGAN_DATE_MODE || 'gregorian8',
  invoiceReservationMinutes: Number(process.env.INVOICE_RESERVATION_MINUTES || 15),
  searchPageLimit: Number(process.env.SEARCH_PAGE_LIMIT || 80),
  searchRowCount: Math.min(Number(process.env.SEARCH_ROW_COUNT || 100), 100),
  shayganTimeoutMs: Number(process.env.SHAYGAN_TIMEOUT_MS || 15000),
  invoiceScanMaxPages: Number(process.env.INVOICE_SCAN_MAX_PAGES || 300),
  inventorySearchLivePages: Number(process.env.INVENTORY_SEARCH_LIVE_PAGES || 180),
  inventorySearchFallbackPages: Number(process.env.INVENTORY_SEARCH_FALLBACK_PAGES || 30),
  liveSearchFallbackEnabled: String(process.env.LIVE_SEARCH_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false',
  liveSearchFallbackMinLen: Number(process.env.LIVE_SEARCH_FALLBACK_MIN_LEN || 8),
  liveSearchFallbackNegativeTtlMs: Number(process.env.LIVE_SEARCH_FALLBACK_NEGATIVE_TTL_MS || 300000),
  liveSearchFallbackMaxCatalogCandidates: Number(process.env.LIVE_SEARCH_FALLBACK_MAX_CATALOG_CANDIDATES || 5),
  itemSearchQuickPages: Number(process.env.ITEM_SEARCH_QUICK_PAGES || 8),
  inventoryCatalogSyncPages: Number(process.env.INVENTORY_CATALOG_SYNC_PAGES || 5000),
  accountSearchPages: Number(process.env.ACCOUNT_SEARCH_PAGES || 220),
  kardexSellerMaxRows: Number(process.env.KARDEX_SELLER_MAX_ROWS || 20),
  kardexAdminQuickMaxRows: Number(process.env.KARDEX_ADMIN_QUICK_MAX_ROWS || 50),
  kardexAdminFullMaxRows: Number(process.env.KARDEX_ADMIN_FULL_MAX_ROWS || 100),
  kardexRequestTimeoutMs: Number(process.env.KARDEX_REQUEST_TIMEOUT_MS || 6000),
  autoSyncInventoryCatalog: String(process.env.AUTO_SYNC_INVENTORY_CATALOG || 'false').toLowerCase() === 'true',
  // 0.9.19.19: low-pressure rotating inventory refresh from Shaygan WebService.
  autoInventorySyncEnabled: String(process.env.AUTO_INVENTORY_SYNC_ENABLED || process.env.AUTO_SYNC_INVENTORY_CATALOG || 'false').toLowerCase() === 'true',
  autoInventorySyncIntervalMs: Number(process.env.AUTO_INVENTORY_SYNC_INTERVAL_MS || 600000),
  autoInventorySyncStocksPerTick: Number(process.env.AUTO_INVENTORY_SYNC_STOCKS_PER_TICK || 1), // legacy; 0.9.19.21 uses full-cycle sequential sync
  autoInventorySyncDelayBetweenStocksMs: Number(process.env.AUTO_INVENTORY_SYNC_DELAY_BETWEEN_STOCKS_MS || 1000),
  autoInventorySyncPageLimit: Number(process.env.AUTO_INVENTORY_SYNC_PAGE_LIMIT || 300),
  autoInventorySyncDeleteStalePerStock: String(process.env.AUTO_INVENTORY_SYNC_DELETE_STALE_PER_STOCK || 'true').toLowerCase() !== 'false',
  saleInventorySnapshotMaxAgeMinutes: Number(process.env.SALE_INVENTORY_SNAPSHOT_MAX_AGE_MINUTES || 30)
};

module.exports = { config };
