# MKCRM 0.9.19.49 - Core Stability Refactor Phase 1

این نسخه توسعه قابلیت سنگین جدید نیست؛ فاز اول refactor مرحله‌ای و تثبیت هسته است.

## اهداف

- اصلاح ساعت تابلو با ساعت سرور، نه ساعت مرورگر کاربر.
- اضافه شدن API زمان سرور: `/api/server-time`.
- استانداردتر شدن خروجی `/api/version` و `/health` با `serverTime`.
- ثبت و نمایش زمان رویدادهای تابلو با `createdAtTehran` و `createdAtDisplay`.
- حفظ منطق پایدار خواب تأمین‌کننده نسخه 48.
- اضافه شدن heartbeat برای Jobهای خواب تأمین‌کننده، تا Refresh بتواند تشخیص دهد Job زنده است یا گیر کرده.
- تقویت guard حذف stale در global GetRemain: اگر sync جدید کمتر از 70٪ آخرین sync کامل باشد، حذف داده‌های قدیمی انجام نمی‌شود.
- حفظ Auto Sync global GetRemain و اعمال Active Warehouses در Mongo/query layer.

## نکات عملیاتی

- بعد از نصب، `/api/version` و `/api/server-time` را کنترل کنید.
- در تابلو، زمان باید بر اساس `Asia/Tehran` و از سمت سرور نمایش داده شود.
- در Auto Sync، اگر WebService خروجی غیرعادی کم بدهد، `staleDeleteBlocked=true` در نتیجه sync ثبت می‌شود.
- در Jobهای خواب کالا، `heartbeatAt` و `heartbeatAgeMs` از `/api/jobs/status` قابل بررسی است.

## تغییر نکرده

- مسیر فروش و صدور فاکتور
- Sale Snapshot نوع 2
- Seller Performance diagnostic
- Supplier Sleep allocation
- Active Warehouses
- GeneralRef و extras فاکتور
- SQL مستقیم اضافه نشده است.
