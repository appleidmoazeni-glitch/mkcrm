# MKCRM 0.9.19.55 - Sale Board Stockout Immediate Fix

اصلاح متمرکز تابلو اتمام کالا بعد از فروش:

- بعد از `localInventoryDeduct`، تصمیم تابلو بلافاصله اجرا می‌شود و دیگر به Lead/Customer/background مراحل بعدی وابسته نیست.
- تابع تابلو از خطوط قطعی `localInventoryDeduct.lines` استفاده می‌کند، نه فقط body اولیه.
- برای هر تصمیم تابلو لاگ `sale_issue_post_board_stock_out` ثبت می‌شود؛ حتی اگر skip شود.
- `eventKey` شامل itemCode و invoiceNumber است تا رویداد اتمام کالا بعد از فروش قابل ردیابی باشد.
- مسیر تبدیل پیش‌فاکتور به فاکتور هم با همین منطق جدید اجرا می‌شود.

تغییرات Auto Sync، سرعت صدور فاکتور با InvNo=0، Sale Snapshot و Supplier Sleep دست‌نخورده‌اند.
