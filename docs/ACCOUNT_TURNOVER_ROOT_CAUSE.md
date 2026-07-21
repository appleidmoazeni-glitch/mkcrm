# Account Turnover Root-Cause Analysis

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
