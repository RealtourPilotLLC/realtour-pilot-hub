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

// ---------------------------------------------------------------------------
// WHICH VISIT AN /upload ROW IS ABOUT (Oct 30 2026, Laura Kaplan's split
// shoot). Project.shootDate moves to the NEXT visit the moment one starts
// (integrations/aryeo betterShoot), so Harrison's 3 PM drone visit sat under
// "Upcoming · Wed Nov 4" (James's visit) while he drove home to upload it.
// For a job with two or more live visits the row is filed under:
//   · a photographer's own latest visit that started inside the 7-day window,
//     else their own next visit;
//   · for the office (or a viewer with no visit of their own), the latest
//     visit that started inside the window.
// Null (file by shootDate, as before) when nothing applies, and always for an
// ordinary one-visit job.
// ---------------------------------------------------------------------------

/** The visit an upload-list row of a split job is about: its start, and its place among the job's live visits. */
export function listVisit(
  appointments: (Appt & { assignedToId?: string | null })[],
  now: Date,
  windowStart: Date,
  viewer: string | null,
): { at: Date; n: number; of: number } | null {
  const live = appointments.filter((a) => a.startAt && !/cancel/i.test(a.status ?? "")).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());
  if (live.length < 2) return null;
  const started = (a: Appt) => a.startAt!.getTime() <= now.getTime();
  const inWindow = (a: Appt) => started(a) && a.startAt!.getTime() >= windowStart.getTime();
  const own = viewer ? live.filter((a) => a.assignedToId === viewer) : [];
  const pool = own.length ? own : live;
  const pick = [...pool].reverse().find(inWindow) ?? (own.length ? own.find((a) => !started(a)) : undefined);
  return pick ? { at: pick.startAt!, n: live.indexOf(pick) + 1, of: live.length } : null;
}
