# RealTour Pilot — Operations Hub

The in-house operations platform for RealTour Pilot, a real estate media agency.
The single source of truth for every shoot from **booked → delivered**, plus the
clients, team, deliverables, checklists, and notes around them.

This is **Milestone 1: the project pipeline**. It's the backbone the rest of the
vision (upload portal, smart client notes, finance/payouts, SOP assistant,
integrations with Aryeo / OpenPhone / Gmail / QuickBooks / Stripe / HubSpot /
Dropbox / Slack / SendGrid) will hang off of.

## What's built so far

- **Dashboard** — active projects, what needs attention (overdue / urgent / on hold),
  upcoming shoots, revenue in pipeline, and a live activity feed.
- **Pipeline board** — a drag-and-drop Kanban from Booked → Scheduled → Shot →
  Editing → Review → Delivered (plus On Hold / Cancelled). Every status change is
  logged automatically.
- **Project detail** — ordered deliverables with statuses, an interactive checklist,
  client info with editing preferences, highlighted **special requests**, schedule,
  order total, team assignments, and an activity timeline with notes / requests / flags.
- **Clients** — cards with contact info and auto-surfaced editing preferences & notes.
- **Team** — your people, roles, and current workload.
- **Upload Portal** (photographers) — pick a shoot, see special requests & editing
  preferences up front, smart reminders for what's still missing (floor plan, video,
  add-ons), upload files per item (saved to a local Dropbox-style folder), leave
  per-item + overall notes, flag issues. On submit it advances the project to
  "Shot / Uploaded" and **auto-generates a formatted editor-brief PDF** into the
  project folder. Uploaded files + the PDF surface on the project detail page.
- **Editor Queue** — projects in production grouped by editor, per-deliverable status.
- **Sales & Finance** — revenue this month, pipeline value, avg order, bookings-by-month
  chart, revenue by client, and an orders table. *(QuickBooks/Stripe sync comes later.)*
- **Payouts** — per-contractor ledgers computed from shoots/edits (photographers 30%,
  editors 12% of order), owed-now vs upcoming. *(Stripe transfers come with the integration.)*
- **Marketing** — recently delivered galleries as "ready to showcase" content + a
  campaigns scaffold. *(Social/email scheduling comes later.)*
- **Resources & SOPs** — categorized quick links (tools, booking, brand assets) and an
  SOP center. The tab Kyle uses day-to-day.
- **Ask the Hub** — a chat assistant that answers from your SOPs & resources today;
  built to graduate to an LLM trained on your real communications.

> The whole front-end shell is now in place. Sections marked "coming with integrations"
> are real, data-driven screens waiting on their API connection — not empty mockups.

## Tech

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Prisma 6 ORM with a local SQLite database (easy to move to Postgres later)

## Running it locally

This project needs **Node 20**. An `.nvmrc` is included.

```bash
nvm use            # switches to Node 20 (run `nvm install 20` first if needed)
npm install        # install dependencies
npm run db:push    # create the local database from the schema
npm run db:seed    # load realistic sample data
npm run dev        # start the app at http://localhost:3000
```

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app for local use / development |
| `npm run db:studio` | Open Prisma Studio — a spreadsheet-like view of all data |
| `npm run db:seed` | Reload the sample data |
| `npm run db:reset` | Wipe and recreate the database with fresh sample data |
| `npm run build` / `npm start` | Production build + run |

## Data model (Prisma)

See [`prisma/schema.prisma`](prisma/schema.prisma). Core models: `TeamMember`,
`Client`, `Project`, `Deliverable`, `ChecklistItem`, `Activity`.

## Roadmap (next milestones)

1. ✅ Photographer **upload portal** → folders, ordered-item checklist, notes →
   auto-generated editor PDF. *(Done — file storage is local today; swapping to the
   real Dropbox API is a single adapter in `src/lib/storage.ts`.)*
2. **Client CRM + smart notes** built from communication history.
3. **Finance / payouts** (Stripe + QuickBooks) with contractor payment rules.
4. **Integrations**: Aryeo (auto-import orders), OpenPhone, Gmail, HubSpot,
   Slack, SendGrid, Facebook Messenger.
5. **Resources & SOP center** + an "Ask the Hub" assistant trained on your comms.
