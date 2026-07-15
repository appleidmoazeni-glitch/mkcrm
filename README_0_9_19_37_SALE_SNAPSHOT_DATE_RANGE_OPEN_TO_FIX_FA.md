# MKCRM 0.9.19.38 - Sale Snapshot Date Range Open-To Fix

- رفع مشکل اصلی نسخه 35/36: وقتی dateTo خالی بود سیستم به اشتباه dateTo را برابر dateFrom می‌گذاشت و فقط همان روز را اسکن می‌کرد.
- اکنون dateFrom=14050101 و dateTo خالی به صورت بازه باز از تاریخ شروع تا انتها به Invoice/Get ارسال می‌شود.
- Version در server/package/UI به 0.9.19.38 تغییر کرد.
- Sale Snapshot همچنان با Invoice/Get، InvoiceType 6 تا 7، RowCount=20 و RowStart مرحله‌ای کار می‌کند.
- Body فروش مستقیم از Result خوانده می‌شود.
- اتصال صندوق/نماینده/issuer حفظ شد.
- سود تامین‌کننده همچنان غیرفعال است.
