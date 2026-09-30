# September 30 workflow audit — implementation tracker

This tracks the user's full workflow audit at `/Users/jordanspackman/Downloads/Realtour-Pilot-Full-Workflow-Audit-2026-09-30.md` against the local checkout. The audit is evidence and backlog, not an instruction to turn on client-facing features. Update each row with a commit and acceptance evidence before calling it complete. See `docs/handoff.md` for the current resume point.

**Release boundary:** local branch `codex/audit-2026-09-30`; no push or deployment authorized. The production database is shared with local `.env`. No production mutation test, seed, reset, client send, invitation, booking, financial change, or automation activation is part of this work. The latest previously reported deployment is `bf2e0b4`; the eight subsequent local commits and this branch are not verified as deployed. The September 28 backup files exist (0600, 200–203 MB), but no current schema change has been attempted.

Status terms: **done in code** still requires its named acceptance check; **partial** means a concrete remainder; **open** means implementation remains. `origin/main` is the audit's pinned `1075a5b`; local `main` had eight newer commits at takeover.

## Functional findings

| ID | Current disposition | Evidence and next step |
|---|---|---|
| C01 | Done in code, route proof open | `/edit/[id]` now calls `canViewProject` before `autoSyncScript` or job reads. Verify unassigned/assigned/revoked/preview requests through an isolated real route. |
| C02 | Locally committed before takeover; targeted test passed | `b222dde` + `ffaf173` + `b2be2b6`; `realpg-start-eligibility` 76/0 on isolated Postgres. Check browser Start/Pause only in the final journey. |
| C03 | Locally committed before takeover; targeted test passed | `193dbed`; `r02-draft-topics` 138/0. Test failed autosave and recovery in the client/upload journey. |
| C04 | Open | Make brand-alert claims and catch-up leases recoverable. Inject failures after claim/task/send. |
| C05 | Open | Per-editor/version acknowledgment and attributed override; two-editor test. Requires schema and backup verification first. |
| C06 | Partial | Independent follow-up reads now report availability and retry; 3 injected failure combinations passed in `a02-a04-delivery-truth`. A durable last-success timestamp and visual check remain. |
| C07 | Done in code, behavior proof open | Brief/project/message-center page loads no longer stamp `ThreadRead`. The shared message view advances only to the last loaded message when it enters view. Test direct brief, concurrent newer message, preview and read-state persistence in isolated browser/DB. |
| C08 | Done in code, visual proof open | Date picker pages through all returned days in groups of six. Test >6 dates, Pro session two, phone width and address reset. |
| C09 | Locally committed before takeover; targeted test passed | `f6109bb`; `r03-rollout-scope` 112/0. Recheck all queued-before-scope-change paths at release. |
| C10 | Locally committed before takeover; targeted test passed | Same rollout implementation; test normal named-client sign-in, excluded client and preview through the portal. |
| C11 | Partial | Current readiness code already names `transcript_jobs` as a dependency; old Stage A runbook omits it. Correct release package and inspect 5-job backlog before any activation. Real-model journey requires authorized spend. |
| C12 | Locally committed before takeover; targeted test passed | `c52d4a2` + `8654acb` + `77fa13d`; `isolation-boundary` 131/0. Build failure from `process.argv` in Edge graph repaired locally; production build passes. |
| C13 | Open | Reconcile month/output linkage and next-owner ladder for the named cases; test partial Pro, extra output, next month and reminders without rewriting history. |
| C14 | Open | Exclude durable synthetic identities from normal counts, retain test mode; review comms identity and reset a separate realistic demo. |
| C15 | Partial | Review Room now scopes its empty headline to cuts and labels mixed `media_qa` as delivery checks. Add the shared approved-but-undelivered summary and visual verification. |
| C16 | Partial | Home and Review Room now label optional unticked QC boxes as **not recorded**, and later reopening as cause unclassified. Replace legacy metric with confirmed, attributed revision-issue reporting before using staff KPIs. |
| C17 | Open | Share assignment display contract across Home, queue and brief without equating prediction to acceptance. |
| C18 | Open | Inspect the single wrong-property task and source read-only; test contradicted/unknown routing; propose exact repair, no mass relink. |
| C19 | Waiting on correct destination | Saved general welcome points at monthly Calendly. Determine the approved listing-client consultation URL or call/text policy; avoid replaying welcomes. User clarification requested. |

## Operating improvements

| ID | State | Next evidence |
|---|---|---|
| W01 | Open | Per-client, permission-scoped sibling-session and output-source overview; reconcile real conflicting counts before write. |
| W02 | Open | Exact output/version/approved script/logo/source/owner/deadline at the brief top; preserve existing asset decision gates. |
| W03 | Open | One confirmed formal revision path from each cut and chat; exact-version issue and clock proof. |
| W04 | Open | Final rendition verification attestation, without equating checkboxes with playback. |
| W05 | Open | Compact shared delivery summary at Review Room exit; distinct destination and notification states. |
| W06 | Open | Concrete photographer receipt, unfilmed versus missing upload, and changed brief delta. |

## UI phases and acceptance

| Phase | State | Remaining |
|---|---|---|
| U0 | In progress | Current disposition and isolated comparison set; C13/C14/C17 truth, per-client inventory and baseline screenshots. UX08's false autosave promise is removed; drafts survive a refresh in the current tab until explicit Save. |
| U1 | Open | Shared text/action/status/dialog patterns; contrast, keyboard and touch checks. |
| U2 | Open | One current monthly step, script/video review, client brand and schedule journey. UX08 suggestion replacement now requires a choice and has Undo; still needs browser and failure tests. |
| U3 | Open | Editing, upload, Review Room and delivery workspaces; W01–W06. |
| U4 | Open | Role-first Home, tasks, communications, nav and notification failure feedback. |
| U5 | Open | Settings summaries/search, validated reminders form, secondary-page consistency. |
| U6 | Open | UA01–UA14 evidence, actual team/phone tests, screenshot set and release matrix. |

**UX tracker:** UX01–UX07 open; UX08 partial; UX09–UX16 open. C15/C16 contain truthful copy changes only; they do not close a UI phase. The original 14 UA scenarios remain unpassed unless individually recorded here.

## Current checks and environment

- `npm run build` passed on Node 20 after the Edge-compatible drill backstop correction.
- Focused lint and TypeScript passed for changed files; existing unrelated lint warnings remain in older code.
- Five isolated drills passed, 479 checks total: delivery truth 22, real Postgres Start 76, draft topics 138, rollout scope 112, isolation boundary 131. No skips or failures.
- A normal `next dev` began on port 3000 during the work (PID 193/196, Sep 30 11:30 ET) and holds `.next/dev/lock`. The isolated demo refused to start in this checkout; it was not terminated. Visual acceptance is pending in an isolated checkout.
- No schema diff on this branch, no database write, no provider write, no deployment. Before a schema change, verify live migration state and fresh backup coverage; never reset or seed the shared database.
