# MKCRM 0.9.19.17 WS NO SQL FULL REPLACE

این بسته کامل از نسخه عملیاتی 0.9.19.17 ساخته شده و اتصال مستقیم SQL/mssql از مسیر عملیاتی حذف شده است.

- src/lib/shaygan-sql-read.js حذف شد.
- dependency mssql حذف شد.
- SHAYGAN_SQL_* از .env و .env.example حذف شد.
- خواندن‌ها باید از WebService/Mongo انجام شوند.
- .env عملیاتی سرور را قبل از نصب بکاپ بگیرید و overwrite نکنید مگر آگاهانه.
