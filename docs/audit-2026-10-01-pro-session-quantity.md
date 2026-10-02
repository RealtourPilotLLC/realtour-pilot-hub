# Pro session quantity — causal handoff defect

## Implemented and domain-tested; rebuilt causal journey pending

The actual built signed Pro HTTP journey established a concrete failure:
photographer `finalizeUpload` reports four filmed topics, but its status sweep
raises the session's deliverable quantity from four to eight and creates four
extra unbound live outputs. The sweep applied the whole monthly Pro allowance
to each visit. Evidence:
`/tmp/pro-second-session-http-slot-evidence/`.

`programSessionQuantity.ts` proves an allocation only from one current confirmed
CONTENT_SESSION request, exact client/month/enrollment/session, matching named
appointment/time/order, and no cancellation, postponement, pending change or
live replacement. It reuses existing `planSessions`, including a five-video
month's three-plus-two allocation. Failed reads throw; missing/ambiguous evidence
retains existing legacy behavior. No provider request or new policy is added.

The status quota repair and both single/batched cut readers use that allocation.
Explicit custom quantities, existing larger counts and office overrides retain
their meaning. No retrospective lowering, output deletion, version rewrite,
manual Start/Pause change, schema change or production data repair is included.

Old source reproduced7 pass/6 fail. Actual repaired-domain PostgreSQL20/0 covers
both sessions, pre-filming single/batched parity, historical output identities/
owner/note/target, no automatic Start, legacy8/custom16/larger/manual override,
cancelled/superseded/ambiguous/foreign/out-of-range bindings, five-video split
and read failure without guessed counts or quota lift. Scoped lint0, whole-tree
nonincremental types0 and root focused review clear. Evidence:
`/tmp/pro-session-quantity-final/`, `/tmp/pro-session-quantity-types.log`.

Next: exact immutable build, resume the same Pro two-session HTTP fixture, then
release under checkpoint deployment authorization. Browser/phone/provider/
human-watch acceptance and historical source decisions remain separate.
