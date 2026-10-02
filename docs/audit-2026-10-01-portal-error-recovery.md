# C14 / U2 — portal-aware error recovery

## Implemented, tested, committed and deployed

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

Exact checkpoint `830a559b8e02c275f7067cec2562a9f75388f9b4` is deployed,
Ready `dpl_JVhUdakNwrD3NmD24Pvcfky7En2a`, promoted Oct1 at8:43:51 PM EDT
(Oct2 00:43:51Z). Clean Node20 and remote builds, protected stage and canonical
version/login/assets/auth/final403/old-host307 checks pass. Read-only before/
after comparison verifies saved business settings, automation OFF/TEST_ONLY
and seat counts unchanged. Only two existing mailbox read-health timestamps
advanced; no agent provider operation was invoked. Sanitized evidence:
`release-evidence/2026-10-01-portal-error-release.json`.

This fallback is live for existing authorized portal users when a page fails.
No audience or switch was enabled. Mounted/browser acceptance remains open.
No schema, provider action, automation activation, client invitation/message,
rollout change or Git push. Verified d22c582 is rollback; retain all database
records and newer writes.
