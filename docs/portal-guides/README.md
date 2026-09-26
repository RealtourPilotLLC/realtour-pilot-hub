# Portal guides — drafts, NOT published

The nine basic client guides the completion audit asked for (CP-13, Sep 24 2026). They are
**drafts**: nothing here is in the database, and nothing reaches a client until Jordan publishes it.

- One file per guide. The front matter is what the Resources authoring page asks for: `title`,
  `group` (a Resources group key), `summary`, `platform`, `device`, `actions` (the portal steps the
  guide is linked from), `order`, `owner`. `slug` is the address the portal links to
  (`?tab=resources&r=<slug>`); it is derived from the title the same way `/content/resources` does.
- `scripts/draft-portal-guides.ts` checks every draft (no placeholder words, no em dashes in client
  copy, slug matches title) and writes `guides.json` beside them: the exact input the authoring page
  takes, each one **unpublished**. It never opens a database.
- **Publishing is Jordan's.** On `/content/resources`: create each guide from its file (or have them
  loaded as unpublished rows when he says so), read it, give it an owner (Kyle is proposed), and
  press Publish. Publishing refuses a guide with no owner or with placeholder text.
- Instagram publishing and the advanced growth guides are NOT drafted here. The Resources tab shows
  them as "Coming soon" from code (`COMING_SOON` in `src/lib/portalResources.ts`), so a half-written
  one can never be published by accident.

Facts these drafts rely on, all Jordan's settled decisions: Starter 2 videos, Accelerator 4, Pro 8
(two separate four-hour sessions); weekday sessions only; 72 weekday hours of preparation, counted
from the submitted answers or the booked strategy call's scheduled end (Sep 25 2026, was 48); inside
24 hours the client calls or texts Kyle at (215) 645-4889; production 7 to 10 business days from
each session's end; revisions targeted within 24 to 48 weekday hours; a four-business-day review
window; two included revision rounds; billing on the Stripe anniversary, production by calendar
month; and no promise that a browser saves straight into Photos.
