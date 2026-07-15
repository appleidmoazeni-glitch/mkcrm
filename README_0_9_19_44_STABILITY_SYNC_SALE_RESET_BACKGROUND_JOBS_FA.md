# MKCRM 0.9.19.44 - Stability / Sync / Sale Reset / Background Jobs

## هدف
این نسخه روی پایداری عملیاتی تمرکز دارد و منطق سود فروشنده را توسعه نمی‌دهد.

## اصلاحات

### 1) Sync All Items Catalog
- توقف زودهنگام روی صفحه کمتر از 100 رکورد حذف شد.
- خواندن تا رسیدن به صفحه خالی ادامه پیدا می‌کند.
- سقف پیش‌فرض صفحات افزایش یافت.
- Diagnostic و JobId برای پیگیری sync اضافه شد.
- خروجی شامل total، upserted، pages، emptyPages و completedAtEnd است.

### 2) صدور فاکتور فروش
- بعد از صدور موفق، state صفحه فروش به صورت کامل برای فاکتور بعدی reset می‌شود.
- saleIssueKey جدید تولید می‌شود.
- cart، selected item، selected stock، discount، extras و locks پاک می‌شوند.
- کاربر نباید برای فاکتور بعدی مجبور به خروج و ورود مجدد به صفحه فروش باشد.

### 3) پردازش‌های زمان‌بر
- collection جدید appJobs اضافه شد.
- Sync All Items به صورت job قابل پیگیری ثبت می‌شود.
- endpoint وضعیت job اضافه شد: /api/jobs/status

## موارد حفظ‌شده
- Sale Snapshot واقعی Type 2 حفظ شد.
- Seller Performance نسخه 43 حفظ شد.
- Supplier Sleep و Purchase Layers حفظ شدند.
- صدور سریع فاکتور و GeneralRef و افزودنی‌ها حفظ شدند.
- SQL مستقیم اضافه نشده است.
