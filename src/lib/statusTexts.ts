// Photographer status-update texts to the client, sent from the guided /shoot
// flow via OpenPhone. Written in Jordan's voice (no em dashes, no emojis, warm +
// low-pressure), copy-paste ready. The photographer reviews + edits before
// sending — these are the smart defaults, never auto-sent.

export type ShootStatusKind = "on_my_way" | "arrived" | "complete";

type StatusCtx = {
  clientName?: string | null;
  propertyTitle?: string | null; // full title; we use the street part
  photographerName?: string | null;
};

function firstNameOf(name?: string | null, fallback = "there"): string {
  return (name || fallback).trim().split(/\s+/)[0] || fallback;
}
function streetOf(title?: string | null): string {
  return (title || "your listing").split(",")[0].trim();
}

export const SHOOT_STATUS_META: Record<
  ShootStatusKind,
  { label: string; sent: string }
> = {
  on_my_way: { label: "On my way", sent: "Sent “on my way” to the client" },
  arrived: { label: "Arrived", sent: "Let the client know you’ve arrived" },
  complete: { label: "Shoot complete", sent: "Told the client the shoot is wrapped" },
};

// The default status text for a given moment of the shoot.
export function shootStatusText(kind: ShootStatusKind, ctx: StatusCtx): string {
  const first = firstNameOf(ctx.clientName);
  const street = streetOf(ctx.propertyTitle);
  const me = (ctx.photographerName || "").trim().split(/\s+/)[0];
  const intro = me ? `This is ${me} with RealTour Pilot` : "This is RealTour Pilot";

  switch (kind) {
    case "on_my_way":
      return `Hi ${first}! ${intro}. I am on my way to ${street} now and should be there shortly. See you soon!`;
    case "arrived":
      return `Hi ${first}! ${intro}. I have arrived at ${street} and I am getting set up. Let me know if there is anything specific you want me to capture.`;
    case "complete":
      return `Hi ${first}! All wrapped up at ${street} and everything looked great. Your content is heading to our editing team now and we will have it back to you soon. Thank you!`;
  }
}
