# MKCRM 0.9.19.23 - Inventory Live Repair Search

پایه نسخه: `0.9.19.22_INVOICE_REF_EXPENSE_ALLOWED` که خود بر پایه `0.9.19.21_WS_INVENTORY_SALE_SEARCH_UNIFIED` است.

## هدف
رفع موارد نادر که WebService `GetRemain` در حالت لیست کامل انبار، بعضی کالاهای دارای موجودی را برنمی‌گرداند؛ اما `GetRemain` هدفمند با ItemCode و کاردکس کالا موجودی مثبت را نشان می‌دهند.

## تغییرات
- مسیر عادی سرچ فاکتور فروش و موجودی همچنان Mongo-first باقی ماند؛ کالاهای سالم کند نمی‌شوند.
- اگر سرچ موجودی یا فاکتور فروش نتیجه صفر بدهد و query دقیق/طولانی باشد، fallback هدفمند فعال می‌شود.
- fallback هدفمند ابتدا `GetRemain` با کد کالا را می‌زند، نتیجه مثبت را در `itemInventoryCatalog` upsert می‌کند و سپس همان موتور واحد سرچ را دوباره اجرا می‌کند.
- برای query متنی طولانی، ابتدا از `itemCatalog`/`itemCatalogAll` چند کد محتمل پیدا می‌شود و فقط همان چند کد live repair می‌شوند.
- Negative cache پنج دقیقه‌ای اضافه شد تا سرچ‌های ناموفق فشار تکراری به WebService وارد نکنند.
- در صفحه کاردکس، اگر مانده مثبت دیده شود، snapshot موجودی همان کالا با `GetRemain` هدفمند repair می‌شود.
- endpoint مدیریتی `/api/inventory/consistency-check?itemCode=...&stockNumber=...` اضافه شد.

## تنظیمات جدید .env
```env
LIVE_SEARCH_FALLBACK_ENABLED=true
LIVE_SEARCH_FALLBACK_MIN_LEN=8
LIVE_SEARCH_FALLBACK_NEGATIVE_TTL_MS=300000
LIVE_SEARCH_FALLBACK_MAX_CATALOG_CANDIDATES=5
```

## تست پیشنهادی
1. سرچ کد `8398FGM124` در موجودی و فاکتور فروش.
2. بررسی اینکه اگر snapshot خالی بود، fallback فعال و بعد از چند ثانیه کالا نمایش داده شود.
3. اجرای:
   `/api/inventory/consistency-check?itemCode=8398FGM124&stockNumber=70`
4. بررسی اینکه سرچ‌های عادی کالاهای موجود مثل قبل سریع هستند.

## محدوده تغییر
Inventory Search / Sale Search fallback فقط هنگام نتیجه صفر تغییر کرده است. مسیرهای Tablo، Auto Sync، Lead، Seller Performance، Supplier Aging و Roleها تغییر داده نشده‌اند.
