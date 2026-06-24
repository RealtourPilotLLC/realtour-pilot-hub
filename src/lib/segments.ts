// Customer segmentation — mirrors the HubSpot segment model Jordan runs in the
// marketing project, so the same label shows up everywhere a client name does.
//
// Two inputs per client:
//   • lifetime spend (dollars) across their non-cancelled orders
//   • transaction count = number of those orders
// Segment is a first-match cascade (same order/thresholds as the HubSpot sync).

import { PALETTE } from "@/lib/palette";

export type SegmentKey =
  | "never_converted"
  | "one_timer"
  | "casual_repeat"
  | "regular"
  | "heavy"
  | "vip";

// First match wins — identical to SEGMENT_FOR in the marketing project's
// sync-segments.js (txns gates never/one-timer; spend gates the rest).
export function computeSegment(spendDollars: number, txns: number): SegmentKey {
  if (txns <= 0) return "never_converted";
  if (txns === 1) return "one_timer";
  if (spendDollars < 1500) return "casual_repeat";
  if (spendDollars < 5000) return "regular";
  if (spendDollars < 20000) return "heavy";
  return "vip";
}

export type SegmentMeta = {
  key: SegmentKey;
  label: string; // full label
  short: string; // compact chip label
  color: string; // hex — drives the Badge tint
  blurb: string; // one-liner for tooltips / detail
};

export const SEGMENT_META: Record<SegmentKey, SegmentMeta> = {
  never_converted: {
    key: "never_converted",
    label: "Never Converted",
    short: "New",
    color: PALETTE.gray,
    blurb: "No completed orders yet — a lead or first booking in flight.",
  },
  one_timer: {
    key: "one_timer",
    label: "One-Timer",
    short: "One-Timer",
    color: PALETTE.blue,
    blurb: "One completed order. Win the second to start a habit.",
  },
  casual_repeat: {
    key: "casual_repeat",
    label: "Casual Repeat",
    short: "Casual",
    color: PALETTE.teal,
    blurb: "Repeat client, under $1.5k lifetime. Room to add video.",
  },
  regular: {
    key: "regular",
    label: "Regular",
    short: "Regular",
    color: PALETTE.indigo,
    blurb: "Steady repeat client, $1.5k–$5k lifetime.",
  },
  heavy: {
    key: "heavy",
    label: "Heavy",
    short: "Heavy",
    color: PALETTE.violet,
    blurb: "Top customer, $5k–$20k lifetime.",
  },
  vip: {
    key: "vip",
    label: "VIP",
    short: "VIP",
    color: PALETTE.gold,
    blurb: "Biggest accounts, $20k+ lifetime — handle personally.",
  },
};

export function segmentMeta(key?: string | null): SegmentMeta | null {
  if (!key) return null;
  return SEGMENT_META[key as SegmentKey] ?? null;
}

// Derive a segment straight from a client's orders (used at compute/persist time
// and as a fallback when the stored value is missing). `price` is in dollars.
export function segmentFromOrders(
  orders: { status: string; price: number | null }[],
): { key: SegmentKey; spendCents: number; txns: number } {
  const counted = orders.filter((o) => o.status !== "CANCELLED");
  const txns = counted.length;
  const spendDollars = counted.reduce((s, o) => s + (o.price ?? 0), 0);
  return {
    key: computeSegment(spendDollars, txns),
    spendCents: Math.round(spendDollars * 100),
    txns,
  };
}
