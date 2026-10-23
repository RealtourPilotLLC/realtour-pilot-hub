import { etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// WHICH VISIT A SUBMISSION BELONGS TO (Oct 23 2026, 615 Cliff Ln). A split job
// is one Project with several appointments and ONE set of upload-page stamps
// (debriefSubmittedAt, photosHandoffAt, videoHandoffAt, uploadedAt). Harrison
// shot the third visit at 12:45 PM and the page read "Submitted ✓ Oct 8" (the
// first visit's wrap-up) and stayed locked, so today's photos had nowhere to
// go. intake.ts already had the rule ("a wrap-up submitted for an earlier visit
// says nothing about this upload"); this is that rule for the upload page, the
// /upload list, the submit and the photographer nudges.
//
// The rule: once a job has MORE THAN ONE live appointment that has started, a
// stamp counts only if it was made on or after the ET day the latest started
// visit began. One visit (every ordinary job): every stamp counts, unchanged.
// Pure (no database), so pages, actions and drills share it.
// ---------------------------------------------------------------------------

type Appt = { startAt: Date | null; status: string | null };

/** The ET day start of the latest started live visit, when the job has two or more started visits; else null (no floor). */
export function currentVisitFloor(appointments: Appt[], now: Date): Date | null {
  const started = appointments.filter((a) => a.startAt && a.startAt.getTime() <= now.getTime() && !/cancel/i.test(a.status ?? "")).map((a) => a.startAt!.getTime());
  if (started.length < 2) return null;
  return etDayStartUtc(new Date(Math.max(...started)));
}

/** A stamp as the CURRENT visit sees it: kept when there is no floor or it is on/after the floor, else null (an earlier visit's). */
export function forCurrentVisit(at: Date | null | undefined, floor: Date | null): Date | null {
  if (!at) return null;
  return !floor || at.getTime() >= floor.getTime() ? at : null;
}

/** The upload-page stamps of a job, each read for its current visit. */
export function currentVisitStamps<T extends { debriefSubmittedAt: Date | null; photosHandoffAt: Date | null; videoHandoffAt: Date | null; uploadedAt?: Date | null }>(
  p: T,
  appointments: Appt[],
  now: Date,
): T & { visitFloor: Date | null; earlierVisitSubmittedAt: Date | null } {
  const floor = currentVisitFloor(appointments, now);
  if (!floor) return { ...p, visitFloor: null, earlierVisitSubmittedAt: null };
  return {
    ...p,
    debriefSubmittedAt: forCurrentVisit(p.debriefSubmittedAt, floor),
    photosHandoffAt: forCurrentVisit(p.photosHandoffAt, floor),
    videoHandoffAt: forCurrentVisit(p.videoHandoffAt, floor),
    ...(p.uploadedAt !== undefined ? { uploadedAt: forCurrentVisit(p.uploadedAt, floor) } : {}),
    visitFloor: floor,
    earlierVisitSubmittedAt: p.debriefSubmittedAt && p.debriefSubmittedAt.getTime() < floor.getTime() ? p.debriefSubmittedAt : null,
  };
}
