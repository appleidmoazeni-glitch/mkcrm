# MKCRM 0.9.19.21 - Inventory + Sale Search Unified

تمرکز این نسخه فقط روی پایدارسازی موجودی، Sync و سرچ کالا در فاکتور فروش است.

## اصلاحات اصلی
- Auto Sync از حالت یک انبار در هر ۵ دقیقه به Cycle کامل همه انبارهای فعال تغییر کرد.
- در ابتدای هر Cycle، لیست انبارهای فعال دوباره از Mongo خوانده می‌شود؛ تغییر انبارهای فعال از Cycle بعدی اثر دارد.
- Sync انبارها sequential است، نه parallel؛ بین انبارها delay کوتاه دارد.
- اگر Cycle قبلی هنوز در حال اجرا باشد، Cycle جدید شروع نمی‌شود.
- سرچ موجودی انبارها و سرچ فاکتور فروش به موتور واحد `active-inventory-snapshot-unified` وصل شدند.
- سرچ فاکتور فروش دیگر با منطق قدیمی maxAge/stale جداگانه تصمیم نمی‌گیرد.
- فقط موجودی مثبت انبارهای فعال در سرچ فروش و سرچ موجودی نمایش داده می‌شود.
- گروه‌بندی کالا با `itemGuid + itemCode` انجام می‌شود تا کد کالای تکراری در شایگان باعث انتخاب اشتباه نشود.
- fallback محدود live در سرچ فروش حفظ شد؛ اگر snapshot نتیجه نداد، cache اصلاح می‌شود و دوباره از موتور واحد خوانده می‌شود.

## تنظیمات جدید/مهم .env
```env
AUTO_INVENTORY_SYNC_ENABLED=true
AUTO_INVENTORY_SYNC_INTERVAL_MS=300000
AUTO_INVENTORY_SYNC_MODE=full_cycle_sequential
AUTO_INVENTORY_SYNC_STOCKS_PER_TICK=1
AUTO_INVENTORY_SYNC_DELAY_BETWEEN_STOCKS_MS=1000
AUTO_INVENTORY_SYNC_PAGE_LIMIT=300
AUTO_INVENTORY_SYNC_DELETE_STALE_PER_STOCK=true
```

## تست پیشنهادی بعد از نصب
1. اجرای Sync Inventory Catalog و بررسی خروجی ۱۹ انبار فعال.
2. جستجوی کالای مشکل‌دار قبلی در «موجودی انبارها» و «فاکتور فروش» بدون اجرای دستی موجودی انبار.
3. بررسی کالای دارای کد تکراری `8420FC1500` و اطمینان از تفکیک با `itemGuid`.
4. مشاهده `/api/inventory/auto-sync/status` بعد از ۵ تا ۱۰ دقیقه.

## نکته امنیتی
SQL مستقیم همچنان حذف است و موجودی فقط از WebService شایگان خوانده می‌شود.
