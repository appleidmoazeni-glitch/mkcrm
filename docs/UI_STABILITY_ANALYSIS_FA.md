# گزارش تحلیل پایداری UI پروژه MKCRM

## وضعیت بررسی

- Branch فعال با خواندن مستقیم `.git/HEAD` تأیید شد: `fix/ui-stability-and-escape`.
- این گزارش حاصل بررسی read-only معماری، مسیر startup، ماژول‌های inventory، supplier sleep، sale snapshot، board، اتصال MongoDB، یکپارچه‌سازی Shaygan WebService و اجزای مرتبط با UI است.
- هنگام تهیه این گزارش هیچ فایل اجرایی یا کد پروژه تغییر نکرده است.

## معماری پروژه

### Runtime و startup

- پروژه یک برنامه CommonJS بر پایه Node.js نسخه 24 یا بالاتر است.
- `package.json`، فایل `src/server.js` را به‌عنوان `main` معرفی می‌کند.
- دستور `npm start` برابر `node src/server.js` است.
- `ecosystem.config.js` اجرای production توسط PM2 را به `src/server.js` متصل می‌کند.
- فایل‌های `start.bat`، `start_foreground.bat` و `start_background.bat` مسیرهای اجرای Windows هستند.
- `src/server.js` با `http.createServer()` سرور را می‌سازد. پس از پایان `ensureInit()`، تابع `startAutoInventorySyncWorker()` اجرا و سپس سرور روی `config.host` و `config.port` فعال می‌شود.
- مقدارهای پیش‌فرض `APP_HOST=0.0.0.0` و `PORT=1385` هستند.

### Backend

- Backend بدون Express و با ماژول native `http` پیاده‌سازی شده است.
- routing، authentication، authorization، static serving، print، business logic، background jobs و API handling عمدتاً در `src/server.js` قرار دارند.
- ماژول‌های اصلی:
  - `src/lib/config.js`: بارگذاری `.env` و configuration.
  - `src/lib/mongo.js`: اتصال singleton به MongoDB، ساخت collectionها، indexها و seedها.
  - `src/lib/shaygan.js`: adapter مربوط به Shaygan WebService.
  - `src/lib/stock-sleep.js`: snapshot موجودی و reverse FIFO بر اساس kardex.
  - `src/lib/purchase-sleep.js`: supplier sleep، purchase layers، reconciliation و summaryها.
  - `src/lib/sale-snapshot.js`: snapshot فروش و seller performance.
  - `src/lib/http-utils.js`: helperهای HTTP و normalization.
  - `src/lib/time.js`: تاریخ و زمان با timezone `Asia/Tehran`.

### Frontend فعال

- UI فعال یک SPA با vanilla HTML/CSS/JavaScript است.
- `public/index.html` فایل‌های `public/assets/style.css` و `public/assets/app.js` را بارگذاری می‌کند.
- navigation با hash routing انجام می‌شود.
- page rendering بر پایه template string و `innerHTML` است.
- `public/login.html` صفحه login مستقل را فراهم می‌کند.
- پوشه `public/legacy-src` شامل source قدیمی Vue/Bootstrap-Vue است، اما در `package.json` هیچ dependency یا build script مربوط به Vue وجود ندارد و این پوشه بخشی از runtime فعال نیست.

## Dependency map

```text
package.json / launchers / PM2
└── src/server.js
    ├── native http/fs/path/crypto
    ├── mongodb.ObjectId
    ├── lib/config.js
    │   └── process environment + optional .env
    ├── lib/mongo.js
    │   └── MongoDB driver → collections/indexes/default data
    ├── lib/http-utils.js
    ├── lib/time.js
    ├── lib/shaygan.js
    │   └── Shaygan HTTP WebService
    ├── lib/stock-sleep.js
    │   └── MongoDB inventory snapshots + Shaygan kardex
    ├── lib/purchase-sleep.js
    │   └── MongoDB supplier/sale data + lib/shaygan.js
    └── lib/sale-snapshot.js
        └── MongoDB purchase layers + lib/shaygan.js

Browser
└── public/index.html / public/login.html
    ├── public/assets/style.css
    └── public/assets/app.js
        └── /api/* → src/server.js
```

## MongoDB

- driver رسمی `mongodb` تنها dependency مستقیم پروژه است.
- `connectMongo()` در `src/lib/mongo.js` یک connection و database singleton نگه می‌دارد.
- `MONGO_URI` پیش‌فرض `mongodb://127.0.0.1:27017/mkcrm` است.
- collectionهای مهم شامل موارد زیر هستند:
  - inventory و catalog: `itemCatalog`, `itemCatalogAll`, `itemInventoryCatalog`, `accountCatalog`, `searchCache`.
  - sales: `saleSnapshots`, `saleInvoiceHeaders`, `saleInvoiceLines`, `saleSnapshotDiagnostics`, `saleIssueLocks`.
  - supplier sleep: `supplierPurchaseInvoices`, `supplierPurchaseLayers`, `supplierInventoryAllocation`, `supplierSleepSummary`, `supplierSleepSnapshots`, `supplierSleepDiagnostics`.
  - stock sleep: `stockSleepSnapshots`, `stockSleepQueue`, `stockSleepItemLayers`, `stockSleepSupplierSummary`, `stockSleepHistory`.
  - board و jobs: `boardEvents`, `appJobs`, `appLogs`.
  - CRM و security: `users`, `roles`, `customers`, `leads`, `userShayganMappings`, `userAccountAccesses`.

## Shaygan WebService

- `src/lib/shaygan.js` درخواست‌ها را با `fetch` و method `POST` ارسال می‌کند.
- headerهای اصلی `Content-Type`, `Accept` و `api-version` هستند.
- `ConnectionName` در payload قرار می‌گیرد.
- timeout با `AbortController` مدیریت می‌شود.
- base URL پیش‌فرض `http://192.168.1.253:2030` است.
- endpointهای اصلی:
  - `Account/Get`
  - `Account/GetStatement`
  - `Stock/Get`
  - `Item/GetRemain`
  - `Item/GetKardex`
  - `Item/Get`
  - `Item/GetProductList`
  - `Invoice/Get`
  - `Invoice/Put`
- کشف serial چند endpoint احتمالی batch/serial را به ترتیب امتحان می‌کند و در نبود نتیجه، ورود دستی را پیشنهاد می‌دهد.

## ماژول‌های دامنه‌ای

### Inventory

- بخش عمده inventory داخل `src/server.js` است.
- وظایف شامل snapshot search، active warehouse filtering، targeted live repair، authoritative reconciliation، catalog sync، auto-sync، sale validation و local sale deduction است.
- collection اصلی runtime، `itemInventoryCatalog` است.
- جستجوی معمول stocks از snapshot محلی استفاده می‌کند؛ بررسی نهایی sale و برخی repairها به Shaygan WebService مراجعه می‌کنند.

### Supplier sleep

- پیاده‌سازی اصلی در `src/lib/purchase-sleep.js` است.
- purchase invoiceها و account statementهای Shaygan را می‌خواند، purchase layer ایجاد می‌کند، inventory را reconcile می‌کند و summaryهای supplier، invoice و group را می‌سازد.
- اجرای طولانی می‌تواند به‌صورت detached job ثبت‌شده در `appJobs` انجام شود.
- heartbeat و single-active-job guard در `src/server.js` وجود دارد.

### Stock sleep

- `src/lib/stock-sleep.js` موجودی فعلی را با kardex ترکیب می‌کند و reverse FIFO layer می‌سازد.
- movementهای انتقال داخلی از purchase candidate جدا می‌شوند.
- نتیجه در collectionهای `stockSleep*` ذخیره می‌شود.

### Sale snapshot

- `src/lib/sale-snapshot.js` header و line فاکتورهای فروش را از Shaygan وارد می‌کند.
- seller mapping و main group mapping را اعمال می‌کند.
- seller performance و FIFO profit را با استفاده از purchase layerها محاسبه می‌کند.

### Board / Tablo

- UI نهایی در `pageTablo()` و helperهای انتهای `public/assets/app.js` قرار دارد.
- APIها در `src/server.js` زیر `/api/board/*` هستند.
- persistence در collection `boardEvents` انجام می‌شود.
- eventهای اصلی `stock_out` و `stock_in` هستند.
- UI امکان فیلتر event، تغییر status، مشاهده purchase invoice و announce ورود کالا را فراهم می‌کند.

## موجودی اجزای UI مرتبط با پایداری

### Active UI

#### Search، autocomplete و suggestion

- `itemSearchWidget`
- `bindItemSearch`
- `bindProductSearch`
- `renderAccountResults`
- چند نسل از `bindAccountPicker`
- `bindSupplierSearch`
- `bindSupplierSearch092`
- `bindItemSearch092`
- `searchSuppliers` در supplier sleep
- search controlهای داخلی pageهای customer، lead، purchase draft، inventory، sale inventory و account.

#### Dropdown و select

- `stockFilterWidget`
- `fillStockFilter`
- `renderGroupSelect`
- selectهای seller mapping، user role، turnover account، warehouse، report filter، board status/type، snapshot، supplier و main group.

#### Popup، overlay و modal

- popupهای فعال با کلاس‌های `.floating-list`, `.floating-item`, `.floating-empty` ساخته می‌شوند.
- این popupها modal واقعی نیستند و focus trap یا lifecycle مشترک ندارند.
- Active UI shared modal component ندارد.
- جزئیات proforma، invoice و purchase عمدتاً inline render می‌شوند؛ برخی عملیات از `confirm` یا print window استفاده می‌کنند.

#### Keyboard handling

- handler مربوط به `Enter` در login، inventory/product search، account picker، supplier picker و purchase item search وجود دارد.
- انتقال inventory به cardex از synthetic `KeyboardEvent` با key برابر `Enter` استفاده می‌کند.
- global handler یکپارچه برای `Escape` پیدا نشد.
- navigation استاندارد با `ArrowUp` و `ArrowDown` و مدیریت active option یکپارچه وجود ندارد.

#### Loading state

- loading با متن‌های inline مانند «در حال جستجو»، «در حال خواندن» و «در حال تبدیل» نشان داده می‌شود.
- loading helper یا component مشترک وجود ندارد.
- disabled state، duplicate-submit protection و stale-response protection در همه flowها یکسان نیست.

### Legacy Vue UI

#### Modal/Dialog componentها

- `public/legacy-src/components/ModalCardex.vue`
- `public/legacy-src/components/ModalComment.vue`
- `public/legacy-src/components/ModalInv.vue`
- `public/legacy-src/components/ModalVoucherInv.vue`
- `public/legacy-src/components/flowchart/ConnectionDialog.vue`
- `public/legacy-src/components/flowchart/NodeDialog.vue`

#### Viewهای دارای modal

- `accounting/AccountSet.vue`
- `accounting/AddBuyInvoice.vue`
- `accounting/AddInvoice.vue`
- `accounting/Cardex.vue`
- `accounting/InvBuy.vue`
- `accounting/InvSale.vue`
- `accounting/Stocks.vue`
- `accounting/Stores.vue`
- `accounting/Turnover.vue`
- `monitoring/Polls.vue`
- `products/Invoices.vue`
- `products/OrderDelivery.vue`
- `products/OrderItem.vue`
- `products/Orders.vue`
- `products/ntsw.vue`
- `settings/Groups.vue`
- `settings/Permission.vue`
- `settings/Users.vue`
- `settings/Workflow.vue`
- `wallet/Cashout.vue`
- `public/legacy-src/App.vue`

#### Viewهای دارای overlay/loading

- `components/ModalComment.vue`
- accounting: `Cardex.vue`, `Products.vue`, `Stocks.vue`, `Turnover.vue`
- monitoring: `Polls.vue`, `Targets.vue`
- products: `Index.vue`, `Invoices.vue`, `OrderDelivery.vue`, `OrderItem.vue`, `Orders.vue`, `PostTracking.vue`, `ntsw.vue`
- settings: `Groups.vue`, `Permission.vue`, `Proxies.vue`, `Roles.vue`
- panel: `Header.vue`, `Sidebar.vue`
- wallet: `Cashout.vue`, `Statements.vue`

#### Keyboard handling در legacy

- `components/flowchart/base/Flowchart.vue`
- `views/settings/ChangePassword.vue`
- `views/wallet/Authenticate.vue`
- handlerهای `keypress.enter` در `ModalComment.vue`، `accounting/Stocks.vue` و چند view بخش products.
- handler صریح `Escape` در legacy source پیدا نشد.

## علت‌های ریشه‌ای مشکلات UI

1. فایل `public/assets/app.js` یک فایل monolithic با 4227 خط است و چند نسل patch به انتهای آن افزوده شده‌اند.
2. توابع مهم مانند `route`, `pageSale`, `pageProforma`, `pageTurnover`, `pageUsers`, `bindAccountPicker` و pageهای purchase چند بار تعریف یا override شده‌اند؛ رفتار واقعی به آخرین assignment و ترتیب load وابسته است.
3. popupها و suggestionها lifecycle مشترک ندارند و هر binder منطق open، close، outside click و keyboard را جداگانه پیاده‌سازی می‌کند.
4. برخی binderها در هر بار ورود به page یک `document.click` listener جدید ثبت می‌کنند و teardown ندارند؛ در نتیجه navigation تکراری می‌تواند listener leak و رفتار چندباره ایجاد کند.
5. `Escape` به‌صورت سراسری و قابل پیش‌بینی پشتیبانی نمی‌شود.
6. keyboard navigation کامل شامل `ArrowUp`, `ArrowDown`, active option، focus restoration و ARIA semantics وجود ندارد.
7. loading stateها پراکنده و متنی هستند؛ کنترل یکپارچه برای disabled button، duplicate action، stale response و error recovery وجود ندارد.
8. asynchronous searchها همیشه request sequencing یا cancellation ندارند؛ پاسخ قدیمی می‌تواند نتیجه جدیدتر را overwrite کند.
9. render گسترده با `innerHTML` و template string انجام می‌شود. با وجود helper به نام `esc`، تعداد زیاد render siteها خطر escape ناقص، به‌خصوص در attribute و `data-*`، را بالا می‌برد.
10. pageها با جایگزینی کامل DOM بازسازی می‌شوند، اما listenerهای سراسری و stateهای async الزاماً همراه آن پاک نمی‌شوند.
11. Active vanilla UI و legacy Vue source هم‌زمان در repository حضور دارند و تشخیص اشتباه runtime file می‌تواند باعث اصلاح بی‌اثر شود.

## فایل‌هایی که در اصلاح پیشنهادی باید تغییر کنند

### فایل‌های اصلی

- `public/assets/app.js`
  - ایجاد lifecycle مشترک popup/suggestion.
  - افزودن keyboard handling استاندارد و `Escape`.
  - جلوگیری از listener leak و stale response.
  - یکپارچه‌سازی loading/busy state.
  - اعمال helperهای جدید به search surfaceهای فعال.
- `public/assets/style.css`
  - style مربوط به active option، hidden/open state، busy state و focus-visible.
  - در صورت نیاز style محدود برای overlay یا popup استاندارد.

### فایل‌های مشروط

- `public/login.html`
  - فقط در صورتی که loading/disabled behavior و keyboard policy مشترک باید login مستقل را نیز پوشش دهد.
- `public/index.html`
  - فقط در صورت نیاز به cache-buster version یا markup/ARIA ثابت در shell.
- `scripts/smoke-test.js` و `scripts/test-all.js`
  - افزودن regression coverage در صورت تأیید تغییر test code.

### خارج از دامنه اولیه

- `src/server.js` و فایل‌های `src/lib/*` برای اصلاح UI stability نباید تغییر کنند، مگر اینکه هنگام implementation یک قرارداد API معیوب با evidence قطعی شناسایی شود و جداگانه تأیید شود.
- `public/legacy-src/*` نباید تغییر کند، چون runtime فعال نیست.
- فایل‌های `.bak*` و READMEهای تاریخی نباید تغییر کنند.

## دامنه دقیق اصلاحات پیشنهادی

1. ساخت یک controller سبک برای popup/suggestion با قرارداد مشخص:
   - تنها یک popup فعال در هر لحظه.
   - close با `Escape` و outside click.
   - focus restoration به trigger/input.
   - انتخاب با `Enter`.
   - navigation با `ArrowUp` و `ArrowDown`.
   - نگهداری active option و ARIA attributeهای پایه.
   - cleanup listenerها هنگام route/page change.
2. افزودن request sequencing برای autocompleteها تا response قدیمی نادیده گرفته شود.
3. استانداردسازی debounce و حداقل طول query بدون تغییر قرارداد API.
4. ایجاد helper برای loading/busy:
   - disable موقت trigger.
   - جلوگیری از double submit.
   - نمایش loading، success و error در target مشخص.
   - restore قطعی state در `finally`.
5. اعمال تغییرات به surfaceهای فعال:
   - inventory و product search.
   - account picker و turnover account search.
   - customer و supplier picker.
   - sale، purchase و proforma item selection.
   - supplier sleep search.
   - board filters و async actions در صورت داشتن popup/busy behavior.
6. حفظ همه endpointها، payloadها، role permissionها و business ruleهای موجود.
7. عدم refactor هم‌زمان backend یا حذف گسترده patchهای قدیمی در مرحله اول.
8. پس از ایجاد coverage، consolidation تدریجی توابع shadowed به یک implementation معتبر برای هر page.

## ریسک Regression

- سطح ریسک کلی: متوسط رو به بالا، به دلیل monolithic بودن `app.js` و overrideهای متعدد.
- بیشترین ریسک در flowهای زیر است:
  - sale item selection، serial loading و invoice issue.
  - proforma create/edit/convert.
  - purchase draft create/edit/issue.
  - turnover account access و account search.
  - inventory/cardex navigation.
  - supplier sleep job controls.
  - board event status و purchase announce.
- تغییر global keyboard handler ممکن است با input، textarea، native select، print window یا browser shortcut تداخل کند.
- تغییر outside-click behavior ممکن است click انتخاب result را قبل از handler اصلی close کند؛ event ordering باید تست شود.
- cleanup اشتباه می‌تواند listener موردنیاز page فعلی را حذف کند.
- یکپارچه‌سازی loading ممکن است در error path دکمه را disabled باقی بگذارد؛ استفاده از `finally` ضروری است.
- consolidation زودهنگام توابع shadowed می‌تواند patch behaviorهای نسخه‌های اخیر را حذف کند.
- هر تغییر escape/render ممکن است parsing فعلی `data-row` و JSON داخل attribute را بشکند.

## برنامه تست پس از اصلاح

### Static و automated

- syntax check برای `public/assets/app.js` و فایل‌های server-side.
- `npm run smoke`.
- `npm run test:all`.
- بررسی عدم تغییر endpoint contract و role permission map.

### Popup و keyboard

- باز و بسته شدن هر suggestion popup با mouse.
- بسته شدن فقط popup فعال با `Escape`.
- بازگشت focus به input پس از close.
- حرکت با `ArrowUp` و `ArrowDown`.
- انتخاب active option با `Enter`.
- عدم submit ناخواسته form هنگام انتخاب suggestion.
- outside click بدون اجرای دوباره handler.
- navigation مکرر بین pageها و اطمینان از عدم افزایش تعداد request یا handler.

### Search و async stability

- تایپ سریع queryهای متوالی و اطمینان از overwrite نشدن نتیجه جدید توسط response قدیمی.
- query کوتاه، نتیجه خالی، timeout، خطای API و recovery.
- جستجوی item بر اساس code و description.
- account/customer/supplier search با متن فارسی، رقم و account number.
- تغییر warehouse filter هنگام باز بودن suggestion.

### Loading و duplicate action

- double-click روی issue، convert، save، sync، build و announce.
- فعال شدن مجدد control پس از success و error.
- حفظ پیام خطای قابل مشاهده.
- عدم باقی‌ماندن busy state پس از route change.

### Regression flowهای اصلی

- login با mouse و `Enter`.
- inventory search، انتخاب warehouse و رفتن به cardex.
- sale چندردیفی، serial، validation و issue.
- proforma create، edit، archive و convert.
- purchase draft create، edit، preview و issue.
- turnover با account مجاز.
- customer search و profile.
- seller performance و sale snapshot.
- supplier sleep search، job start/status، snapshot و layer detail.
- Tablo: filter، status update، purchase invoice view و announce.
- تست roleهای `admin`, `seller`, `accounting`, `warehouse`, `purchase`, `seller_buyer`.

## نکات ریسک معماری خارج از اصلاح اولیه UI

- `src/server.js` نیز monolithic است، اما refactor آن نباید با اصلاح UI stability ترکیب شود.
- در `initMongo()` عبارت `collection('saleSnapshotDiagnostics','appJobs')` مشکوک است؛ MongoDB driver فقط نام اول را به‌عنوان collection می‌پذیرد و index مورد انتظار `appJobs` احتمالاً در آن خط ایجاد نمی‌شود. این موضوع باید در task مستقل بررسی شود.
- seed شدن credentialهای پیش‌فرض، یک ریسک deployment/security مستقل است.
- board به صحت inventory cache و reconciliation وابسته است.
- supplier sleep و sale snapshot به pagination، hydration فاکتور، normalization تاریخ و field mapping خروجی Shaygan وابسته‌اند.

## برنامه اجرای توصیه‌شده

1. ثبت baseline رفتار توابع نهایی و shadowed بدون تغییر business logic.
2. افزودن popup/suggestion controller و loading helper کوچک در `public/assets/app.js`.
3. اعمال تدریجی controller به search surfaceها، یک flow در هر مرحله.
4. افزودن CSS محدود در `public/assets/style.css`.
5. اجرای تست‌های keyboard، async، navigation و business flow پس از هر مرحله.
6. پس از تثبیت و coverage، حذف یا consolidation کدهای shadowed در task جداگانه.

