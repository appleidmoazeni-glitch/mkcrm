# MKCRM 0.9.19.35 - Sale Snapshot RowCount20 + Seller Link

## هدف
راه‌اندازی عملیاتی Sale Snapshot بر اساس endpoint واقعی `Invoice/Get` شایگان.

## تغییرات
- استفاده از `Invoice/Get` با `InvoiceType.From=6` و `InvoiceType.To=7`.
- Paging با `RowStart=0,20,40,...` و `RowCount=20`.
- حذف وابستگی به Detail Fetch جداگانه؛ Body داخل همان خروجی خوانده می‌شود.
- ذخیره فروش به تفکیک کاندید نوع ۶ و ۷.
- اتصال هر فاکتور و ردیف فروش به اطلاعات مهم فروشنده/نماینده:
  - AccountNumber / AccountName
  - SAccountNumber
  - FirstIssuerUsername
  - LastIssuerUsername
  - GeneralRef
  - STNumber / STDesc
- سود تأمین‌کننده همچنان متوقف است؛ فقط زیرساخت فروش ساخته می‌شود.

## تست پیشنهادی
1. مدیریت → Sale Snapshot
2. از تاریخ: `14050101`
3. حداکثر صفحات: ابتدا 5، بعد 50، بعد کامل
4. انتظار تست اولیه با 5 صفحه: حدود 100 فاکتور کاندید فروش و Body/Line > 0
5. بررسی Diagnostic: Type 6، Type 7، Seller Stats

## هشدار
InvTyp 6 و 7 فعلاً به‌عنوان `SaleCandidate` ذخیره می‌شوند تا بعد از تطبیق با شایگان نام قطعی حسابداری آنها تعیین شود.
