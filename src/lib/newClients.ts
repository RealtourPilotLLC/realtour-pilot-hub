import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// NEW CLIENTS — the ping, and the list behind the home-dashboard card.
//
// Jordan (Sep 7 2026): "New clients should trigger a ping to me and Kyle so
// that we see it on our dashboard, with a nice layout of info about them, and
// we can click and open their profile."
//
// WHO COUNTS AS NEW. Only a client the Aryeo webhook itself created, i.e. one
// carrying `firstSeenAt` (see the schema comment on that column). The 364 rows
// already on file were minted by bulk roster imports whose `createdAt` is the
// day a sync ran, so treating "recently created" as "new" would have paraded
// clients of two years across the dashboard on day one.
//
// The card ages out on its own — no dismiss button, nothing to remember to
// clear. A new client is news for a few days and then they are just a client,
// and a card that has to be closed is one more thing on Kyle's list.
// ---------------------------------------------------------------------------

/** How long a new client stays on the dashboard. Long enough to survive a
 *  weekend and a holiday Monday, short enough that the card is never a list. */
export const NEW_CLIENT_WINDOW_DAYS = 10;

export type NewClientRow = {
  id: string;
  name: string;
  company: string | null;
  avatarUrl: string | null;
  email: string | null;
  phone: string | null;
  licenseNumber: string | null;
  segment: string | null;
  socialPlan: string | null;
  /** when we first heard of them */
  firstSeenAt: Date;
  /** how they reached us, e.g. "aryeo-webhook" */
  firstSeenVia: string | null;
  /** the provisional working-profile line (buildNewClientBrief) */
  blurb: string | null;
  /** the welcome text provably went out at this moment (null = not yet) */
  welcomeTextAt: Date | null;
  /** what they have on the books, soonest first */
  booked: { id: string; title: string; shootDate: Date | null }[];
  bookedCount: number;
};

/** Everyone the hub met in the last `days`, newest first. Cheap by design:
 *  one indexed scan on firstSeenAt plus each row's own bookings. */
export async function newClientsForDashboard(
  opts: { days?: number; limit?: number } = {},
): Promise<NewClientRow[]> {
  const days = opts.days ?? NEW_CLIENT_WINDOW_DAYS;
  const limit = Math.min(opts.limit ?? 6, 25);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await prisma.client.findMany({
    where: {
      firstSeenAt: { gte: since },
      // An assistant folded under their agent is not a new client, they are the
      // same relationship reached from a second address (see parentClientId).
      parentClientId: null,
    },
    orderBy: { firstSeenAt: "desc" },
    take: limit,
    select: {
      id: true, name: true, company: true, avatarUrl: true, email: true, phone: true,
      licenseNumber: true, segment: true, socialPlan: true, socialClient: true,
      firstSeenAt: true, firstSeenVia: true, profileSummary: true, welcomeTextAt: true,
      projects: {
        where: { status: { notIn: ["CANCELLED"] } },
        orderBy: [{ shootDate: { sort: "asc", nulls: "last" } }],
        take: 3,
        select: { id: true, title: true, shootDate: true },
      },
      _count: { select: { projects: true } },
    },
  });

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    company: c.company,
    avatarUrl: c.avatarUrl,
    email: c.email,
    phone: c.phone,
    licenseNumber: c.licenseNumber,
    segment: c.segment,
    socialPlan: c.socialClient ? (c.socialPlan ?? "yes") : null,
    firstSeenAt: c.firstSeenAt!,
    firstSeenVia: c.firstSeenVia,
    // The brief's own first sentence already says it is provisional; the card
    // shows the sentence AFTER it, which is the part carrying actual facts.
    blurb: c.profileSummary ? clip(c.profileSummary, 260) : null,
    welcomeTextAt: c.welcomeTextAt,
    booked: c.projects,
    bookedCount: c._count.projects,
  }));
}

// ---------------------------------------------------------------------------
// THE PING. Bell row for the owner and Kyle, plus the ops Slack line they both
// actually read, deep-linked to the client's own page.
//
// `new_client` is not listed in notify.ts BELL_RULES, and an unlisted kind
// rings (fail open) — which is the behaviour we want, but that file's own
// header asks for every kind to be classified on purpose. See the report.
//
// Deduped on the client id, so the six identical CUSTOMER payloads Aryeo fires
// in a burst can never ring six times even if they somehow all reached here.
// Best-effort throughout: a ping must never fail a webhook.
// ---------------------------------------------------------------------------
export async function announceNewClient(clientId: string): Promise<void> {
  try {
    const c = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, company: true, email: true, phone: true, firstSeenVia: true },
    });
    if (!c) return;
    const where = c.company ? ` (${c.company})` : "";
    const how = c.firstSeenVia === "aryeo-webhook" ? "added in Aryeo" : "added to the hub";
    const { notifyInApp, opsAlert } = await import("@/lib/notify");
    const { appBase } = await import("@/lib/appUrl");
    await notifyInApp({
      kind: "new_client",
      title: `New client: ${c.name}${where}`,
      // No money anywhere near this row — it can reach an ADMIN, and the clamp
      // in notifyInApp only strips bodies bound for creatives.
      body: `Just ${how}. ${c.email ?? c.phone ?? "No contact details yet"} · open their profile to see what we know.`,
      href: `/clients/${c.id}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `new-client-${c.id}`,
    });
    await opsAlert(`👋 New client: ${c.name}${where} — ${how}. ${appBase()}/clients/${c.id}`);
  } catch {
    /* the ping is never allowed to break the webhook that raised it */
  }
}


/**
 * Everything a brand-new client gets, from whichever door they came in — the
 * webhook, the order sync, or the daily roster sweep. Without this the last two
 * created clients that never got the card, the brief or the welcome (review,
 * Sep 7). The bell is awaited (two cheap writes, and it is what a person is
 * waiting on); the brief makes an AI call, so it runs after the response when
 * there is a request to run after, and inline otherwise (cron, probes).
 */
export async function greetNewClient(clientId: string): Promise<void> {
  try { await announceNewClient(clientId); } catch { /* the ping never breaks a create */ }
  const brief = async () => {
    try {
      const { buildNewClientBrief } = await import("@/lib/clientProfile");
      await buildNewClientBrief(clientId);
    } catch { /* the nightly profile pass picks it up */ }
  };
  try {
    const { after } = await import("next/server");
    after(brief);
  } catch {
    await brief();
  }
}
