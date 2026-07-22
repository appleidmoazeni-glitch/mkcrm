# Staging Validation Checklist

## Backup

1. Login as admin; open `مدیریت پشتیبان‌گیری` and confirm database/allowed destinations.
2. Start one backup, verify running/completed status, output folder/name/size and no URI in UI/logs.
3. Start twice and verify `JOB_LOCKED`. Test missing binary, invalid destination and `../` rejection.
4. Login non-admin: menu absent and all `/api/admin/backups/*` calls return 403.

## Account Turnover

1. Search `صندوق مسعود ثانی`, select it and verify the dropdown closes and identity remains.
2. Load rows; loading is visible and `نتیجه‌ای پیدا نشد` is absent when rows exist.
3. Repeat with rapid queries/account switching; only the latest response renders.
4. Verify Escape, outside click, true empty response and API error produce distinct states.

## Document routing

1. Open Sale and Purchase examples and confirm typed titles.
2. Open return-from-sale 137 and confirm it never opens Sale 137.
3. Test InvTyp 7. Remove/mangle type in controlled fixture and verify no Sale fallback.

## Kardex

1. As seller, open a permitted Sale invoice and item Kardex; verify exact item and role row limit.
2. Close/reopen with Escape/button and verify one clean overlay/listener lifecycle.
3. Attempt another account's invoice and an item absent from the invoice; verify 403.

## Rollback

Revert the coordinated feature commit and rebuild `dist`. No database schema or inventory rollback is required; backup output is not deleted automatically.
