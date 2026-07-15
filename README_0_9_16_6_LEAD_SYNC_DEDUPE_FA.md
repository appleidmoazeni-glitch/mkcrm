# MKCRM 0.9.16.6 - Lead Sync Dedupe + Audit Fix

- حذف ردیف‌های تکراری گزارش کنترل Lead که از saleIssueLocks و invoiceAuditLogs دوبار می‌آمدند.
- نرمال‌سازی نام Closer از username به نام نمایشی کاربر.
- افزودن وضعیت sync در گزارش Lead: success / failed / not_required / not_configured.
- حفظ اتصال نرم Lead ID و عدم توقف صدور فاکتور در صورت خطای sync.
