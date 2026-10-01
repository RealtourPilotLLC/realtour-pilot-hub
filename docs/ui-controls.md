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
