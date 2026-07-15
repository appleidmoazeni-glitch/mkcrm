# MKCRM 0.9.19.57 — Board Event Mongo Conflict Fix

## علت قطعی خرابی تابلو
در تابع مشترک `createBoardEventOnce` فیلدهای `updatedAt` و `updatedAtTehran` هم‌زمان در `$setOnInsert` و `$set` نوشته می‌شدند. MongoDB عملیات را با خطای conflict رد می‌کرد؛ بنابراین هم «اتمام کالا» و هم «ورود کالا» رویداد تازه نمی‌ساختند.

## اصلاح
- `createdAt` و `createdAtTehran` فقط در `$setOnInsert`
- `updatedAt`، `updatedAtTehran`، `lastSeenAt` و `lastSeenAtTehran` فقط در `$set`
- حذف ایمن فیلدهای mutable از سند insert-only
- حفظ کامل منطق نسخه 0.9.19.56 برای local deduct و live reconcile تابلو

## تست‌های پیشنهادی
1. فروش آخرین موجودی یک کالا و بررسی ایجاد `stock_out`
2. اعلام ورود کالا از فاکتور خرید و بررسی ایجاد `stock_in`
3. بررسی لاگ `sale_issue_post_board_stock_out` برای `created: true`
