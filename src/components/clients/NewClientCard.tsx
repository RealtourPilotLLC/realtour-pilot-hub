import Link from "next/link";
import { UserPlus, Building2, Mail, Phone, CalendarClock, MessageCircle, ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { etDate, etDateTime } from "@/lib/datetime";
import type { NewClientRow } from "@/lib/newClients";

// ---------------------------------------------------------------------------
// "Say hello" — the new-client card on the home dashboard.
//
// Jordan (Sep 7 2026): "New clients should trigger a ping to me and Kyle so
// that we see it on our dashboard, with a nice layout of info about them, and
// we can click and open their profile."
//
// So the whole row is the link. What it has to answer at a glance is: who is
// this, where do they work, how did they get here, and have they booked
// anything — the four questions Kyle would otherwise open three tabs to answer.
//
// It also says whether the welcome text has gone out, because that is the one
// thing on this card that a person might have to do something about: a client
// with no phone number on file will never get one automatically, and this is
// where that shows up rather than in a cron log nobody reads.
//
// Renders nothing at all when there are no new clients. An empty state here
// would be one more box on a screen Jordan already asked to be shorter.
// ---------------------------------------------------------------------------

function arrival(row: NewClientRow): string {
  const when = etDate(row.firstSeenAt);
  return row.firstSeenVia === "aryeo-webhook" ? `Added in Aryeo ${when}` : `Added ${when}`;
}

function booking(row: NewClientRow): string {
  if (row.booked.length === 0) return "Nothing booked yet";
  const first = row.booked[0];
  const street = first.title.split(",")[0].trim();
  const when = first.shootDate ? etDateTime(first.shootDate) : "date to be set";
  const more = row.bookedCount > 1 ? ` (+${row.bookedCount - 1} more)` : "";
  return `${street} · ${when}${more}`;
}

export function NewClientCard({ clients }: { clients: NewClientRow[] }) {
  if (clients.length === 0) return null;
  return (
    <div className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-brand" />
          <h2 className="text-sm font-semibold">Say hello</h2>
          <span className="rounded-full bg-brand/10 px-1.5 text-xs font-medium text-brand">
            {clients.length} new client{clients.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="hidden text-xs text-muted sm:inline">Open one to see everything we know</span>
      </div>

      <div className="grid gap-px bg-border">
        {clients.map((c) => (
          <Link
            key={c.id}
            href={`/clients/${c.id}`}
            className="group flex items-start gap-3 bg-surface px-5 py-3.5 hover:bg-surface-2"
          >
            <Avatar name={c.name} src={c.avatarUrl} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-semibold">{c.name}</span>
                <SegmentBadge segment={c.segment} size="xs" />
                {c.socialPlan && (
                  <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                    Social {c.socialPlan}
                  </span>
                )}
                <span className="text-[11px] text-muted-2">{arrival(c)}</span>
              </div>

              {/* Who they are, from the contact record itself. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                {c.company && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Building2 className="size-3 shrink-0" />
                    <span className="truncate">{c.company}</span>
                  </span>
                )}
                {c.email && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Mail className="size-3 shrink-0" />
                    <span className="truncate">{c.email}</span>
                  </span>
                )}
                {c.phone && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="size-3 shrink-0" />
                    {c.phone}
                  </span>
                )}
                {c.licenseNumber && <span className="text-muted-2">Lic. {c.licenseNumber}</span>}
              </div>

              {/* What they have on the books. */}
              <div className="mt-1 flex items-center gap-1 text-xs">
                <CalendarClock className="size-3 shrink-0 text-muted-2" />
                <span className={c.booked.length ? "text-foreground/80" : "text-muted-2"}>{booking(c)}</span>
              </div>

              {/* The provisional brief. It opens with "New client. This is
                  everything we know so far…", which is exactly the framing this
                  card wants, so it is shown as written rather than trimmed to
                  look like a researched summary. */}
              {c.blurb && <p className="mt-1.5 text-[13px] leading-snug text-muted">{c.blurb}</p>}

              <div className="mt-1.5 flex items-center gap-1 text-[11px]">
                <MessageCircle className="size-3 shrink-0 text-muted-2" />
                {c.welcomeTextAt ? (
                  <span className="text-muted-2">Welcome text sent {etDate(c.welcomeTextAt)}</span>
                ) : c.phone ? (
                  <span className="text-muted-2">Welcome text goes out when their first shoot is booked</span>
                ) : (
                  // The one thing on this card a person may need to fix.
                  <span className="font-medium text-warning">No phone number on file. The welcome goes by email if we have one, otherwise it waits</span>
                )}
              </div>
            </div>
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-2 group-hover:text-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}
