# AutoHDR API: verified facts, unsupported features, implementation plan

Source of truth: AutoHDR's own `https://external.realestatephotoediting.com/openapi.json`
(OpenAPI 3.1, API version 0.1.0, sha256 a5205364…) and `/llms.txt` (sha256 3fc6feeb…),
both read Oct 13 2026. Nothing below is assumed; anything the spec does not state is
listed under "Not supported or not documented". No live call has been made yet.

## 1. What the API documents

| Area | Fact (from the spec) |
|---|---|
| Auth | OAuth 2.0 `client_credentials` at `https://new.autohdr.com/api/auth/oauth2/token`, `resource=https://external.realestatephotoediting.com/v1` required. Scopes: `photoshoots:read`, `photoshoots:write` (create, commit, download), `images:edit` (transforms, mask/reference uploads), `presets:read`, `presets:run`. "A read-only token cannot spend credits." An `authorization_code` grant exists for acting on behalf of other AutoHDR users (not needed here). |
| Discovery | `GET /v1/capabilities` (transforms: `name`, `version`, `display_name`, `category`, `description`, `credit_cost`, `requires_mask`, `input_schema`, `looks[]`), `GET /v1/models?type=all\|predefined\|custom` (`id`, `name`, `type`, `variant` indoor/outdoor/indoor-outdoor, `style_credit_cost`), `GET /v1/presets`. The spec says: fetch at runtime, never hardcode names, ids or prices. |
| Money | Credits only. `GET /v1/credits`, `GET /v1/me` (`credit_balance`). Download: 1 credit per first-time photo, re-downloads free. Transforms: catalog `credit_cost`, charged on submit, "skipped or failed steps are refunded". `style`: the model's `style_credit_cost`. Presets: `credit_cost` per photo. 402 `insufficient_credits` charges nothing. |
| Media in | `POST /v1/photoshoots` returns presigned S3 PUT URLs (expire in 5 minutes, exact `content_type` required). `POST /v1/photoshoots/from-urls`: AutoHDR fetches from Dropbox, Amazon S3 or ChatGPT/OpenAI attachment hosts only. File `kind`: `raw` (full HDR) or `display` (finished JPEG, no HDR). Masks/references: `asset-uploads` with `kind` `mask` or `reference` (default `reference`), PNG or JPEG, returns `s3://` URLs. Preset ports take `photo` or `video`. |
| Media out | `POST …/photos/download`: presigned full-res URLs valid 6 hours, always `.jpg` (video clips keep theirs). Returns the HEAD version only. |
| Versions | Every transform mints a version; on the head it becomes the new head (edits compound). `GET …/history` gives the chain (`image_version_uuid`, `parent_image_version_uuid`, `is_head`, `label`). `POST …/version` moves the head (free, reversible). A redo on an earlier version, or a `style` result, does not become head on its own. |
| Jobs and polling | Photoshoot: `GET …/status`, `in_progress` → `success`/`failure`, HDR plan ~30 min, up to 1 h. Transform: `GET /v1/transforms/{job_id}` (or its `status_url`), `queued` → `running` → `succeeded`/`failed`, typically 30 s to 2 min; `succeeded` with a null `output_image_version_uuid` is a no-op. Preset runs return one `workflow_uuid` per photo, polled with the same `getTransformJob`. `GET /v1/transforms?photoshoot_id=&state=active\|history\|all` lists jobs (default `active` hides finished ones). |
| Lists | Zero-based `page`, `page_size` max 100 (presets 200), `page_count`, `total`. `listPhotoshoots` only returns shoots created in the last 7 days. |
| Errors | `{error, error_description}` + `X-Request-Id`; 422 validation bodies are `{detail:[…]}`. Codes named: `insufficient_credits` 402, `transform_not_exposed` 403, `mask_required` / `model_id_required` / `prompt_not_supported` 400, `files_not_landed` 409 (retry commit), `conflict` 409 (already committed), `photoshoot_expired` 410, 429 with `Retry-After`. |

## 2. Not supported or not documented (we will not build on these)

1. **No webhooks or callbacks.** Polling only: our 5-minute cron plus an on-demand refresh while a page is open.
2. **No idempotency keys.** Every paid POST (download, transform, preset run, create, commit) is written to our database as intent BEFORE the call, never retried automatically, and recovered by listing jobs, never by resubmitting.
3. **No version-specific download.** To fetch an earlier version we must move the head (free), download, and move it back. That is a visible change in AutoHDR's gallery, so we only do it on purpose.
4. **No cost estimate, usage history, invoices or top-up endpoint.** Estimates come from the live catalog; we keep our own credit ledger; top-ups stay in AutoHDR's web app.
5. **No dollar prices.** The API prices everything in credits. The dollars-per-credit rate is Jordan's plan rate (a setting). Client retail prices are Jordan's own and unrelated to AutoHDR cost.
6. **7-day retention.** Shoots older than 7 days answer 410; results must be copied to our own storage within the window.
7. **No source filter on shoots.** Watcher, web-app, Aryeo-app and API shoots are listed together; matching a shoot to a job is by address and date, and ambiguous matches are refused.
8. **No API to put photos on an Aryeo listing or deliver it.** Aryeo's public API cannot either; that last step stays in Aryeo.
9. **Rate limits and the list of accepted RAW formats are not published.** We honour 429 `Retry-After` and do not claim format support beyond JPEG/PNG for assets.
10. **Per-transform parameters may be undocumented.** `input_schema` can be null; the only documented parameter example is `repaint` `{"color": "#RRGGBB"}` and `params.look` for looks. A transform whose inputs we cannot validate is not offered.
11. **The actual transform names, model ids and prices are unknown to us until the first free live read.** The spec's prose mentions twilight, grass, declutter, reedit, repaint, staging, camera_removal, autoremove, autofill and style as examples only.

## 3. Implementation plan (mock-first, reusing the hub)

Reuse, do not rebuild: auth (`guards.ts` roles; the client portal session for anything client-facing), the design system (`Section`, tokens, lucide icons), jobs and orders (`Project`, `OrderItem`, the Aryeo sync), storage (the private Blob store + Dropbox), checkout (the existing Stripe checkout used by website sign-ups), notifications (bell, Slack, text through `notifyOps`).

1. **Credentials (done, live).** Owner-only Connections card; secret encrypted server-side; tested with a free balance read; read-only token for every GET, full scope only for POSTs.
2. **Mock transport + contract tests (next, no live calls).** A fixture server built from the spec's schemas for every endpoint and every documented error (401 refresh, 402, 403, 409 both kinds, 410, 422 `{detail}`, 429 `Retry-After`, 5xx, a POST whose response is lost). Drills run the whole fix flow against it.
3. **Job persistence.** Each paid action is a row before it is sent: `PhotoFixOperation` holds `autohdrJobId`, `inputVersionUuid`, `outputVersionUuid`, status `QUEUED → SUBMITTING → SUBMITTED → SUCCEEDED / NOOP / FAILED / VERIFIED / REVERTED`; `PhotoVersion` keeps every original and result version id; `AutohdrCreditEntry` records every charge and refund. A `SUBMITTING` row is resolved by `listTransforms(state=all)`, never resent blindly.
4. **Free live reads (after the key is saved, still no spend).** `me`, `credits`, `capabilities`, `models`, `photoshoots`, `photos`, `history` on one recent shoot: record the real catalog, confirm how shoots are named and which photos are already `downloaded`.
5. **Paid test, only with Jordan's explicit OK.** One transform on one photo of a non-client test shoot, with the exact live credit cost shown first.
6. **Tenant boundaries.** Every AutoHDR id lives on a hub row tied to one job and client. Nothing accepts a photoshoot or image id from a browser; actions take hub ids, resolve them server-side, and check the caller may act on that job (staff) or owns that listing (client portal).
7. **Client-facing ordering (only if that is what the mockup is).** Needs the mockup and Jordan's retail prices: the client picks an edit on their own listing photo, pays through the existing Stripe checkout, the paid order becomes a fix operation queued for staff approval, and the result is delivered through the portal.

## 4. Additions from the full reference guides (`/reference`, read Oct 14 2026)

- Documented transform names (examples in the guides; the live `/v1/capabilities` still decides): `reedit` (prompt required; optional mask or references), `autoremove` and `autofill` (mask required; `autofill` also needs a prompt or a reference), `twilight` (`params.look` from the catalog's `looks`), `grass`, `declutter`, `repaint` (`params.color`), `single_angle_staging`, `style` (needs `model_id`; result must be made head with `setPhotoVersion`), and `camera_removal` (named in the job docs as a common no-op).
- More error codes: `invalid_reference_url` 400, `model_not_available` 403, `plan_required` 403, `content_policy` (async failure).
- AutoHDR's retry table: GETs, 402, 429, `files_not_landed` and transient 5xx are "safe to retry (nothing committed)"; `POST /v1/transforms` and the paid endpoints are not idempotent. The hub still looks a job up (`GET /v1/transforms?state=all`) before resubmitting after any uncertain outcome.
- `listTransforms` needs `photoshoot_id`; finished jobs only appear with `state=history|all`; a job never disappears by id.

## 5. The mockup (AutoHDR's "What's possible with AutoHDR API" showcase)

Three use cases for a media company's own software. Prices shown there are illustrative retail prices, not AutoHDR costs.

| Use case | What it needs from the API | Status in the hub |
|---|---|---|
| **Client Order**: the client picks an editing style (e.g. Classic included, Architectural +$35) and per-shoot add-ons (Fire, Grass, TV screens, Declutter) when ordering | Create-time `indoor_model_id` / `outdoor_model_id` and `enhancements` exist only when the HUB creates the shoot through the API. Today edits come from AutoHDR's own integrations, which use the account defaults. | Decision for Jordan: switching to API-created shoots means taking raws out of whatever AutoHDR currently watches, or every shoot is edited (and charged) twice. Not built until he decides. |
| **Client Revisions**: the client asks for a change on a delivered photo | `reedit` / `autoremove` / `autofill` / fixed transforms on the existing shoot within 7 days; after that a new `display` shoot from the delivered JPEG. | Built as the staff Fix Cart first (staff approve every paid edit); a client request page comes after, feeding the same cart. |
| **Client Upsells**: offer a virtual twilight, staging or a different look on a listing photo | `twilight` (looks), `single_angle_staging`, `style`, priced from the live catalog; retail price set by Jordan. | Needs Jordan's retail prices. Checkout reuses the existing Stripe checkout; a paid order becomes a queued fix that staff release. |
