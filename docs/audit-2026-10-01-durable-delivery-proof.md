# W05 — durable authenticated delivery proof

## Implemented and tested; deployment pending

An authenticated exact delivery echo could be marked PROCESSED despite a
transient settlement failure. A later stored replay also lost the authentication
context. The existing attempted unknown delivery intent then remained held.

- The receiver atomically stores its raw WebhookEvent and an authentication
  receipt in existing AuditLog. The receipt binds exact row identity, provider,
  event type, external identity and raw payload by SHA256; it copies no secret,
  token or message text. There is no schema change or legacy proof backfill.
- Stored replay trusts only an unchanged authenticated receipt. Missing,
  unsigned, altered and malformed proof cannot settle a delivery.
- Operational settlement, receipt-read and unavailable workspace-line failures
  remain retryable. Automatic receipt failure uses existing per-event backoff
  and continues unrelated events. Cold-process line failure retains ERROR.
- A processed unsigned twin cannot consume authenticated proof. Recovery keeps
  the original intent, provider time, dedupe and attempt count; it never sends
  another text. Ambiguous business evidence remains held.

Actual POST, stored manual/automatic replay, fresh-process reconstruction,
isolated read failure, unrelated-event progress, cold workspace-line failure,
atomic receipt rollback, tampered/missing/unsigned proof and notice-time checks
pass **25/0** on disposable real PostgreSQL. Existing exact-echo concurrency/
notice regression passes **36/0**. Provider calls are fake/fenced; no production
mutation tests. Logs: `/tmp/w05-durable-proof-reviewed/`.
Whole-tree nonincremental Node20 types and scoped lint pass. One focused peer
review identified the two isolation/line issues above; its narrow correction
check is clear, with no residual defect found in these paths.

No client send, invitation, booking, financial action, automation activation,
rollout change, new schema or pushed branch. Production callback acceptance and
manual unknown-text settlement authority remain open. Exact build/stage/
promotion and canonical checks are pending. This extends the deployed4354aca
exact-evidence recovery, without granting new manual policy.
