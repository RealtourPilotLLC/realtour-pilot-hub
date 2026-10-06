// ---------------------------------------------------------------------------
// HOME'S "WHAT NEEDS YOU NOW" — WHAT SHOWS AND WHAT FOLDS (Oct 5 2026).
//
// One clear first action (the lead), the next few under it, everything else
// folded into "N more". The first version folded by position alone, so an
// amber (warning) queue sitting fifth in line — videos ready to send, gaps on
// tomorrow's shoots — went into the fold with nothing on the fold to say so;
// only red rows were counted on its badge (review, Oct 5 night). Now:
//   · a red or amber row is NEVER folded, however far down it sits;
//   · calm rows (brand, muted) fill whatever room the urgent ones leave under
//     the lead, up to `shown` rows, in order;
//   · the fold holds only calm rows, and its count is exactly what it holds.
// Pure, so the rule is tested as one (scripts/_drill/oct5-ssfix.ts).
// ---------------------------------------------------------------------------

export type NeedTone = "brand" | "danger" | "warning" | "muted";

export const URGENT_TONES: readonly NeedTone[] = ["danger", "warning"];

export function foldNeeds<T extends { tone: NeedTone }>(needs: readonly T[], shown = 3): { lead: T | null; next: T[]; later: T[] } {
  const [lead, ...rest] = needs;
  const next: T[] = [];
  const later: T[] = [];
  let calmRoom = Math.max(0, shown - rest.filter((n) => URGENT_TONES.includes(n.tone)).length);
  for (const n of rest) {
    if (URGENT_TONES.includes(n.tone)) next.push(n);
    else if (calmRoom > 0) {
      next.push(n);
      calmRoom--;
    } else later.push(n);
  }
  return { lead: lead ?? null, next, later };
}
