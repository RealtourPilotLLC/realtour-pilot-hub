import "server-only";
import { prisma } from "@/lib/prisma";
import { buildEditorQueue, STATUS_LABEL } from "@/lib/editorQueue";
import { editorMeta, TEAM_MEMBER_EDITOR_KEYS } from "@/lib/editors";
import { appBase } from "@/lib/appUrl";
import { etDayKey, etMinutesOfDay, etMonthDay } from "@/lib/datetime";
import { firstName } from "@/lib/reviewAttribution";
import { isSyntheticClientRow } from "@/lib/testClients";
import { escapeSlack } from "@/lib/text";
import { videoNavigationFor } from "@/lib/videoNavigation";
import { dayWords, HOUR_MS, waitedDays, type RevisionAsk } from "@/lib/openRevisions";

// ---------------------------------------------------------------------------
// A REVISION STILL WAITING ON ITS EDITOR, ONCE A DAY (Jordan, Oct 6 2026:
// "Can we also have notifications sent to the editors for projects that have
// been in revision for over 24 hours? Like for example - Kim has had a
// revision open for a week or more now for Bernadette Rabel.").
//
// WHAT IS OPEN is the Editing Room's own answer, never a second definition:
// the rows buildEditorQueue says "Revisions" on (so DELIVERED, CANCELLED and
// ON_HOLD jobs, jobs taken off the Editing Room and TEST clients are already
// out), and on each the asks lib/openRevisions dates — a cut whose newest
// round came back with changes (James, Kyle or Jordan in the Review Room, or
// the client on the portal), a round still open on the edit card, or a
// revision card on a job the Review Room has never seen. A v2 handed in ends
// it: the newest round then speaks for that video.
//
// WHO HEARS IT, per video:
//   · the video's own owner (DeliverableOutput.ownerKey) when it names one of
//     our editors or the agency, else the row's editor — the same ladder the
//     queue row shows;
//   · Kim or John Mark: their bell row, and their Slack / text on their own
//     "Job pings" switch, through the existing staff bridge (notifyInApp) —
//     held only by a quiet time saved on their card;
//   · Luma Visuals' job: Kyle, to relay it (they have no login);
//   · nobody (or a departed editor): Kyle, to pick an editor.
// WHEN: the first time at 24 hours, then once in every further 24 hours,
// counted from when the changes were asked for. The bell row's unique
// dedupeKey is the ledger — one per person, per ask, per 24-hour window — so
// an hourly re-run, a second cron racing this one, or a redeploy sends
// nothing twice, and a failed Slack leg is retried by the bridge's own
// re-announce rule (notify.ts) rather than duplicated.
// AND KYLE, after 3 days: one combined line a day listing the revisions
// stuck with an editor (KYLE_DAILY_STUCK_LIST — one line turns it off). The
// agency and unassigned ones are not on it: those already reach him by name
// every day.
//
// Never a client message: staff bells and staff Slack/texts only.
// ---------------------------------------------------------------------------

/** First reminder once the changes have waited this long. */
export const REMIND_AFTER_HOURS = 24;
/** …then one more in every window of this length. */
export const REMIND_EVERY_HOURS = 24;
/** Kyle's once-a-day list of revisions stuck with an editor. `false` turns it off. */
export const KYLE_DAILY_STUCK_LIST = true;
/** How long an ask waits before it is on Kyle's list. */
export const KYLE_STUCK_AFTER_DAYS = 3;
/** Kyle's list goes on the first hourly run at or after this hour, ET. */
export const KYLE_STUCK_LIST_FROM_HOUR_ET = 9;
/** Kyle's list names this many jobs, then "and N more". */
const STUCK_LIST_MAX = 10;
/** The Editing Room filtered to "Changes requested" (lib/editingQueueStage). */
const CHANGES_STAGE_HREF = "/editing?stage=changes";

export type RevisionLane = "editor" | "agency" | "unassigned";

export type OpenRevision = RevisionAsk & {
  projectId: string;
  street: string;
  client: string;
  /** The edit page's own "Video N" (videoNavigation), when the ask names a video. */
  video: number | null;
  /** Whose move: an in-house editor's key, the agency's, or null. */
  editorKey: string | null;
  editorName: string | null;
  lane: RevisionLane;
  ageHours: number;
  days: number;
  /** The editor's page for this video (?output= when the video is known). */
  href: string;
};

/** Where an editor key sends the reminder. Pure. */
export function laneFor(key: string | null | undefined): RevisionLane {
  const meta = editorMeta(key);
  if (!key || !meta || meta.departed) return "unassigned";
  if (meta.kind === "external" && (key === "external_agency" || key === "luma")) return "agency";
  return (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(key) ? "editor" : "unassigned";
}

/** "Video 1: James's changes from Sep 25" — who asked and when, in plain words. Pure. */
export function askWords(r: Pick<OpenRevision, "video" | "source" | "by" | "sinceISO">): string {
  const day = etMonthDay(r.sinceISO);
  const who = r.source === "client" ? "the client" : firstName(r.by);
  const what = who ? `${who}'s changes from ${day}` : `changes asked for on ${day}`;
  return `${r.video ? `Video ${r.video}: ` : ""}${what}`;
}

/**
 * Every open revision ask on the Editing Room, dated and addressed. Read-only:
 * the queue's own rows, plus the per-video owner and number for each ask.
 */
export async function openRevisions(opts: { now?: Date } = {}): Promise<OpenRevision[]> {
  const now = opts.now ?? new Date();
  // TEST clients are off the office's board, so they are off this too.
  const excludeClientIds = (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const { notDone } = await buildEditorQueue({ excludeClientIds });
  const rows = notDone.filter((r) => r.status === STATUS_LABEL.REVISION && r.revisionAsks?.length);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [outputs, nav] = await Promise.all([
    prisma.deliverableOutput.findMany({ where: { projectId: { in: ids } }, select: { id: true, projectId: true, deliverableId: true, slot: true, ownerKey: true } }),
    Promise.all(ids.map(async (id) => [id, await videoNavigationFor(id)] as const)).then((xs) => new Map(xs)),
  ]);
  const byId = new Map(outputs.map((o) => [o.id, o]));
  const bySlot = new Map(outputs.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
  const out: OpenRevision[] = [];
  for (const row of rows) {
    for (const a of row.revisionAsks ?? []) {
      const o = (a.outputId ? byId.get(a.outputId) : undefined) ?? (a.deliverableId ? bySlot.get(`${a.deliverableId}:${a.slot ?? 1}`) : undefined);
      // The video's own owner speaks for it when it names someone who can
      // take it (an editor, or the agency); otherwise the row's editor.
      const owner = o?.ownerKey && laneFor(o.ownerKey) !== "unassigned" ? o.ownerKey : null;
      const editorKey = owner ?? row.editorKey ?? null;
      const lane = laneFor(editorKey);
      const ageHours = (now.getTime() - Date.parse(a.sinceISO)) / HOUR_MS;
      out.push({
        ...a,
        projectId: row.id,
        street: row.street,
        client: row.client,
        video: o ? nav.get(row.id)?.get(`${o.deliverableId}:${o.slot}`)?.number ?? null : null,
        editorKey: lane === "unassigned" ? null : editorKey,
        editorName: lane === "unassigned" ? null : editorMeta(editorKey)?.name ?? row.editor ?? null,
        lane,
        ageHours,
        days: waitedDays(a.sinceISO, now),
        href: `/edit/${row.id}${o ? `?output=${o.id}` : ""}`,
      });
    }
  }
  return out.sort((x, y) => x.sinceISO.localeCompare(y.sinceISO));
}

export type RevisionReminderRun = {
  open: number;
  due: number;
  /** new reminders written this run / already sent in this window */
  editor: { sent: number; already: number };
  kyle: { sent: number; already: number };
  /** Kyle's 3-day list: sent | already | none | off | before 9 AM ET */
  stuck: string;
  failed: string[];
};

/** The hourly step (cron/sync "revisionReminders"). Never messages a client. */
export async function sweepRevisionReminders(opts: { now?: Date } = {}): Promise<RevisionReminderRun> {
  const now = opts.now ?? new Date();
  const open = await openRevisions({ now });
  const due = open.filter((r) => r.ageHours >= REMIND_AFTER_HOURS);
  const run: RevisionReminderRun = { open: open.length, due: due.length, editor: { sent: 0, already: 0 }, kyle: { sent: 0, already: 0 }, stuck: "none", failed: [] };
  const { notifyInApp } = await import("@/lib/notify");
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const base = appBase();

  for (const r of due) {
    // Which 24-hour window this run is in: 1 from 24 h, 2 from 48 h, …
    const n = 1 + Math.floor((r.ageHours - REMIND_AFTER_HOURS) / REMIND_EVERY_HOURS);
    const head = `Revision waiting ${dayWords(r.days)} — ${r.street}`;
    const where = `${r.street} (${r.client}), ${askWords(r)}`;
    try {
      if (r.lane === "editor" && r.editorKey) {
        const res = await notifyInApp({
          kind: "revision_waiting",
          title: head,
          href: r.href,
          targets: [{
            roles: ["EDITOR"],
            userKey: `editor:${r.editorKey}`,
            href: r.href,
            // The words escaped for Slack (a street with "&" in it), the link not.
            slackDm: `${escapeSlack(`Revision waiting ${dayWords(r.days)} — ${where}.`)} Upload the next version: ${base}${r.href}`,
          }],
          dedupeKey: `revision-waiting:${r.projectId}:${r.editorKey}:${r.askId}:${n}`,
        });
        if (res.bridged.length) run.editor.sent++;
        else run.editor.already++;
      } else {
        const agency = r.lane === "agency";
        const who = agency ? editorMeta("external_agency")?.name ?? "the agency" : null;
        const href = agency ? r.href : CHANGES_STAGE_HREF;
        const res = await noticeForKyle({
          kind: "revision_waiting_office",
          title: `${head} (${agency ? `relay to ${who}` : "needs an editor"})`,
          body: `${askWords(r)} — ${agency ? `with ${who}: relay it to them.` : "no editor on it: pick one."}`,
          href,
          dedupeKey: `revision-waiting:${r.projectId}:office:${r.askId}:${n}`,
          slack: agency
            ? `Revision waiting ${dayWords(r.days)} — ${where}. It's with ${who} — relay it to them: ${base}${href}`
            : `Revision waiting ${dayWords(r.days)} — ${where}. It needs an editor — pick one on its Editing Room row: ${base}${href}`,
        });
        if (res.bell) run.kyle.sent++;
        else run.kyle.already++;
      }
    } catch (e) {
      run.failed.push(`${r.street}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }

  // ---- KYLE'S ONCE-A-DAY LIST (3+ days with an editor) ----------------------
  if (!KYLE_DAILY_STUCK_LIST) run.stuck = "off";
  else if (etMinutesOfDay(now) < KYLE_STUCK_LIST_FROM_HOUR_ET * 60) run.stuck = "before 9 AM ET";
  else {
    // One entry per job and editor, at its oldest ask.
    const jobs = new Map<string, { street: string; client: string; editor: string; days: number; videos: number }>();
    for (const r of open) {
      if (r.lane !== "editor" || r.days < KYLE_STUCK_AFTER_DAYS) continue;
      const k = `${r.projectId}|${r.editorKey}`;
      const j = jobs.get(k);
      if (j) { j.days = Math.max(j.days, r.days); j.videos++; }
      else jobs.set(k, { street: r.street, client: r.client, editor: r.editorName ?? "the editor", days: r.days, videos: 1 });
    }
    const list = [...jobs.values()].sort((a, b) => b.days - a.days);
    if (list.length) {
      const named = list.slice(0, STUCK_LIST_MAX).map((j) => `${j.street} (${j.client}) — ${j.editor}, ${dayWords(j.days)}${j.videos > 1 ? `, ${j.videos} videos` : ""}`);
      const more = list.length > STUCK_LIST_MAX ? `; and ${list.length - STUCK_LIST_MAX} more` : "";
      const label = `${list.length} revision${list.length === 1 ? "" : "s"} stuck with an editor ${KYLE_STUCK_AFTER_DAYS}+ days`;
      try {
        const res = await noticeForKyle({
          kind: "revision_stuck",
          title: label,
          body: `${named.join("; ")}${more}`,
          href: CHANGES_STAGE_HREF,
          dedupeKey: `revision-stuck:${etDayKey(now)}`,
          slack: `${label}: ${named.join("; ")}${more}. ${base}${CHANGES_STAGE_HREF}`,
        });
        run.stuck = res.bell ? "sent" : "already";
      } catch (e) {
        run.stuck = "failed";
        run.failed.push(`stuck list: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
      }
    }
  }
  return run;
}
