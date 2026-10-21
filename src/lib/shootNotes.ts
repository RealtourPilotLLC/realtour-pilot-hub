import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { clip, noDashes, scrubMoney } from "@/lib/text";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";

// ---------------------------------------------------------------------------
// A CLIENT'S ACCESS NOTE GOES ON THE SHOOT BRIEF (Oct 14 2026 comms audit).
//
// "The gate code is 4417, park in the driveway" used to become a separate
// to-do ("Note gate code for the 12 Oak St shoot", the Smart Brain's own
// bookkeeping type, brain.brainTaskType = todo) that sat undone, while the
// photographer's screen read only Aryeo's order questions (shoot.ts
// parseShootBrief). The path that already reaches the photographer exists:
// a SPECIAL_REQUEST activity on the project is what /shoot, Ops Day's shoot
// card and the editor packet all list (shoot.ts specialRequests, opsDay.ts
// SHOOT_SELECT, editorPacket.ts). So when the brain files a client message as
// an access or shoot instruction on a job whose shoot is still ahead:
//   1. the words go on the job as that same SPECIAL_REQUEST row, labelled
//      "Client access note (<source>):" (Oct 15: the label keeps it off every
//      editor's brief, specialRequests.ts; /shoot strips it like the others);
//   2. the to-do the brain just opened for it is COMPLETED with a note saying
//      where the words went (only a fresh to-do this message made: a row that
//      merged other asks stays open);
//   3. a shoot inside 24 hours: the assigned photographer gets it ONCE, by
//      notifyStaffSms (their own channel and quiet time apply).
// One AppSetting claim per message makes 1 and 3 run once however often the
// message is replayed (a webhook retry, a Gmail rescan). Staff only.
// ---------------------------------------------------------------------------

// The message has to SAY something a photographer needs on site.
const ACCESS_WORDS =
  /\b(lock\s?-?box|door code|gate code|garage code|alarm(?: code)?|keypad|(?:the )?code (?:is|to|for)|combo|combination|keys? (?:is|are|will be|under|in|on)|supra|showing ?time|side door|back door|front door|garage door|vacant|occupied|tenants?|homeowners?|(?:owners?|sellers?) (?:will be|is|are|won'?t be) (?:home|there|present|on site)|dogs?|cats?|pets?|park (?:in|on|at)|parking|driveway|gate)\b/i;
const SHOOT_WORDS =
  /\b(please (?:shoot|photograph|capture|get|include|skip|avoid|focus)|make sure (?:to|you) (?:get|shoot|capture|include)|(?:don'?t|do not) (?:shoot|photograph|capture|include|show)|shot list|(?:focus|highlight) on|twilight|drone shots?|aerials?)\b/i;
// …and the brain has to have FILED it as one (its title/detail for the to-do).
const NOTE_FILING = /\b(access|lock\s?-?box|codes?|alarm|keys?|gate|parking|park|entry|pets?|dogs?|vacant|occupied|tenants?|sellers?|homeowners?|shoot|photographer|brief|instructions?|shot list)\b/i;

/** The photographer's text about a client note: the shoot_note template
 *  (Settings → Text messages, Oct 21 2026), no long dashes, no amounts. Pure. */
export function shootNoteText(o: { street: string; when: string; note: string; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  return noDashes(scrubMoney(t.render("shoot_note", o)));
}

/** Does a note say how to get in (a code, a key, who is home, where to park)? Pure. */
export function mentionsAccess(text: string): boolean {
  return ACCESS_WORDS.test(text ?? "");
}

/** The brain's filing reads as an access or shoot instruction, and the message carries one. Pure. */
export function isAccessOrShootNote(input: { text: string; title?: string | null; detail?: string | null }): boolean {
  const t = (input.text ?? "").trim();
  if (t.length < 4) return false;
  if (!ACCESS_WORDS.test(t) && !SHOOT_WORDS.test(t)) return false;
  return NOTE_FILING.test(`${input.title ?? ""} ${input.detail ?? ""}`);
}

const SHOOT_NOTE_PREFIX = "shoot-note:";
const SHOOT_NOTE_PING_PREFIX = "shoot-note-ping:";
const HOUR = 3_600_000;

const sha = (parts: (string | null | undefined)[]) => crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);

/** The key one inbound message is filed under: its CommLog row when known, else its words. */
export function shootNoteKey(o: { commLogId?: string | null; clientId: string; projectId: string; text: string }): string {
  return o.commLogId ? `c:${o.commLogId}` : `t:${sha([o.clientId, o.projectId, o.text.trim()])}`;
}

export type ShootNoteResult = { filed: boolean; closedTaskId: string | null; pinged: boolean; reason?: string };

/**
 * File one client message on the job's shoot brief. Called by
 * comms.recordClientCommunication after the Smart Brain routed it. Never
 * throws: the message and its task are already recorded either way.
 */
export async function fileClientShootNote(opts: {
  clientId: string;
  projectId: string;
  text: string;
  source: string;
  title: string | null;
  detail: string | null;
  /** brain.brainTaskType's answer for the row it opened */
  taskType: "todo" | "client_reply";
  /** this message opened (or reopened) its own to-do, rather than merging into another row */
  freshTodo: boolean;
  commLogId?: string | null;
  now?: Date;
}): Promise<ShootNoteResult> {
  const now = opts.now ?? new Date();
  try {
    if (!isAccessOrShootNote({ text: opts.text, title: opts.title, detail: opts.detail })) return { filed: false, closedTaskId: null, pinged: false, reason: "not an access or shoot note" };
    const p = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { id: true, title: true, status: true, shootDate: true, photographerId: true, clientId: true },
    });
    if (!p || p.clientId !== opts.clientId) return { filed: false, closedTaskId: null, pinged: false, reason: "not this client's job" };
    if (!p.shootDate || p.shootDate <= now || ["DELIVERED", "CANCELLED", "ON_HOLD"].includes(p.status)) {
      return { filed: false, closedTaskId: null, pinged: false, reason: "no upcoming shoot on the job" };
    }
    const key = shootNoteKey({ commLogId: opts.commLogId, clientId: opts.clientId, projectId: p.id, text: opts.text });
    const { ACCESS_NOTE_LABEL } = await import("@/lib/specialRequests");
    const body = `${ACCESS_NOTE_LABEL} (${opts.source || "comms"}): ${clip(opts.text, 280)}`;
    // The claim and the brief line commit together: a second run finds the
    // claim and writes nothing; a failed write leaves no claim behind.
    let filed = true;
    try {
      await prisma.$transaction([
        prisma.appSetting.create({ data: { key: `${SHOOT_NOTE_PREFIX}${key}`, value: JSON.stringify({ projectId: p.id, at: now.toISOString() }), updatedBy: "shoot-notes" } }),
        prisma.activity.create({ data: { projectId: p.id, type: "SPECIAL_REQUEST", body } }),
      ]);
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "P2002") throw e;
      filed = false; // this message is already on the brief
    }

    // The to-do the brain opened for these words: done, and it says where they went.
    let closedTaskId: string | null = null;
    if (opts.taskType === "todo" && opts.freshTodo) {
      const todoKey = sha([opts.clientId, p.id, "brain_todo"]);
      const todo = await prisma.smartTask.findUnique({ where: { dedupeKey: todoKey }, select: { id: true, status: true, description: true, summary: true, assignedManually: true, flaggedAt: true } });
      const onlyThisMessage = !!todo?.description && todo.description.trim().startsWith(opts.text.trim().slice(0, 120)) && !/\n\n\u2014 /.test(todo.description);
      if (todo && onlyThisMessage && !todo.assignedManually && !todo.flaggedAt && !["COMPLETED", "CANCELLED"].includes(todo.status)) {
        const street = (p.title ?? "").split(",")[0].trim() || "the job";
        const r = await prisma.smartTask.updateMany({
          where: { id: todo.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: {
            status: "COMPLETED",
            completedAt: now,
            summary: `Added to the shoot brief for ${street}: it shows on the photographer's shoot screen, Ops Day and the editor packet.${todo.summary ? `\n${todo.summary}` : ""}`.slice(0, 500),
          },
        });
        if (r.count > 0) closedTaskId = todo.id;
      }
    }

    // Inside 24 hours of the shoot, the photographer hears it once.
    let pinged = false;
    const msLeft = p.shootDate.getTime() - now.getTime();
    if (p.photographerId && msLeft > 0 && msLeft <= 24 * HOUR) {
      const pingKey = `${SHOOT_NOTE_PING_PREFIX}${key}`;
      const claimed = await prisma.appSetting
        .create({ data: { key: pingKey, value: now.toISOString(), updatedBy: "shoot-notes" } })
        .then(() => true)
        .catch(() => false);
      if (claimed) {
        const { notifyStaffSms } = await import("@/lib/notify");
        const { etDateTime } = await import("@/lib/datetime");
        const { appBase } = await import("@/lib/appUrl");
        const { loadTextTemplates } = await import("@/lib/textTemplateStore");
        const street = (p.title ?? "").split(",")[0].trim() || "your shoot";
        const text = shootNoteText({ street, when: etDateTime(p.shootDate), note: clip(opts.text, 300), link: `${appBase()}/shoot/${p.id}` }, await loadTextTemplates());
        const out = await notifyStaffSms([p.photographerId], text, "shoot_note");
        pinged = out.some((o) => o.outcome === "slack" || o.outcome === "sent" || o.outcome === "held" || o.outcome === "deferred");
      }
    }
    return { filed, closedTaskId, pinged };
  } catch (e) {
    console.warn("fileClientShootNote failed", e);
    return { filed: false, closedTaskId: null, pinged: false, reason: "failed" };
  }
}
