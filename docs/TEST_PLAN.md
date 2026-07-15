# TEST PLAN 0.8.9-purchase-draft-operational-from-084

1. Check /api/version.
2. Verify turnover still works exactly as 0.8.4.
3. Login admin: Users page -> enable purchase for a seller.
4. Login seller: buy and purchase archive menus should appear only after canPurchase.
5. Purchase draft: search supplier from Shaygan, search item, add row, save draft.
6. Purchase archive: saved draft visible.
7. App logs: purchase_draft_create visible.


## 0.9.5 Tests
1. Check /api/version.
2. Create purchase draft.
3. Print purchase draft from archive.
4. Issue purchase draft once.
5. Try duplicate issue; must be blocked.
6. Print issued purchase invoice.
7. Confirm turnover still works.
