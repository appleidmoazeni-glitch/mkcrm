# MKCRM 0.9.19.28 - Supplier Sleep LayerId Dashboard

تمرکز نسخه:
- تثبیت موتور خواب کالا تأمین‌کننده بر پایه فاکتور خرید معتبر.
- حفظ Validation/Reconciliation نسخه 0.9.19.27.5.
- افزودن LayerId پایدار برای هر Purchase Layer.
- افزودن مانده واقعی هر فاکتور خرید.
- افزودن داشبورد مدیریتی تأمین‌کننده.
- افزودن گزارش گروه کالایی.
- آماده‌سازی فیلدهای سود/ROI بدون تولید عدد غیرواقعی تا زمان اتصال فروش FIFO.

قواعد حفظ‌شده:
- بدون SQL مستقیم.
- بدون GetKardex برای تشخیص منشأ.
- بدون تغییر Sale Engine.
- بدون تغییر تابلو، Auto Sync، Active Warehouses، Search و GeneralRef.

نکته سود/ROI:
در این نسخه فیلدهای `estimatedProfitAmount`, `roiPercent`, `profitStatus` در خروجی‌ها وجود دارد، اما تا قبل از اتصال فروش FIFO مقدار سود/ROI قطعی تولید نمی‌شود و وضعیت `PENDING_SALES_FIFO_LINK` ثبت می‌شود.
