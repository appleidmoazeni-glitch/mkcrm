# MKCRM 0.9.19.46 - Supplier Sleep Detached Background Jobs

## هدف
رفع ایراد عملیاتی خواب کالا تأمین‌کننده که در نسخه 0.9.19.45 هنوز در دو نقطه به حضور کاربر در صفحه وابسته بود:

1. دکمه «خواندن مرحله‌ای فاکتورهای خرید» request مستقیم اجرا می‌کرد و با ترک صفحه قابل اتکا نبود.
2. دکمه «تحلیل و کنترل صحت» Job داشت، اما UI بعد از زمان ثابت پیام «Job هنوز تمام نشده است» می‌داد و ادامه وضعیت را درست نگه نمی‌داشت.

## اصلاحات
- افزودن endpoint جدید:
  - `POST /api/supplier-sleep/selected-supplier-invoices-job`
- تبدیل خواندن فاکتورهای خرید تأمین‌کننده به Job مستقل در `appJobs`.
- حفظ lock مشترک برای جلوگیری از اجرای همزمان Jobهای سنگین خواب کالا روی WebService شایگان.
- ذخیره `jobId` در مرورگر برای ادامه مشاهده وضعیت بعد از ترک صفحه/بازگشت.
- اصلاح UI خواب کالا تأمین‌کننده برای دکمه Refresh / وضعیت Job.
- اصلاح پیام UI: Job طولانی دیگر خطا تلقی نمی‌شود؛ وضعیت running/queued نمایش داده می‌شود.

## حفظ‌شده‌ها
- منطق allocation و پایداری 0.9.19.45 حفظ شد.
- Sale Snapshot، Seller Performance، Fast Sale، GeneralRef، Invoice Extras، Active Warehouses دست‌نخورده باقی ماندند.
- SQL مستقیم جدید اضافه نشده است.

## تست
- `node --check src/server.js`
- `node --check src/lib/purchase-sleep.js`
- `node --check public/assets/app.js`

Smoke عملیاتی به Mongo/Shaygan وابسته است و باید روی سرور اجرا شود.
