# C14 / U2 — portal-aware error recovery

## Implemented and tested; release pending

The shared error boundary offered `/` and bare `/feedback` to portal clients.
Both are staff destinations guarded by existing staff authentication; clients
could be diverted into staff login while trying to recover. `/portal` routes
now offer the existing `/portal/me` door and ordinary team-contact guidance,
retaining exact references, current-data retry and interrupted-save uncertainty.
Staff destinations remain as before. This changes no permission or auth gate
and invents no support address/channel or client send.

Installed Next16 `usePathname` documentation was read before implementation.
Exact segment-boundary matching avoids treating `/portals` as a client route;
missing pathname retains the existing staff fallback. Focused root review is
clear. Expanded actual handler/framework-runtime/native SSR fixture24/0 and
scoped lint pass: `/tmp/c14-portal-error-recovery-final/`. Whole-tree Node20
nonincremental types pass at `/tmp/ops-hub-portal-error-fixed-types.log` after
the active Pro fixture's typing corrections. Mounted/browser acceptance remains open.

Local commit and exact build/stage/promotion/canonical checks are next under
the user's checkpoint deployment authorization. Production currently serves
d22c582; no schema, provider action, automation activation, client invitation/
message or rollout change.
