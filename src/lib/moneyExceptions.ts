import "server-only";

import { prisma } from "@/lib/prisma";
import { canSeeMoney } from "@/lib/auth/access";
import { DEDUPE_CANDIDATES_KEY, type DuplicateCandidate } from "@/lib/clientDedupe";

// ---------------------------------------------------------------------------
// MONEY AND IDENTITY EXCEPTIONS (unified handoff §10, AU-25 / I2 / I3, Sep 26).
//
// The places where what a client PAYS FOR, what they are GIVEN and WHO they
// are stop agreeing — read from records the hub already holds, and shown to
// the owner on Finance → Overview. Six kinds:
//
//   1. subscription-lapsed-active-enrollment  Stripe says the plan lapsed; the
//      enrollment is still live. (checkSubscription persists the status it
//      reads, so this is a READ here, never a Stripe call on render.)
//   2. enrollment-ended-subscription-active   the enrollment is over; the
//      card is still being billed.
//   3. signup-parked                          a paid signup the activation
//      could not place (stripeSignups.signupsNeedingReview).
//   4. program-order-balance                  an Aryeo order for a program
//      session shows money owed while the program is Stripe-paid — the R03
//      question made visible.
//   5. duplicate-with-split-aryeo             a duplicate candidate that sits
//      on TWO Aryeo customers: credits may be on either, and a hub merge
//      moves none of them.
//   6. alias-conflict                         a program login alias that is
//      another client's own address.
//
// IT ONLY EVER REPORTS (§4: "charges, refunds, credit transfers, vendor
// top-ups, client-account merges — preserve existing authorities"). No row has
// a button that writes to Stripe, Aryeo or QuickBooks, and nothing here
// pauses, ends, merges or refunds anything. Owner-only: every other viewer
// gets an empty list, whatever page asks.
// ---------------------------------------------------------------------------

export type MoneyExceptionKind =
  | "subscription-lapsed-active-enrollment"
  | "enrollment-ended-subscription-active"
  | "signup-parked"
  | "program-order-balance"
  | "duplicate-with-split-aryeo"
  | "alias-conflict";

export const MONEY_EXCEPTION_LABEL: Record<MoneyExceptionKind, string> = {
  "subscription-lapsed-active-enrollment": "Plan lapsed, enrollment still live",
  "enrollment-ended-subscription-active": "Enrollment ended, card still billed",
  "signup-parked": "Paid signup waiting on you",
  "program-order-balance": "Program session order shows money owed",
  "duplicate-with-split-aryeo": "Possible duplicate on two Aryeo customers",
  "alias-conflict": "Login alias belongs to another client",
};

export type MoneyException = {
  id: string;
  kind: MoneyExceptionKind;
  title: string;
  why: string;
  /** the facts the row stands on, in words, each one checkable */
  evidence: string[];
  owner: "Jordan";
  nextAction: string;
  href: string;
  since: Date | null;
};

/** Stripe's lapsed states (stripeSignups.LAPSED). */
const LAPSED = new Set(["canceled", "unpaid", "past_due", "incomplete_expired"]);
const BILLING = new Set(["active", "trialing"]);

type Viewer = { role?: string | null; realRole?: string | null } | null;

/**
 * The owner's list. `viewer: null` is only for code with no session at all
 * (the drill, a script) and is treated as NOT the owner — the list is empty.
 */
export async function moneyExceptions(viewer: Viewer): Promise<MoneyException[]> {
  if (!viewer || !canSeeMoney(viewer.role ?? null) || (viewer.realRole != null && !canSeeMoney(viewer.realRole))) return [];
  const out: MoneyException[] = [];
  const settle = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

  // ---- 1 + 2: subscription vs enrollment ----------------------------------
  const signups = await settle(
    prisma.programSignup.findMany({
      where: { subscriptionId: { not: null }, enrollmentId: { not: null }, subscriptionStatus: { not: null } },
      orderBy: { paidAt: "desc" },
      select: { id: true, name: true, email: true, productName: true, subscriptionId: true, subscriptionStatus: true, subscriptionCheckedAt: true, enrollmentId: true, clientId: true },
    }),
    [],
  );
  // The newest signup per enrollment speaks for it.
  const bySub = new Map<string, (typeof signups)[number]>();
  for (const s of signups) if (s.enrollmentId && !bySub.has(s.enrollmentId)) bySub.set(s.enrollmentId, s);
  const enrollments = bySub.size
    ? await settle(prisma.contentEnrollment.findMany({ where: { id: { in: [...bySub.keys()] } }, select: { id: true, status: true, clientId: true, package: true } }), [])
    : [];
  const clientName = await namesFor([...enrollments.map((e) => e.clientId)]);
  for (const e of enrollments) {
    const s = bySub.get(e.id)!;
    const status = (s.subscriptionStatus ?? "").toLowerCase();
    const who = clientName.get(e.clientId) ?? s.name ?? s.email ?? "A program client";
    const checked = s.subscriptionCheckedAt ? `as of ${s.subscriptionCheckedAt.toISOString().slice(0, 10)}` : "";
    if (LAPSED.has(status) && e.status === "ACTIVE") {
      out.push({
        id: `sub-lapsed:${e.id}`,
        kind: "subscription-lapsed-active-enrollment",
        title: who,
        why: `Stripe reports the plan ${status.replace("_", " ")}, and the ${e.package} enrollment is still active`,
        evidence: [`Stripe subscription ${s.subscriptionId}: ${status} ${checked}`.trim(), `Enrollment status: ${e.status}`, `Signup: ${s.productName}`],
        owner: "Jordan",
        nextAction: "Decide: chase the payment, or pause the enrollment yourself — nothing pauses it automatically",
        href: `/content/${e.id}`,
        since: s.subscriptionCheckedAt,
      });
    } else if (BILLING.has(status) && e.status === "ENDED") {
      out.push({
        id: `sub-billing:${e.id}`,
        kind: "enrollment-ended-subscription-active",
        title: who,
        why: `The enrollment has ended but Stripe still reports the plan ${status}`,
        evidence: [`Stripe subscription ${s.subscriptionId}: ${status} ${checked}`.trim(), `Enrollment status: ENDED`],
        owner: "Jordan",
        nextAction: "Cancel the subscription in Stripe if the program is really over — the hub never touches Stripe",
        href: `/content/${e.id}`,
        since: s.subscriptionCheckedAt,
      });
    }
  }

  // ---- 3: parked signups -----------------------------------------------------
  const parked = await settle(
    import("@/lib/stripeSignups").then((m) => m.signupsNeedingReview()),
    [] as Awaited<ReturnType<typeof import("@/lib/stripeSignups").signupsNeedingReview>>,
  );
  for (const p of parked) {
    out.push({
      id: `signup:${p.id}`,
      kind: "signup-parked",
      title: p.name ?? p.email ?? "A paid signup",
      why: p.note ? `Paid for ${p.productName} — parked: ${p.note}` : `Paid for ${p.productName} and could not be placed on its own`,
      evidence: [`Paid ${p.paidAt.toISOString().slice(0, 10)}`, p.enrollmentId ? `Enrollment ${p.enrollmentId}` : "No enrollment made"],
      owner: "Jordan",
      nextAction: "Open the Content Program strip and place or resolve the signup",
      href: "/content",
      since: p.paidAt,
    });
  }

  // ---- 4: a program session's Aryeo order shows money owed -----------------
  const requests = await settle(
    prisma.programSessionRequest.findMany({
      where: { status: { notIn: ["CANCELLED", "DECLINED", "EXPIRED"] }, OR: [{ projectId: { not: null } }, { aryeoOrderId: { not: null } }] },
      select: { id: true, enrollmentId: true, clientId: true, projectId: true, aryeoOrderId: true, slotStart: true },
      take: 500,
    }),
    [],
  );
  if (requests.length) {
    const paidEnrollments = new Set(
      (await settle(prisma.programSignup.findMany({ where: { enrollmentId: { in: [...new Set(requests.map((r) => r.enrollmentId))] } }, select: { enrollmentId: true, subscriptionStatus: true } }), []))
        .filter((s) => !s.subscriptionStatus || BILLING.has(s.subscriptionStatus.toLowerCase()))
        .map((s) => s.enrollmentId as string),
    );
    const projects = await settle(
      prisma.project.findMany({
        where: { id: { in: requests.map((r) => r.projectId).filter((x): x is string => !!x) } },
        select: { id: true, title: true, balanceAmount: true, paymentStatus: true, aryeoOrderId: true },
      }),
      [],
    );
    const attempts = await settle(
      prisma.programBookingAttempt.findMany({
        where: { aryeoOrderId: { in: requests.map((r) => r.aryeoOrderId).filter((x): x is string => !!x) }, orderBalanceCents: { gt: 0 } },
        select: { aryeoOrderId: true, orderBalanceCents: true, orderPaymentStatus: true },
      }),
      [],
    );
    const names = await namesFor(requests.map((r) => r.clientId));
    for (const r of requests) {
      if (!paidEnrollments.has(r.enrollmentId)) continue;
      const pr = r.projectId ? projects.find((p) => p.id === r.projectId) : undefined;
      const at = r.aryeoOrderId ? attempts.find((a) => a.aryeoOrderId === r.aryeoOrderId) : undefined;
      const owedCents = (pr?.balanceAmount ?? 0) > 0 ? pr!.balanceAmount! : at?.orderBalanceCents ?? 0;
      const unpaid = !!pr?.paymentStatus && !/^paid$/i.test(pr.paymentStatus);
      if (owedCents <= 0 && !unpaid) continue;
      out.push({
        id: `order-balance:${r.id}`,
        kind: "program-order-balance",
        title: `${names.get(r.clientId) ?? "A program client"}${pr ? ` — ${pr.title.split(",")[0]}` : ""}`,
        why: owedCents > 0
          ? `The Aryeo order for a program session shows $${(owedCents / 100).toFixed(2)} owed, while the program is paid through Stripe`
          : `The Aryeo order for a program session reads ${pr?.paymentStatus?.toLowerCase().replace(/_/g, " ")}, while the program is paid through Stripe`,
        evidence: [
          r.aryeoOrderId ? `Aryeo order ${r.aryeoOrderId}` : pr?.aryeoOrderId ? `Aryeo order ${pr.aryeoOrderId}` : "Aryeo order on the job",
          pr ? `Job balance: ${pr.balanceAmount != null ? `$${(pr.balanceAmount / 100).toFixed(2)}` : "not read"} · payment status ${pr.paymentStatus ?? "unknown"}` : `Booking read-back: $${((at?.orderBalanceCents ?? 0) / 100).toFixed(2)} · ${at?.orderPaymentStatus ?? "unknown"}`,
          "Enrollment has a Stripe signup",
        ],
        owner: "Jordan",
        nextAction: "Check the order in Aryeo before anyone asks this client to pay — it may be the prepaid plan counted twice",
        href: pr ? `/projects/${pr.id}` : `/content/${r.enrollmentId}`,
        since: r.slotStart,
      });
    }
  }

  // ---- 5: duplicate candidates split across two Aryeo customers -------------
  const snap = await settle(prisma.appSetting.findUnique({ where: { key: DEDUPE_CANDIDATES_KEY } }), null);
  if (snap) {
    let candidates: DuplicateCandidate[] = [];
    let at: Date | null = null;
    try {
      const parsed = JSON.parse(snap.value) as { at?: string; candidates?: DuplicateCandidate[] };
      candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      at = parsed.at ? new Date(parsed.at) : null;
    } catch { /* an unreadable snapshot is no list, not an exception */ }
    const split = candidates.filter((c) => new Set(c.clients.map((x) => x.aryeoCustomerId).filter(Boolean)).size >= 2);
    // A pair a person already ruled "different people" (closed its decision
    // task) is answered, not an exception.
    const decided = split.length
      ? new Set(
          (await settle(prisma.smartTask.findMany({ where: { dedupeKey: { in: split.map((c) => `client-dupe-${c.key}`) }, status: { in: ["COMPLETED", "CANCELLED"] }, OR: [{ sourceDetail: null }, { sourceDetail: { not: "superseded-by-scan" } }] }, select: { dedupeKey: true } }), []))
            .map((t) => t.dedupeKey),
        )
      : new Set<string | null>();
    for (const c of split) {
      if (decided.has(`client-dupe-${c.key}`)) continue;
      const ids = [...new Set(c.clients.map((x) => x.aryeoCustomerId).filter(Boolean))];
      out.push({
        id: `dupe-split:${c.key}`,
        kind: "duplicate-with-split-aryeo",
        title: c.clients.map((x) => x.name).join(" / "),
        why: `Looks like one person, but Aryeo holds ${ids.length} separate customers`,
        evidence: [
          ...c.clients.map((x) => `${x.name}: Aryeo ${x.aryeoCustomerId ?? "none"}, ${x.projects} order(s)`),
          ...(c.matchedOn.length ? [`Matched on ${c.matchedOn.join(", ")}`] : []),
          "Credits and balances may sit on either Aryeo customer — a hub merge does not move them, and the hub will refuse that merge",
        ],
        owner: "Jordan",
        nextAction: "Check both customers in Aryeo (credits, open balances) before deciding anything in the hub",
        href: "/tasks?tab=other",
        since: at,
      });
    }
  }

  // ---- 6: an alias that is another client's own address --------------------
  const aliases = await settle(prisma.clientEmailAlias.findMany({ where: { active: true }, select: { id: true, clientId: true, email: true, createdAt: true } }), []);
  if (aliases.length) {
    const emails = [...new Set(aliases.map((a) => a.email.toLowerCase()))];
    const [owners, contacts] = await Promise.all([
      settle(
        prisma.client.findMany({
          where: { OR: [{ email: { in: emails, mode: "insensitive" } }, { backupEmail: { in: emails, mode: "insensitive" } }] },
          select: { id: true, name: true, email: true, backupEmail: true },
        }),
        [],
      ),
      settle(prisma.contact.findMany({ where: { email: { in: emails, mode: "insensitive" }, clientId: { not: null } }, select: { email: true, clientId: true } }), []),
    ]);
    const names = await namesFor([...aliases.map((a) => a.clientId), ...owners.map((o) => o.id), ...contacts.map((c) => c.clientId as string)]);
    for (const a of aliases) {
      const em = a.email.toLowerCase();
      const other =
        owners.find((o) => o.id !== a.clientId && (o.email?.toLowerCase() === em || o.backupEmail?.toLowerCase() === em)) ??
        null;
      const otherContact = other ? null : contacts.find((c) => c.clientId !== a.clientId && c.email?.toLowerCase() === em) ?? null;
      const otherId = other?.id ?? otherContact?.clientId ?? null;
      if (!otherId) continue;
      out.push({
        id: `alias:${a.id}`,
        kind: "alias-conflict",
        title: `${a.email}`,
        why: `A login alias of ${names.get(a.clientId) ?? "one client"} is ${names.get(otherId) ?? "another client"}'s own ${other ? "email" : "contact email"}`,
        evidence: [`Alias on ${names.get(a.clientId) ?? a.clientId}`, `${other ? "Client email" : "Contact"} on ${names.get(otherId) ?? otherId}`],
        owner: "Jordan",
        nextAction: "Decide whose address it is and remove the alias from the other — signing in with it reaches the wrong client's portal",
        href: `/clients/${a.clientId}`,
        since: a.createdAt,
      });
    }
  }

  return out.sort((x, y) => (y.since?.getTime() ?? 0) - (x.since?.getTime() ?? 0));
}

async function namesFor(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await prisma.client.findMany({ where: { id: { in: want } }, select: { id: true, name: true } }).catch(() => []);
  return new Map(rows.map((r) => [r.id, r.name]));
}
