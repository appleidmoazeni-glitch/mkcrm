# MKCRM 0.9.19.19 - WS Auto Inventory Sync

این نسخه بر پایه `0.9.19.18_WS_INVENTORY_CACHE_STABILIZED` ساخته شده و SQL مستقیم ندارد.

## اصلاحات اصلی

- Auto Inventory Sync چرخشی برای انبارهای فعال اضافه شد.
- هر ۵ دقیقه فقط تعداد محدودی از انبارهای فعال خوانده می‌شود تا به WebService شایگان فشار ناگهانی وارد نشود.
- دکمه `sync inventory catalog` حالا موجودی مثبت همه انبارهای فعال را جداگانه از WebService می‌خواند و در Mongo upsert می‌کند.
- stale delete فقط برای همان انبار و فقط بعد از sync کامل همان انبار انجام می‌شود.
- اگر sync ناقص باشد، cache سالم قبلی حذف نمی‌شود.

## تنظیمات .env جدید

```env
AUTO_INVENTORY_SYNC_ENABLED=true
AUTO_INVENTORY_SYNC_INTERVAL_MS=300000
AUTO_INVENTORY_SYNC_STOCKS_PER_TICK=1
AUTO_INVENTORY_SYNC_PAGE_LIMIT=80
AUTO_INVENTORY_SYNC_DELETE_STALE_PER_STOCK=true
```

## نکته عملیاتی

- در ساعت کاری، auto sync فقط چرخشی و سبک است.
- sync دستی catalog همه انبارهای فعال را می‌خواند؛ بهتر است خارج از ساعت شلوغ اجرا شود.
- نسخه همچنان WebService-only است و `mssql` ندارد.
