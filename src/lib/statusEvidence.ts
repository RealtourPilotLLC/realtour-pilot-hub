// Shared (client-safe) helpers for reading the smart-status evidence blob that
// the status engine writes to Project.statusEvidence. Keep this free of any
// server-only imports so cards/components can use it directly.

export type ParsedEvidence = {
  expected: string[];
  present: string[];
  missing: string[];
  partial: boolean;
  aryeo: {
    photos: number;
    videos: number;
    floorPlans: number;
    interactive: number;
    delivery: string | null;
  } | null;
  dropbox: {
    rawPhotos: number;
    rawVideo: number;
    finalPhotos: number;
    finalVideo: number;
  } | null;
  fulfilledOnAryeo: boolean;
  reason: string;
  checkedAt: string;
};

export function parseEvidence(raw: string | null | undefined): ParsedEvidence | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<ParsedEvidence>;
    return {
      expected: e.expected ?? [],
      present: e.present ?? [],
      missing: e.missing ?? [],
      partial: e.partial ?? false,
      aryeo: e.aryeo ?? null,
      dropbox: e.dropbox ?? null,
      fulfilledOnAryeo: e.fulfilledOnAryeo ?? false,
      reason: e.reason ?? "",
      checkedAt: e.checkedAt ?? "",
    };
  } catch {
    return null;
  }
}

// A short, human flag for a card: what (if anything) is wrong/notable.
export type StatusFlag = { kind: "missing" | "ready" | "stalled" | "revision"; label: string };

export function statusFlag(
  status: string,
  raw: string | null | undefined,
): StatusFlag | null {
  // A revision request is the loudest signal — show it regardless of media.
  if (status === "REVISION") return { kind: "revision", label: "Revision requested" };
  const e = parseEvidence(raw);
  if (!e) return null;
  // A "missing" flag only signals real work when the job is far enough along
  // that the media *should* be there. Booked/Scheduled jobs haven't been shot
  // yet — "missing photos" there is just noise. So flag only when the order
  // looked delivered on Aryeo (partial) or it's in Review/Delivered.
  const meaningful = e.partial || status === "REVIEW" || status === "DELIVERED";
  if (e.missing.length > 0 && meaningful) {
    return {
      kind: "missing",
      label: e.partial ? `Aryeo "done" · missing ${e.missing.join(", ")}` : `Missing ${e.missing.join(", ")}`,
    };
  }
  if (status === "REVIEW" && e.missing.length === 0 && e.present.length > 0 && !e.fulfilledOnAryeo) {
    return { kind: "ready", label: "Ready to deliver" };
  }
  return null;
}
