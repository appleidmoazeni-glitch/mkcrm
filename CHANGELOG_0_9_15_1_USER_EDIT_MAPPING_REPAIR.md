# MKCRM 0.9.15.1 - User Edit / Mapping Repair

- Fixed user rename persistence in admin user editor.
- Prevents username rename to an already existing user.
- Moves Shaygan cashbox/employee mapping safely when username changes.
- Deduplicates userShayganMappings per username to prevent cashbox mixing between users.
- Deduplicates userAccountAccesses per username/accountNumber.
- Adds admin repair action: /api/users/repair-links and UI button in Users page.
- Password changes remain unchanged.
- Supplier aging, fiscal DB selector, SQL read, customer bank, and sale speed fixes are preserved.
