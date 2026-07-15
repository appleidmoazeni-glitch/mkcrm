# MKCRM 0.9.19.34 - SALE SNAPSHOT ENGINE

تمرکز نسخه:
- توقف توسعه سود تأمین‌کننده در همین نسخه
- حفظ فازهای ماقبل سود در خواب کالا تأمین‌کننده:
  - فاکتورهای خرید تأمین‌کننده
  - Reconciliation
  - LayerId
  - مانده واقعی هر فاکتور خرید
  - گروه اصلی کالا
  - True Reverse FIFO
- راه‌اندازی Sale Snapshot مستقل برای فازهای بعدی سود، عملکرد فروشنده، استراتژی خرید و پیش‌بینی بازار

Collectionهای جدید:
- saleSnapshots
- saleInvoiceHeaders
- saleInvoiceLines
- saleSnapshotDiagnostics

APIهای جدید:
- POST /api/sale-snapshot/init
- POST /api/sale-snapshot/start
- GET /api/sale-snapshot/snapshots
- GET /api/sale-snapshot/status
- GET /api/sale-snapshot/lines

نکات تست:
1. ابتدا موجودی انبار 70 را کنترل کنید که dedupe نسخه 32 حفظ شده باشد.
2. از مدیریت → Sale Snapshot آماده‌سازی را بزنید.
3. ساخت Sale Snapshot را با بازه 14050101 و حداکثر صفحات 100 تا 300 شروع کنید.
4. Diagnostic باید نشان دهد:
   - تعداد فاکتور فروش Header
   - تعداد Body فروش خوانده‌شده
   - تعداد ردیف کالای فروش
   - تعداد Body خالی
5. خواب کالا تأمین‌کننده باید بدون محاسبه سود همچنان مانده واقعی، LayerId، گروه اصلی و Reconciliation را نشان دهد.

SQL مستقیم استفاده نشده است.
Sale Engine صدور فاکتور تغییر داده نشده است.
