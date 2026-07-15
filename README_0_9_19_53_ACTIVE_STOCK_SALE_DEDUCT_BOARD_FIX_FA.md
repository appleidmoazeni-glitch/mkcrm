# MKCRM 0.9.19.53 - Active Stock Sync + Sale Deduct + Board Fix

این نسخه بر پایه 0.9.19.52 ساخته شده و فقط روی موجودی عملیاتی، کسر موجودی بعد از فروش، حذف duplicateهای سرچ، و تابلو اتمام کالا تمرکز دارد.

## تغییرات اصلی

1. Auto Sync از حالت Global + Active برگشت به خواندن مرحله‌ای انبارهای فعال.
   - Global GetRemain از Auto Sync عملیاتی حذف شد.
   - Sync انبارهای فعال positive-only است و موجودی مثبت را حذف نمی‌کند.

2. بعد از صدور موفق فاکتور فروش، موجودی local CRM بلافاصله کم می‌شود.
   - کلید: itemCode + stockNumber
   - فیلدهای ثبت‌شده: lastLocalSaleDeductAt, lastSaleInvoiceNo, pendingShayganConfirm, sourceEvidence=local-sale-deduct

3. تابلو اتمام کالا بعد از فروش از snapshot محلی بعد از کسر فروش تصمیم می‌گیرد.
   - دیگر برای تصمیم اولیه تابلو live refresh اجرا نمی‌شود.
   - اگر جمع موجودی کالا در همه انبارهای فعال صفر شد، رویداد stock_out ثبت می‌شود.

4. جلوی برگشت فوری موجودی فروخته‌شده توسط Auto Sync گرفته شد.
   - اگر ردیف با local-sale-deduct صفر شده و pendingShayganConfirm دارد، Auto Sync تا TTL کوتاه نمی‌تواند با پاسخ stale آن را مثبت کند.

5. Duplicateهای سرچ موجودی/فروش مقاوم‌تر ادغام می‌شوند.
   - key نمایشی: stockNumber + itemCode
   - گروه‌بندی فروش بر پایه itemCode انجام می‌شود تا خواندن چندمسیره یک کالا را چند بار نشان ندهد.

## تست پیشنهادی

1. یک کالا که آخرین موجودی آن در کل انبارهای فعال است انتخاب کن.
2. قبل از صدور، موجودی آن در CRM را بررسی کن.
3. فاکتور فروش صادر کن.
4. بلافاصله موجودی همان کالا را بررسی کن؛ باید صفر شود.
5. تابلو باید رویداد «اتمام کالا» برای آن itemCode بسازد.
6. بعد از Auto Sync، موجودی صفرشده نباید دوباره مثبت شود مگر اینکه live item refresh واقعاً موجودی مثبت بدهد.

## محدوده‌ای که دست نخورده

- Sale Snapshot
- Supplier Sleep
- Seller Performance
- Customer/Lead logic
