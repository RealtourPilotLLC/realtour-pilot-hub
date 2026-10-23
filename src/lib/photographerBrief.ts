// ---------------------------------------------------------------------------
// THE PHOTOGRAPHER'S DAILY BRIEF: A STUB (Oct 23 2026).
//
// Another build owns the brief and its acknowledgment (send at a set time
// before the first shoot, renewed acknowledgment after a material change).
// Kyle's dashboard (lib/officeDesk, Shoot Prep) only READS where each
// appointment's brief stands, through this one function. Until that build
// merges, every appointment reads "off" (not set up), and its real file
// replaces this one at merge with the same exports.
// ---------------------------------------------------------------------------

export type BriefState = "off" | "pending" | "sent" | "failed" | "acknowledged" | "changed";

export async function briefStatusForAppointments(
  appointmentIds: string[],
): Promise<Map<string, { state: BriefState; sentAt: string | null; ackAt: string | null; why: string | null }>> {
  return new Map(appointmentIds.map((id) => [id, { state: "off" as const, sentAt: null, ackAt: null, why: null }]));
}
