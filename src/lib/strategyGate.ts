import "server-only";
import { prisma } from "@/lib/prisma";
import { DISCOVERY_DONE_STATES } from "@/lib/productPrerequisites";

// ---------------------------------------------------------------------------
// THE STRATEGY GATE (Oct 21 2026). Jordan, after Kristen Pavillard signed up
// and the hub lined up "book your strategy call" and "book your filming
// session" emails before her brand discovery call: "Strategy calls shouldn't
// be bookable until we have a content strategy built and added to the
// platform for the client." And: she "needs to have a discovery call first".
//
// The program's order is discovery call → strategy built → strategy shared in
// the portal → strategy call → scripts → filming. So ONE fact opens both the
// strategy call and the filming session: an approved strategy that has been
// released to the client's portal. Until then nothing (portal, email, text,
// reminder, Kyle's desk) asks the client to book either one; the portal shows
// the discovery call and what comes next instead.
//
// Self-planned clients ("we show up and shoot", clientSuppliesTopics: Mike
// Ciunci) have no strategy by design: the gate never closes for them.
// Every other live client had a released strategy on Oct 21, so the gate only
// changes anything for a new signup.
// ---------------------------------------------------------------------------

export type DiscoveryState = "needed" | "booked" | "held" | "waived";

export type StrategyGate = {
  /** True once an approved strategy is in the client's portal (or the client plans their own). */
  open: boolean;
  /** Why it is closed, in words a client or the office can read; null when open. */
  reason: string | null;
  discovery: DiscoveryState;
  /** The booked brand discovery call's start, when there is one. */
  discoveryAt: Date | null;
  discoveryMeetLink: string | null;
  selfPlanned: boolean;
  hasStrategy: boolean;
};

type GateInput = {
  selfPlanned: boolean;
  hasStrategy: boolean;
  onboarding: { status: string; discoveryRequired: boolean; discoveryWaivedAt: Date | null } | null;
  discoveryCall: { scheduledStart: Date | null; status: string; meetLink: string | null } | null;
};

/** Pure: the gate from the facts (drills call this directly). */
export function strategyGateFrom(i: GateInput): StrategyGate {
  const ob = i.onboarding;
  const waived = !!ob && (ob.discoveryRequired === false || !!ob.discoveryWaivedAt || ob.status === "WAIVED");
  const callLive = !!i.discoveryCall && !/cancel/i.test(i.discoveryCall.status);
  const discovery: DiscoveryState = waived
    ? "waived"
    : ob && DISCOVERY_DONE_STATES.has(ob.status)
      ? "held"
      : (ob?.status === "DISCOVERY_BOOKED" && callLive) || callLive
        ? "booked"
        : "needed";
  const discoveryAt = callLive ? i.discoveryCall?.scheduledStart ?? null : null;
  const open = i.selfPlanned || i.hasStrategy;
  const reason = open
    ? null
    : discovery === "needed"
      ? "Your brand discovery call comes first. Once it's done we build your content strategy, then you book your strategy call and filming."
      : discovery === "booked"
        ? "Your brand discovery call comes first. After it we build your content strategy, then you book your strategy call and filming."
        : "We're building your content strategy. Once it's in your portal you can book your strategy call and filming.";
  return { open, reason, discovery, discoveryAt, discoveryMeetLink: callLive ? i.discoveryCall?.meetLink ?? null : null, selfPlanned: i.selfPlanned, hasStrategy: i.hasStrategy };
}

/** The gate for many enrollments in four queries. A missing enrollment reads as open (nothing to gate). */
export async function strategyGatesFor(enrollmentIds: string[]): Promise<Map<string, StrategyGate>> {
  const ids = [...new Set(enrollmentIds.filter(Boolean))];
  const out = new Map<string, StrategyGate>();
  if (!ids.length) return out;
  const [enrollments, released, onboardings] = await Promise.all([
    prisma.contentEnrollment.findMany({ where: { id: { in: ids } }, select: { id: true, clientSuppliesTopics: true } }),
    prisma.contentStrategyVersion.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: ids }, releasedAt: { not: null }, status: { in: ["APPROVED", "SUPERSEDED"] } }, _count: true }),
    prisma.programOnboarding.findMany({ where: { enrollmentId: { in: ids } }, select: { enrollmentId: true, status: true, discoveryRequired: true, discoveryWaivedAt: true, discoveryCallRecordId: true } }),
  ]);
  const callIds = onboardings.map((o) => o.discoveryCallRecordId).filter((x): x is string => !!x);
  const calls = callIds.length ? await prisma.programCallRecord.findMany({ where: { id: { in: callIds } }, select: { id: true, scheduledStart: true, status: true, meetLink: true } }) : [];
  const callById = new Map(calls.map((c) => [c.id, c]));
  const hasStrategy = new Set(released.map((r) => r.enrollmentId));
  const obBy = new Map(onboardings.map((o) => [o.enrollmentId, o]));
  for (const e of enrollments) {
    const ob = obBy.get(e.id) ?? null;
    out.set(e.id, strategyGateFrom({
      selfPlanned: e.clientSuppliesTopics,
      hasStrategy: hasStrategy.has(e.id),
      onboarding: ob,
      discoveryCall: ob?.discoveryCallRecordId ? callById.get(ob.discoveryCallRecordId) ?? null : null,
    }));
  }
  return out;
}

export async function strategyGateFor(enrollmentId: string): Promise<StrategyGate | null> {
  return (await strategyGatesFor([enrollmentId])).get(enrollmentId) ?? null;
}

/** The refusal a server action returns when a closed gate is pressed anyway. */
export const STRATEGY_GATE_REFUSAL = "Strategy calls and filming open once your content strategy is in your portal.";
