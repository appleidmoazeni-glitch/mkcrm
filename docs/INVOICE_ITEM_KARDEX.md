# Invoice Item Kardex

Sales invoice lines expose `مشاهده کاردکس`. The contextual endpoint `/api/invoices/:invoiceNo/items/:itemCode/kardex?invType=2` first loads the exact Sale invoice, verifies seller/seller_buyer account access, and verifies the requested item occurs in that invoice. Admin/accounting/warehouse/purchase retain their existing role access.

The endpoint reuses Shaygan `getKardexByItemCode` and existing role limits/timeouts. It does not use SQL, change FIFO, fabricate profit or mutate invoice data. Kardex renders inside the existing invoice modal so closing returns cleanly without a second overlay. Rollback removes this endpoint and line action only.
