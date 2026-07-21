# Turnover Document Routing

Turnover rows now retain authoritative `InvNo` and `InvTyp`/`InvoiceType` from Shaygan. Mapping is 2 Sale, 3 Purchase, 6 Return from Sale, and 7 Return from Purchase. A clickable identity always carries both number and type.

The typed loader sends both fields to `/api/invoices/:number?invType=...`; the server validates the supported type and filters the response by both number and type. Missing or unsupported type displays a safe message and never defaults to Sale. The modal title is generated centrally from the same mapping.

Rollback is isolated to the turnover renderer, typed modal and strict typed invoice route. No invoice financial data is edited.
