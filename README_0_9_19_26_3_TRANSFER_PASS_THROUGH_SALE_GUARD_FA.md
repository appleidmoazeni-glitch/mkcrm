# MKCRM 0.9.19.26.3 - Stock Sleep Transfer Pass-Through + Sale Session Guard

## اصلاحات خواب کالا
- انتقال بین انبارها دیگر به عنوان منشأ خرید/تأمین‌کننده وارد Summary نمی‌شود.
- ردیف‌های مثبت کاردکس فقط وقتی خرید محسوب می‌شوند که انتقال داخلی نباشند و نوع سند خرید باشد یا نوع سند خالی باشد.
- فیلدهای `sourceMovementText` و `sourceMovementType` برای Diagnostic در لایه‌ها ذخیره می‌شوند.
- API جدید `/api/stock-sleep/process-all` اضافه شد.
- دکمه UI «پردازش تا تکمیل» اضافه شد تا Batch دستی چندباره لازم نباشد.

## اصلاحات Sale Guard
- برای کاربران غیرادمین، fallback به اولین mapping حذف شد.
- صدور فاکتور اکنون `sessionUsername` ارسال می‌کند. اگر کاربر صفحه با Cookie سرور ناهماهنگ باشد، صدور متوقف می‌شود و پیام Logout/Login می‌دهد.
- Manual mapping fallback فقط برای Admin مجاز است.

## محدوده حفظ‌شده
- Sale Engine 0.9.19.25 حفظ شده است.
- SQL مستقیم اضافه نشده است.
- خواب کالا همچنان فقط snapshot/background است.
