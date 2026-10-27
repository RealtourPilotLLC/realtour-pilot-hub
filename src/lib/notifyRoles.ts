// ---------------------------------------------------------------------------
// WHO GETS WHICH PING, BY ROLE (Oct 27 2026). The central routing table for
// notifications to the three office seats. Jordan: "audit the notifications -
// make sure we are not overloading Kyle, James, and me with notifications that
// are not needed or that do not apply to our roles and responsibilities. Kyle
// handles comms, delegation, review, delivery, and coordination. James is the
// creative manager. I am CEO."
//
// Measured first (Oct 13 to 27, the delivery log): Jordan's bell and Slack
// carried 61 to 67 copies each of every cut waiting on review, every batch of
// AI topic suggestions and every photo job handed to AutoHDR, plus every
// verdict, revision, edit start and photo check, and his phone took a text for
// every cut (61). James took a text for every cut (65) and every approval (33),
// his own included. Kyle's cut and verdict copies were already cut on Oct 22.
//
// THE SEATS. A seat is a job, not a person: owner = the OWNER login(s)
// (Jordan); office = the ADMIN logins that are not shooters or editors
// (smsPrefs.officeTeamMemberIds: Kyle); creative = the CREATIVE_MANAGER
// login(s) (James). A role broadcast maps OWNER, ADMIN and CREATIVE_MANAGER to
// those seats; a row addressed by name (tm:<id>) maps through the same lookups.
// Editors and photographers are not seats here: their pings are untouched.
//
// THE ROUTES, per kind and seat. A kind or seat not listed is "ping" (as before).
//   ping   — the bell row, and Slack or text by the person's own switches on
//            Settings → Team notifications (and Jordan's everything-on-Slack).
//   bell   — the bell row only: no Slack DM, no text, no Slack mirror.
//   theirs — only when it is theirs: a row addressed to them by name stays;
//            their copy of a broadcast goes when someone in one of these
//            seats is named in the same event (an FYI beside the person who
//            acts: James reviewing a cut). A broadcast beside no named seat
//            (nobody, or only an editor or a photographer) stays, so a kind
//            never goes dark because nobody was named.
//   drop   — no row for that seat at all.
// Jordan's seat only ever uses ping, theirs or drop: everything still in his
// bell keeps reaching his Slack (Oct 22 2026: "please make sure I get all
// notifications via slack").
//
// NEVER ABOUT YOUR OWN PRESS. notifyInApp's `actorTeamMemberId` drops the row
// addressed to the person who caused the event and skips their channel legs on
// a broadcast (review verdicts pass it; review/actions.ts rulerOf resolves the
// presser through the roster when the login has no link).
//
// TIMING AND MONEY ARE UNCHANGED. Anyone can be pinged any hour, except Jordan
// on Saturday until 7:30 PM (notifyPrefDefaults OWNER_PRESET_WINDOWS,
// notifySchedule.holdFor); the money clamp in notifyInApp still runs on every
// row this lets through.
//
// THE DECISION TABLE (Oct 27 2026). Before → after; "bell+Slack" for Jordan is
// his bell and its Slack mirror. Volumes are the 14 days before.
//
//  kind                     Jordan (CEO)                      Kyle (office)                  James (creative)
//  cut_ready                bell+Slack+text 61-65 → only when  FYI gone Oct 22; kept when     bell+text every cut 65 → bell every
//                           HE is the cut's reviewer           he IS the reviewer (covering)  cut; a text only for the first cut
//                                                                                             of a pile (reviewerAssignment)
//  review_approved          bell 11 → drop                     (already only ready-to-send)   bell+text 33 → bell; none for his own
//  review_changes           bell+Slack 10 → drop               relay row kept (his work)      bell+text 13 → bell; none for his own
//  review_withdrawn         bell+Slack 2 → drop                broadcast → drop               bell (kept)
//  revision_raised/addendum bell+Slack 10 → drop               kept (client revisions)        kept by name (Oct 26)
//  revision_resolved        bell+Slack 10 → drop               kept (re-deliver)              broadcast → drop (the new cut rings)
//  edit_started             bell+Slack 5 → drop                kept, bell (delegation: the    —
//                                                              editor took what he dispatched)
//  creative_review          bell+Slack 6 → theirs              —                              kept (his review)
//  new_lead                 bell+Slack 5 → drop; the 6 PM      kept (he answers leads)        —
//                           wrap lists the day's new leads
//  topic_suggestions_ready  bell+Slack 67 → drop; the 6 PM     —                              —
//                           wrap lists today's, one line
//  photo_free_check         bell 29 → drop                     kept, one per job per state    —
//  photo_autohdr_sent       bell+Slack 29 → drop               already none (Oct 23)          —
//  photo_after_delivery, photo_fixes_done, photo_listing_corrupt, photo_delivered_with_holds,
//  photo_delivery_waiting, photo_delivery_duplicate, photo_autohdr_failed,
//  photo_autohdr_stray_folder, photo_autohdr_older_raws
//                           bell+Slack → drop (Kyle's lane)    kept                           —
//  portal_script_approved   kept (his scripts)                 broadcast → drop               kept
//  script_edited            kept (his scripts)                 broadcast → drop               kept
//  portal_topic(_declined), portal_planning
//                           kept (strategy he owns)            broadcast → drop               kept
//  portal_comment, portal_approval, portal_asset, portal_profile
//                           bell+Slack → drop                  broadcast → drop               kept (his creative work, brand)
//  KEPT FOR JORDAN: error_report, system, behind_alert, photos_undelivered, review_escalation,
//    reply_sla / reply_sla_email (the pager's escalation), client_feedback, new_client,
//    order_canceled, shoot_add_on, task_assigned / task_expiring / delegation (his asks),
//    mention / note_reply, program_message (+ its text, Oct 20), scripts_before_shoot,
//    autohdr_credits_*, photo_autohdr_billing, photo_autohdr_slow, photo_weekly_digest,
//    evening_push.
//  KEPT FOR KYLE: comms (reply_sla, reply_sla_email, lead_waiting, email_followup,
//    program_message, project_message), delivery (topaz_ready, promise_watch, the photo
//    bells by his Oct 23 rule), revisions, delegation (task_assigned, desk_task), his digests.
//  KEPT FOR JAMES: appointment_change, raws_missing, instructions_missing, shoot_brief,
//    photographer_brief, shoot_day_text (his own shoots and the field), revisions by
//    name, creative_review, mentions and job messages.
//
// Pure on purpose (no imports): notify.ts, photoDelivery/notifyOps.ts and the
// drill (scripts/_drill/oct27-notification-roles.ts) all read this one table.
// ---------------------------------------------------------------------------

export type NotifySeat = "owner" | "office" | "creative";
export type SeatRoute = "ping" | "bell" | "theirs" | "drop";

const PHOTO_PIPELINE_FOR_KYLE = [
  "photo_free_check",
  "photo_autohdr_sent",
  "photo_after_delivery",
  "photo_fixes_done",
  "photo_listing_corrupt",
  "photo_delivered_with_holds",
  "photo_delivery_waiting",
  "photo_delivery_duplicate",
  "photo_autohdr_failed",
  "photo_autohdr_stray_folder",
  "photo_autohdr_older_raws",
] as const;

export const ROLE_ROUTES: Readonly<Record<string, Readonly<Partial<Record<NotifySeat, SeatRoute>>>>> = {
  // ---- video review: James reviews, Kyle delivers, Jordan only when it is his
  cut_ready: { owner: "theirs", office: "theirs" },
  review_submitted: { owner: "theirs", office: "theirs" },
  review_approved: { owner: "drop", creative: "bell" },
  review_changes: { owner: "drop", creative: "bell" },
  review_withdrawn: { owner: "drop", office: "drop" },
  creative_review: { owner: "theirs" },
  // ---- editing and revisions: Kyle (client revisions) and James by name
  revision_raised: { owner: "drop" },
  revision_addendum: { owner: "drop" },
  revision_resolved: { owner: "drop", creative: "drop" },
  edit_started: { owner: "drop" },
  // ---- to the 6 PM wrap instead (eveningPush.composeEveningWrap)
  new_lead: { owner: "drop" },
  topic_suggestions_ready: { owner: "drop" },
  // ---- content-program portal events: Jordan and James, not Kyle
  portal_script_approved: { office: "drop" },
  script_edited: { office: "drop" },
  portal_topic: { office: "drop" },
  portal_topic_declined: { office: "drop" },
  portal_planning: { office: "drop" },
  portal_comment: { owner: "drop", office: "drop" },
  portal_approval: { owner: "drop", office: "drop" },
  portal_asset: { owner: "drop", office: "drop" },
  portal_profile: { owner: "drop", office: "drop" },
  // ---- the photo pipeline is Kyle's lane (his own bells: notifyOps KYLE_SKIPS / KYLE_BUCKET)
  ...Object.fromEntries(PHOTO_PIPELINE_FOR_KYLE.map((k) => [k, { owner: "drop" as const }])),
};

/** The route for one kind and seat ("ping" when the table says nothing). */
export function seatRoute(kind: string, seat: NotifySeat): SeatRoute {
  return ROLE_ROUTES[kind]?.[seat] ?? "ping";
}

/** The seat a broadcast role stands for, or null (editors, photographers…). */
export function seatOfRole(role: string): NotifySeat | null {
  return role === "OWNER" ? "owner" : role === "ADMIN" ? "office" : role === "CREATIVE_MANAGER" ? "creative" : null;
}

/** Roster ids per seat, as notify.ts loads them. */
export type SeatBook = { owners: ReadonlySet<string>; creatives: ReadonlySet<string>; office: ReadonlySet<string> };

/** The seat a roster row sits in (owner first, then creative, then office), or null. */
export function seatOfMember(teamMemberId: string, book: SeatBook): NotifySeat | null {
  if (book.owners.has(teamMemberId)) return "owner";
  if (book.creatives.has(teamMemberId)) return "creative";
  if (book.office.has(teamMemberId)) return "office";
  return null;
}

/** Is someone in a seat named (tm:<id>) among this event's targets? What
 *  "theirs" reads (pure). */
export function namedSeatInCall(targets: readonly { userKey?: string | null }[], seatOf: (teamMemberId: string) => NotifySeat | null): boolean {
  return targets.some((t) => !!t.userKey?.startsWith("tm:") && seatOf(t.userKey.slice(3)) !== null);
}

/** How a kept row may go out: "channels" = the bell only; "text" = no text
 *  (Slack still by the person's switch). */
export type RowMute = "channels" | "text";

export type RoutedTarget =
  | { keep: false; why: "echo" | "route" }
  | { keep: true; roles: string[]; mute?: RowMute; mutedSeats: NotifySeat[] };

/**
 * One target of one event through the table (pure). `namedInCall`: is a seat
 * named in the same event (namedSeatInCall)? `actor`:
 * the roster row of whoever caused the event. A named row for a seat is
 * dropped, muted or kept; a broadcast loses the roles whose seat is dropped
 * (or "theirs" beside a named row) and lists the seats it must not bridge to.
 */
export function routeTarget(
  kind: string,
  t: { roles: readonly string[]; userKey?: string | null; mute?: RowMute },
  ctx: { seatOf: (teamMemberId: string) => NotifySeat | null; namedInCall: boolean; actor?: string | null },
): RoutedTarget {
  const tmId = t.userKey?.startsWith("tm:") ? t.userKey.slice(3) : null;
  if (tmId && ctx.actor && tmId === ctx.actor) return { keep: false, why: "echo" };
  const routes = ROLE_ROUTES[kind];
  if (t.userKey) {
    if (!tmId || !routes) return { keep: true, roles: [...t.roles], mute: t.mute, mutedSeats: [] };
    const seat = ctx.seatOf(tmId);
    const route = seat ? seatRoute(kind, seat) : "ping";
    if (route === "drop") return { keep: false, why: "route" };
    if (route === "bell") return { keep: true, roles: [...t.roles], mute: "channels", mutedSeats: seat ? [seat] : [] };
    return { keep: true, roles: [...t.roles], mute: t.mute, mutedSeats: [] };
  }
  if (!routes) return { keep: true, roles: [...t.roles], mute: t.mute, mutedSeats: [] };
  const roles: string[] = [];
  const mutedSeats: NotifySeat[] = [];
  for (const role of t.roles) {
    const seat = seatOfRole(role);
    const route = seat ? seatRoute(kind, seat) : "ping";
    if (route === "drop") continue;
    if (route === "theirs" && ctx.namedInCall) continue;
    if (route === "bell" && seat) mutedSeats.push(seat);
    roles.push(role);
  }
  if (roles.length === 0) return { keep: false, why: "route" };
  return { keep: true, roles, mute: t.mute, mutedSeats };
}
