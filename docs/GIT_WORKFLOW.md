# MKCRM Git Workflow

این سند روند پیشنهادی و قابل بازبینی انتشار MKCRM را تعریف می‌کند. تغییرات عملیاتی برنامه، تنظیمات محرمانه و فایل‌های `.env` بخشی از این workflow نیستند و نباید در Git ثبت شوند.

## مسیر تغییر تا Production

1. هر تغییر از آخرین `develop` در یک Branch مستقل با پیشوند `feature/`, `fix/` یا `chore/` انجام می‌شود.
2. Branch به remote ارسال و یک Pull Request به `develop` ایجاد می‌شود.
3. review کد و تست‌های خودکار باید پیش از merge به `develop` موفق باشند.
4. محیط staging فقط از `develop` و با `STAGING_READ_ONLY=true` به‌روزرسانی می‌شود.
5. smoke testهای staging اجرا و نتیجه آن‌ها در Pull Request یا گزارش انتشار ثبت می‌شود.
6. پس از تأیید staging، `develop` از طریق Pull Request بازبینی‌شده به `main` merge می‌شود.
7. Production فقط از Commit تأییدشده روی `main` منتشر می‌شود.

```text
feature/fix/chore branch
        ↓ Pull Request + review
      develop
        ↓ staging deploy + smoke test
       main
        ↓ controlled release
    Production
```

هیچ Branch کاری نباید مستقیماً در Production منتشر شود. برای `develop` و `main` استفاده از branch protection، review اجباری و منع force-push توصیه می‌شود.

## بررسی‌های قبل از Push

از root مخزن اجرا شود:

```bash
git status --short --branch
git diff --check
node --check src/server.js
npm run test:all
```

`npm run smoke` به MongoDB و Shaygan WebService تنظیم‌شده متصل می‌شود؛ بنابراین فقط در محیط staging مجاز و پس از بررسی مقصدهای configuration اجرا شود.

## به‌روزرسانی امن Staging

دستورها باید در مسیر نصب اختصاصی staging اجرا شوند. قبل از شروع، خروجی `git status` باید clean باشد. وجود تغییر محلی به معنی توقف deployment و بررسی دستی است.

```bash
cd /path/to/mkcrm-staging
git status --short --branch
git fetch origin
git switch develop
git pull --ff-only origin develop
git rev-parse HEAD
npm install --omit=dev --no-package-lock
STAGING_READ_ONLY=true pm2 restart ecosystem.config.js --update-env
pm2 status
curl --fail --silent --show-error http://127.0.0.1:1385/health
```

نکات ایمنی:

- از `git reset --hard`، force-push و merge دستی روی سرور staging استفاده نشود.
- اگر `git pull --ff-only` ناموفق شد، deployment متوقف شود؛ conflict روی سرور حل نشود.
- مقادیر `.env`، credentialهای MongoDB و Shaygan و سایر secretها فقط توسط مدیریت محیط نگهداری شوند.
- پیش از restart، باید تأیید شود `MONGO_URI` به MongoDB مستقل staging اشاره می‌کند.
- پیش از `npm run smoke`، باید تأیید شود `SHAYGAN_BASE_URL` مقصد مورد انتظار تست است؛ smoke موجود عملیات خواندنی روی Shaygan انجام می‌دهد.
- نبود `package-lock.json` باعث می‌شود نصب dependency کاملاً reproducible نباشد. ایجاد یا Commit آن نیازمند تصمیم صریح تیم است.

## Smoke Test Checklist

### Health

```bash
curl --fail --silent --show-error http://127.0.0.1:1385/health
curl --fail --silent --show-error http://127.0.0.1:1385/api/mongo/health
```

- پاسخ `/health` باید HTTP 200 و `ok: true` داشته باشد.
- `/api/mongo/health` باید اتصال MongoDB مستقل staging را تأیید کند.

### Login

- صفحه `/login` باز شود.
- با یک حساب تست staging ورود انجام شود؛ credential در command history یا مستندات ثبت نشود.
- `/api/auth/me` پس از login باید کاربر staging را برگرداند.
- logout و بازگشت به صفحه login بررسی شود.

### Staging Read-only

- پیش‌نیاز این بخش آن است که Commit مربوط به `STAGING_READ_ONLY` پس از review در `develop` موجود باشد. اگر پاسخ مورد انتظار 403 دریافت نشد، staging برای تست عملیاتی امن محسوب نمی‌شود و workflow باید متوقف شود.
- پردازش PM2 باید با `STAGING_READ_ONLY=true` restart شده باشد.
- تست بدون session زیر امن است؛ اگر guard فعال باشد باید پیش از authentication و body processing پاسخ 403 بدهد:

```bash
curl --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{}' \
  http://127.0.0.1:1385/api/sales/issue
```

- پاسخ مورد انتظار شامل `ok: false`، متن `Operation disabled in staging read-only mode` و `operation: sales.issue` است.
- در staging هیچ تست صدور واقعی فروش، خرید یا تبدیل پیش‌فاکتور اجرا نشود.

### PM2

```bash
pm2 status
pm2 describe mkcrm
pm2 logs mkcrm --lines 100 --nostream
```

- process باید `online` باشد و restart loop نداشته باشد.
- logها نباید خطای startup، MongoDB یا configuration نشان دهند.
- Commit نمایش‌داده‌شده با `git rev-parse HEAD` باید همان Commit تأییدشده `develop` باشد.

## Production Release

پس از تأیید staging، Pull Request جداگانه از `develop` به `main` review و merge می‌شود. انتشار Production باید Commit دقیق `main` را ثبت کند و شامل health check و برنامه rollback تأییدشده باشد. هیچ deployment خودکار از Branchهای feature/fix/chore مجاز نیست.

## وضعیت Lockfile

در زمان ایجاد این سند، `package-lock.json` در repository وجود ندارد. این workflow آن را ایجاد یا Commit نمی‌کند. تصمیم درباره افزودن lockfile باید جداگانه، همراه با بررسی نسخه Node.js، نسخه npm و اثر آن بر deployment گرفته شود.
