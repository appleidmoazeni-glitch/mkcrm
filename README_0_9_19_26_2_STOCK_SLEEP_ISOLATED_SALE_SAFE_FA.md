# MKCRM 0.9.19.26.2 - Stock Sleep Isolated Sale-Safe

هدف این نسخه: ایزوله‌سازی کامل فاز خواب کالا از صدور فاکتور.

## اصلاح حیاتی
- حذف اجرای خودکار Kardex/پردازش پس‌زمینه بعد از ایجاد Snapshot.
- Snapshot فقط صف می‌سازد و هیچ تماس WebService سنگین به شایگان انجام نمی‌دهد.
- پردازش فقط با دکمه/endpoint جداگانه `POST /api/stock-sleep/process` انجام می‌شود.
- Sale Engine، PutSaleInvoice، GeneralRef، invoiceAuditLogs، unified inventory/sale search دست‌نخورده از 0.9.19.25 باقی مانده‌اند.

## دلیل
خطای `The underlying provider failed on Open` نشان می‌دهد فشار یا تداخل WebService/Provider شایگان روی مسیر صدور فاکتور رخ داده است. خواب کالا نباید هنگام صدور فروش هیچ پردازشی اجرا کند.

## تست بعد از نصب
1. اول فقط صدور فاکتور را تست کنید.
2. سپس صفحه خواب کالا را باز کنید.
3. فقط `آماده‌سازی Collectionها` و `ایجاد Snapshot تست` را بزنید.
4. تا وقتی صدور پایدار نشده، `پردازش Batch بعدی` را نزنید.
