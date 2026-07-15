# MKCRM Project Rules

Version: 0.8.9-purchase-draft-operational-from-084

- Base module turnover/گردش حساب remains frozen from confirmed 0.8.4 behavior.
- Internal network login: http://172.31.31.217:1385/login
- APP_HOST=0.0.0.0, PORT=1385, PUBLIC_BASE_URL=http://172.31.31.217:1385
- 127.0.0.1 is only for testing on the server.
- Purchase draft is internal only in this stage and must not post to Shaygan.
- Supplier for purchase draft must be selected from Shaygan account search.
- Seller purchase access is enabled per user by admin via Users page (canPurchase).


## 0.9.5 Purchase Document Control Rules
- 0.9.4 is the baseline for purchase issue.
- Purchase invoice numbering must use InvTyp=3 only.
- Sale and purchase numbering are independent.
- Purchase draft status issuing prevents duplicate clicks.
- Turnover module is frozen and must not be modified without explicit request.


## Rule 0.9.7
- برای چاپ فاکتور فروش، نام فروشگاه باید از userShayganMappings.storeName خوانده شود.
- در چاپ فاکتور فروش نام انبار نمایش داده نمی‌شود؛ کد کالا و سریال نمایش داده می‌شود.
- تخفیف فروش header-level discount است و باید به Invoice/Put ارسال شود.
- برای آماده‌سازی استفاده همزمان، هیچ sync سنگینی در startup یا هنگام صدور فاکتور اجرا نشود.
