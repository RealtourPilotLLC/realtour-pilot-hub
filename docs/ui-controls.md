# Shared control contract

These components extend the existing theme, `Badge`, `Section`, `ModalDialog`
and `ActionMenu`. They contain presentation and native browser semantics;
permissions, confirmation, rollout scope and mutation receipts stay with domain
actions. The migration is incremental.

| Component | Use and behavior |
|---|---|
| `Button` | Native button, `type="button"` by default; explicit submit supported. Primary, secondary, quiet and danger variants. Busy disables duplicate input, exposes `aria-busy` and keeps a readable pending label. 44px minimum target. |
| `ActionLink` | A real Next link for navigation. An unavailable destination should have explanatory text rather than a false disabled link. |
| `FormField` / `TextField` | Native label/control association and linked hint/error IDs. Error uses `aria-invalid` and an alert. Controlled input and caller text remain intact. TextField uses 16px input text by default; staff numeric fields retain 14px. |
| `SaveStatus` | Loaded, dirty, saving, saved, error, partial and information states. Success comes from a confirmed receipt. Late success must leave newer edits dirty. Error is announced and includes a recovery step. |
| `ModalDialog` | Existing native dialog, browser top layer, initial focus, contained focus, pending dismissal guard and focus return. Controlled `open` can keep drafts mounted. |
| `ActionMenu` | Existing queue menu with arrow/Home/End keys, Escape/Tab dismissal, disabled reasons and focus return. |
| `Badge` | Existing theme-aware status words. Color alone does not communicate status. |
| `CopyButton` | Native 44px control; supported clipboard completion is required for an exact-value receipt. Denied/unavailable copies show failure, including icon-only callers. Pending blocks duplicate taps; labels match visible words. |
| `MarkdownEditor` | Existing formatting/selection logic; wrapping labeled native toolbar and Write/Preview pressed state. 44px controls and 16px native input with visible focus. |

Initial consumers are core Settings save rows and numeric controls, notification
switch targets, and client planning/cancellation controls. Server actions, input
bounds, client eligibility and stored preferences are unchanged. Caller error
messages still provide the specific reason; shared status does not infer a send
or booking succeeded.

The development-only `/settings/ui-preview` route uses Settings access and fixed
fictional data. It is unavailable outside development and calls no provider or
domain mutation. Compare the staff theme and client light palette at 375, 390,
768 and laptop widths, 200% zoom, and keyboard use. It includes loaded, dirty,
saving, saved, error, partial, empty, filtered-empty and disabled examples.

Token calculations are a preliminary contrast check; rendered contrast, focus,
clipping and phone acceptance remain open while local browser access is blocked.
Do not record U1 or UA10–UA12 complete from server markup alone.

Shared PageHeader and Section headers now wrap long titles/actions; shared
status labels use the 13px status scale and allow long labels to wrap. Portal
section titles use 16px and failed-load copy uses 14px. These shared consumers
reach client, schedule, resource and team pages; their route-specific forms,
tables and editors still need the fixed responsive/zoom comparison. Finance
content, calculations and pay policies are untouched.

Secondary acceptance still open: Clients list/detail tables, Schedule calendar
and appointment forms, Resource editors, Team roster/access forms, financial
views under their actual roles, and remaining setting panels. Check both staff
themes, long names, 200% zoom and tablet widths before claiming their migration
complete. No new tests mirror these reversible class changes; lint/build and
the pending visual comparison are the appropriate gates.

MonthHeader's existing picker/Skip controls and native SubNav links now inherit
44px targets, focus and readable type. The staff library's native summaries,
status/identity/release text and named cut-history overflow region share these
scales. Its all-month default remains. ClientReview fee/clock/hold forms,
LibraryIdentityEditor and MonthControls subsequently received exact receipt,
newer-draft and unknown-state recovery (`59af2da`,38/0). Office review fee/clock/
hold controls now use the shared native action contract with exact-record
recovery (`59af2da`,25/0). No month filter or financial policy was introduced.

## High-use secondary source coverage and remaining acceptance

These entries reconcile the earlier generic "embedded editors" remainder with
completed, bounded source batches. They do not close U1/U5/UX16 or UA10–UA12.

| Surface | Local source/checkpoint evidence | Acceptance still required |
|---|---|---|
| Clients list/workspace | `d57cbe9`, `dc925a3`21/0; native headings/actions and snapshot-specific drafts/AI/copy/partial save | Long names, tables, keyboard and mounted refresh/failure |
| Appointments/Schedule | `681030b`, `9a721dc` UI23/0/action13/0; readable exact-date/email controls and device holds | Normal role/calendar navigation, provider/phone and partial outcomes |
| Resources | `f154bb4`, `d9f5306`33/0; retained per-guide sessions, read failures and typed outcomes | Group/removal remounts in browser, Markdown selection, publication/owner focus |
| Month/library | `1570ba5`, `59af2da`38/0+25/0; native stage/history/identity/review controls | Normal money/creative roles, exact-cut browser/media, long history/overflow |
| Team/Logins | `d57cbe9`, `5ae370a`26/0, `41c8baf`29/0+15/0+13/0 | Clipboard, long roster, native focus, actual authorized provider/identity outcomes |
| Capacity/WeekCalendar | `6972796`20/0; native disclosure, newer-draft/unknown guards and all-day count | Normal editor/admin, retained mounted input, phone/date controls |
| Settings/delivery/readiness | `018f22f`9/0+12/0; `0cd3d71`21/0; `4a189d4`12/0; `3c6b2d2`22/0; `9e04cd3` | Search/anchors, themes/zoom, disabled/unknown recovery under real role sessions |

Map's focused source batch adds keyboard suggestions and exact-pin read recovery
with actual fake handlers/effects36/0, lint and root review. The handoff records
its exact skip/scroll repairs. Leaflet canvas/tiles, rendered listbox placement/
scroll, both themes and phone/zoom acceptance remain open.

Individual Finance/Trends, My Pay/HR, Catalog, Training, Assistant, Feedback and
Connections interiors are explicitly unreviewed in the current rendered
comparison. Include their existing permissions and shared-shell/theme effects
in U6; preserve content and monetary/pay policy. A broad rewrite of all interiors
is not required by the audit's initial-release control contract.
