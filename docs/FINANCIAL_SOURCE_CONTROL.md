# Financial Source Control

مسیر اصلی رابط کاربری: `#financial-source-control`

این ماژول مرز دائمی کنترل و ممیزی منابع مالی FIFO است. داده‌های عملیاتی
`supplierPurchaseLayers`، `fifoAllocations`، `manualCostResolutions` و Dataset
Stateها را فقط می‌خواند. در این فاز هیچ API برای فعال‌سازی Purchase یا FIFO
وجود ندارد.

## مدل داده الحاقی

- `financialSourceReviews`: وضعیت Review هر Candidate با optimistic revision،
  تفکیک حسابداری و مدیر و audit داخلی.
- `financialSourceReviewActions`: اقدام‌های immutable روی ردیف‌های مأخذ؛ هر
  بررسی، mismatch یا note یک سند append-only مستقل است.
- `openingInventoryEvidence`: مدرک موجودی آغازین با Draft → Pending → Approved،
  بهای ثابت‌مقیاس، content hash و تأیید مستقل.

Index و ایجاد collection فقط در `initMongo()` انجام می‌شود. مسیرهای GET هیچ
index یا document ایجاد نمی‌کنند.

## API

- `GET /api/accounting/financial-source-control/overview`
- `GET /api/accounting/financial-source-control/purchase/delta`
- `GET /api/accounting/financial-source-control/gaps`
- `GET /api/accounting/financial-source-control/evidence`
- `GET /api/accounting/financial-source-control/fifo/lines`
- `GET /api/accounting/financial-source-control/fifo/summary`
- `GET /api/accounting/financial-source-control/review-center`
- `GET /api/accounting/financial-source-control/activation-preview/:type/:id`
- `POST /api/accounting/financial-source-control/line-actions`
- `POST /api/accounting/financial-source-control/reviews/:type/:id/:action`
- `POST|PUT /api/accounting/financial-source-control/opening-evidence...`

Activation Preview صرفاً read-only است. endpoint فعال‌سازی عمداً وجود ندارد.

## نقش‌ها

- Read: `accounting`, `manager`, `admin`
- ایجاد/ارسال Evidence و Review حسابداری: `accounting`, `admin`
- تأیید مستقل: `manager`, `admin`
- `seller` و سایر نقش‌ها مجاز نیستند.

## قرارداد سود

گزارش تجمعی فقط `Proven FIFO Profit` را منتشر می‌کند و آن را Total Profit
نمی‌نامد. ردیف‌های `PARTIAL` و `UNKNOWN` سود قطعی ندارند. پنج نوع مأخذ پشتیبانی
شده در projection عبارت‌اند از official single/multi layer، manual purchase
layer، manual item legacy و opening evidence. مصرف Opening Evidence در ساخت FIFO
Candidate آینده باید با مجوز Phase مستقل انجام شود؛ ثبت یا تأیید مدرک در این
ماژول هیچ FIFO موجودی را تغییر نمی‌دهد.

## Performance و Safety

لیست‌ها در Backend فیلتر و صفحه‌بندی می‌شوند و Browser هیچ allocation dataset
کاملی دریافت نمی‌کند. مسیر عادی UI فقط Mongo read model را می‌خواند و هیچ تماس
request-time با Shaygan ندارد. تمام اقدام‌های انسانی actor، role، timestamp،
revision، state قبلی/جدید، reason و fingerprint مأخذ را نگه می‌دارند.

## Unified Engine Guardrail

- `sale-snapshot.js`: **CANONICAL ENGINE** برای Sale Snapshot.
- `purchase-layer-dataset.js`: **CANONICAL ENGINE** برای Purchase Dataset و
  `supplierPurchaseLayers`.
- `fifo-shadow-engine.js`, `seller-financial-performance.js` و این ماژول:
  **CONSUMER**؛ مالک extraction فروش/خرید نیستند.
- `purchase-history-recovery.js`: **DIAGNOSTIC ONLY**؛ خروجی آن فقط Evidence
  Queue است (`layerWrites: 0`) و خرید بازیابی‌شده باید توسط Purchase Engine
  canonical وارد Candidate شود.
- Manual Cost و Opening Inventory Evidence: Evidence governed هستند و نه Sale
  Engine، Purchase Engine یا FIFO patch.

اصل الزام‌آور: **One Sale Engine. One Purchase Engine. Many Consumers.**
