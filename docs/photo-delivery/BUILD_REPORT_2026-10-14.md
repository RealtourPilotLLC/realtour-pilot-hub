# Photo Delivery + Kyle automations: build report (night of Oct 13-14 2026)

## Live and running

| What | Where | State |
|---|---|---|
| AutoHDR API connection | Connections → AutoHDR (Jordan pasted the key) | Connected, read-only token for every read |
| Credit monitor | `/ops/photo-delivery/credits`, every 15 min | Live: 399 → 325 tonight (74 photos pushed to Aryeo, booked as "used outside the pipeline"); alerts at 250 and 100 to Jordan and Kyle |
| Photo job sync | `/api/cron/photo-delivery`, every 5 min | Live: opens a job per shoot, reads the edited gallery from the Aryeo listing, verifies deliveries |
| Photo Delivery pages | `/ops/photo-delivery` (queue, job, review mode, credits, settings) | Owner + office |
| AI QC (CV + Claude, 428 rules) | `/api/cron/photo-qc`, every 5 min | Shadow mode (advisory); see switches |
| Fix Cart + fix runner | Job page → Fix Cart | Built and tested against a fake AutoHDR; OFF until Jordan approves a first paid test |
| Delivery gate + Aryeo steps + verification | Job page → Deliver panel | Advisory in shadow mode |
| Coaching notes | Job page (owner) | Drafts only; Jordan sends or discards |
| Monday digest | Slack, Monday 8 AM ET | Jordan (with QC cost) and Kyle (no dollars) |
| Drone check at upload | /upload submit | Warns when drone is ordered but no DJI files are in RAW-Photos |
| Leads to Kyle + 15/60 min pings | gmail cron | Switch `leadPing` ON |
| Client access notes onto the shoot brief | comms pipeline | Always on (staff-only) |
| Jordan's 6 PM wrap | gmail cron, Mon to Sat | Switch `eveningPush` ON |
| Night-before photographer brief | gmail cron | Switch `photographerBrief` ON |
| Pre-promise delivery watch (+ drafted client update, never sent) | gmail cron | Switch `promiseWatch` ON |
| Slack asks close on evidence; Jordan's asks never auto-expire | sync cron | Always on |
| AutoHDR mail: no marketing tasks; none while the API is connected | vendorBalance | On |

## Switches (Photo Delivery settings, owner)

`enabled` ON · `qcEnabled` see the chat · `qcShadow` ON · `fixRunnerEnabled` OFF · `autoFixZeroCredit` OFF · `aryeoTags` OFF · monthly QC budget $300.

## Decisions waiting on Jordan

1. **First paid AutoHDR test**: approve one fix (1 credit) on a non-client photo, then switch on "Run approved AutoHDR fixes".
2. **Client Order / Revisions / Upsells** (AutoHDR's mockup): retail prices, and the payment rail (the hub's Stripe key is read-only).
3. **Per-shoot editing style at order time** needs API-created shoots, which means moving raws out of what AutoHDR watches (or every shoot is edited twice).
4. Kyle automations: Sunday wrap (built Mon to Sat), a one-tap Send on drafted client updates, info@-only emails routed to Kyle (not built: Jordan's inbox).
5. Security: a shared mailbox password was posted in the editing Slack channel (rotate it); an external editor asked to change the payment destination on Aug 1 (verify any such change another way).
