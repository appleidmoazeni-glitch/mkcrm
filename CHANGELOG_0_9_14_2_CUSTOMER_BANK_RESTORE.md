# MKCRM 0.9.14.2 - Restore Customer Bank Search in Sale Invoice

## Base
Built on `0.9.14.1-sql-fiscal-selector`.

## Fix
The customer bank search/autofill in the sale invoice page disappeared after the SQL/fiscal version because the later `pageSale` override rebuilt the sale page directly and did not call the older customer-bank wrapper.

This version restores the customer search box after the final sale page render.

## Preserved
- SQL direct read for inventory, cardex, turnover, and sale search
- Fiscal database auto/latest CY selector
- WebService write path for invoices
- Customer bank backend endpoints:
  - `/api/customers/search`
  - `/api/customers/stats`
  - `/api/customers/sync-shaygan-sales`

## Test
1. Open sale invoice.
2. Confirm customer search box appears under buyer fields.
3. Search by mobile/name/national code.
4. Pick a customer and verify buyer fields are filled.
5. Confirm E1504 product search is still fast and fiscal DB remains CY000002.
