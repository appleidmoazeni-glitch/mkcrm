# Account Turnover Root-Cause Analysis

## Typed invoice-link regression after PR #10

PR #10 made link creation conditional on both an invoice number and a known four-type label. `invoiceTypeOf(undefined)` became `0`, so a turnover row without `InvTyp` was rendered as a non-interactive `<span>` with `نوع سند نامشخص`. In addition, `flattenStatementResult()` and the active UI helper ignored `DocumentNumber` even though real statement rows may use that field. The invoice API was not the source of the defect: an exact `Invoice/Get` for document 137 returns `InvTyp=6`.

The hotfix preserves `DocumentNumber`, makes every valid document number clickable, uses a central 2/3/4/5/6/7/10 registry, and resolves a missing type by querying exact `(InvNo, InvTyp)` candidates through Shaygan WebService. One candidate opens directly, zero shows a specific not-found message, and multiple candidates require an explicit user choice. No description-text inference or Sale fallback is used.

## Classification correction after staging validation

Real Account Turnover rows proved that `DocumentNumber` is an accounting-document number, not necessarily an invoice number. Commit `6ef0e48` rendered every positive numeric `DocumentNumber` as clickable and its resolver queried every generic registry type (2/3/4/5/6/7/10). `src/lib/invoice-resolution.js` also deliberately rejected the whole resolution when any candidate request failed, so an unrelated type failure could produce `INVOICE_RESOLUTION_FAILED` for a valid purchase invoice.

The Account Turnover workflow now classifies only explicit normalized phrases in `RowDesc`, `Description`, `Des`, `Comment`, `RowDescription`, `Detail`, or `DetailDesc`. Priority is Sale Return (6), Purchase Return (7), Sale (2), then Purchase (3). All other descriptions—including generic `فاکتور`, `ف ف`, receipts, payments, checks and warehouse transfers—remain plain text. A click makes one exact typed read with `source=turnover`; the backend restricts that source to 2/3/6/7 and the response must match both `InvNo` and `InvTyp`.

## Reproduction and evidence

The active `pageTurnover()` implementation in `public/assets/app.js` owns `picked`, `lastList`, a debounced `doSearch()`, and `renderResults()`. With a delayed `/api/accounts/search` response:

1. Type an account query and wait for suggestions.
2. Trigger another search, then select a visible suggestion before that request finishes.
3. Selection calls `setPicked()`, assigns the input label, and only sets `box.style.display='none'`.
4. The pending request completes and unconditionally calls `renderResults(res.list||[])`.
5. `renderResults()` unconditionally sets `display='block'`; an empty response renders `نتیجه‌ای پیدا نشد.` over the already selected account and, potentially, over loaded turnover rows.

DOM evidence is the simultaneous state: `#turnoverPicked` contains the selected identity, `#turnoverOut table tbody tr` contains returned rows, while visible `#turnoverAccountResults .floating-empty` contains `نتیجه‌ای پیدا نشد.`. The message therefore comes from autocomplete, not the turnover empty-state branch.

## Root cause A: false empty state

File/function: `public/assets/app.js`, active `pageTurnover()` → `doSearch()` → `renderResults()`.

There is no autocomplete request sequence or `AbortController`. A response for text that existed before selection is still authoritative after selection. Its empty list reopens the suggestion layer, creating a false empty-state even though the independent turnover request returned rows.

## Root cause B: dropdown remains/reopens

File/handler: `public/assets/app.js`, `.account-result.onclick` inside `renderResults()`.

The handler hides the box but does not cancel the debounce, abort the active fetch, increment an invalidation sequence, or mark the picker closed. The late response therefore reverses the close operation.

## Additional stale turnover risk

`#loadTurnoverBtn.onclick` has no request sequence/abort protection. Rapid account changes can allow an older account response to overwrite the newer account's loading/result state.

## Fix and regression protection

The replacement keeps selected-account identity separate from input text, uses independent autocomplete and turnover sequence IDs plus `AbortController`, invalidates both at selection/input changes, and renders explicit loading/empty/error states only for the latest active request. The shared popup controller owns Escape, outside click, keyboard selection and lifecycle cleanup. Document routing uses explicit `InvTyp`; missing/unsupported types never default to Sale.
