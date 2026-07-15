# MKCRM 0.9.19.47 - Supplier Sleep Unified Stable UI

مبنا: 0.9.19.46

هدف: رفع regression نمایشی بعد از کامل شدن Jobهای خواب کالا تأمین‌کننده.

اصلاحات:
- Jobهای پس‌زمینه نسخه 46 حفظ شد.
- جدول «فاکتورهای خرید معتبر» از جدول «مانده واقعی هر فاکتور خرید» جدا شد.
- مانده هر فاکتور از collection `supplierSleepInvoiceSummary` با فیلدهای صحیح نمایش داده می‌شود:
  - `purchaseInvoiceNo`
  - `purchaseDate`
  - `invoiceTotal`
  - `layerPurchaseValue`
  - `remainingValue`
  - `remainingPercent`
  - `itemCount`
  - `layerCount`
- نمایش Purchase Layer بعد از Snapshot اصلاح شد.
- اگر فیلتر supplierAccountNo به‌خاطر اختلاف کد/نام خالی برگشت، لایه‌های همان Snapshot بدون فیلتر supplier دوباره خوانده می‌شود.
- گزارش گروه اصلی با فیلدهای خرید، مانده و درصد مانده کامل‌تر شد.

چیزهای عمداً دست‌نخورده:
- Sale Snapshot
- Seller Performance
- Fast Sale
- GeneralRef
- Invoice extras
- Active Warehouses
- Auto Sync
- بدون SQL مستقیم
