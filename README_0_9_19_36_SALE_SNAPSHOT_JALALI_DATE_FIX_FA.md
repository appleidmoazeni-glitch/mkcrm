# MKCRM 0.9.19.36 - Sale Snapshot Jalali Date Fix

- اصلاح علت خوانده نشدن فروش‌ها در Sale Snapshot.
- تاریخ شمسی ورودی مثل 14050101 قبل از ارسال به Invoice/Get به تاریخ میلادی شایگان تبدیل می‌شود.
- Invoice/Get با InvoiceType 6 تا 7، RowCount=20 و RowStart مرحله‌ای اجرا می‌شود.
- Body فروش از همان خروجی Invoice/Get خوانده می‌شود.
- اتصال فروش به صندوق/نماینده/Issuer حفظ شد.
- سود تأمین‌کننده همچنان توسعه داده نشده و فقط فاز Snapshot فروش عملیاتی است.
