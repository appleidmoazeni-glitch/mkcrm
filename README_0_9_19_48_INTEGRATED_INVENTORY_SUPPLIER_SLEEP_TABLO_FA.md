# MKCRM 0.9.19.48 - Integrated Inventory / Supplier Sleep / Tablo Stability

مبنای توسعه: `0.9.19.47_SUPPLIER_SLEEP_UNIFIED_STABLE_UI`

## هدف
این نسخه برای رفع regressionهای زنجیره‌ای بعد از نسخه 44 ساخته شده است. تمرکز روی یکپارچگی سه مسیر عملیاتی است:

1. خواب کالا تأمین‌کننده
2. Auto Sync موجودی
3. تابلو ورود/اتمام کالا

## اصلاحات اصلی

### 1) Auto Sync موجودی
مشکل WebService شایگان با `GetRemain + STNumber` باعث جاافتادن چند قلم کالا در هر انبار می‌شد. Auto Sync از این نسخه به جای خواندن انبار به انبار، یک بار `GetRemain` بدون فیلتر انبار را تا انتها می‌خواند و `StoreNumber` هر ردیف را در Mongo نگه می‌دارد.

قابلیت‌های قبلی حفظ شده‌اند:
- Active Warehouses در نمایش/جستجو
- targeted live repair
- repair از Kardex
- negative cache
- cache-based inventory search

حذف stale فقط وقتی انجام می‌شود که اسکن global کامل و طبیعی تمام شود.

### 2) نسخه برنامه در UI
نمایش بالای UI دیگر Node version را نشان نمی‌دهد و نسخه برنامه را از `/api/version` نشان می‌دهد.

### 3) تابلو
- بعد از تبدیل پیش‌فاکتور به فاکتور، همان منطق اتمام کالا اجرا می‌شود.
- نمایش تاریخ تابلو با timezone تهران اصلاح شد.

### 4) خواب کالا تأمین‌کننده
- فاکتورهایی که مانده صفر دارند اما لایه خرید معتبر دارند، دیگر نیمه‌کاره دیده نمی‌شوند؛ وضعیت آنها `کامل مصرف/فروش شده` است.
- جدول مانده هر فاکتور خرید، هم تعداد/لایه خرید و هم تعداد/لایه مانده را جدا نشان می‌دهد.
- نمایش لایه‌های هر گروه اصلی کالا فعال شد.

## خط قرمزهای حفظ‌شده
- بدون SQL عملیاتی جدید
- Sale Snapshot و Seller Performance دست نخورده‌اند
- Fast Sale، GeneralRef، Invoice Extras و Reset فروش حفظ شده‌اند
- Jobهای خواب کالا مستقل از صفحه حفظ شده‌اند

## تست
Syntax check روی فایل‌های اصلی انجام شد:
- `src/server.js`
- `src/lib/purchase-sleep.js`
- `src/lib/sale-snapshot.js`
- `src/lib/stock-sleep.js`
- `src/lib/shaygan.js`
- `public/assets/app.js`

Smoke عملیاتی نیازمند Mongo و WebService شایگان روی سرور است.
