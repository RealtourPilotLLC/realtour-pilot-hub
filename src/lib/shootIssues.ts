import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// SHOOT ISSUES FOR JORDAN (Oct 19 2026). Jordan: "if the creative flags
// something that doesn't relate to photo editing or video editing or
// delivery, then it should just go to me so I can see the issues that keep
// happening at shoots so I can reach out to the client or fix the bottleneck."
//
// sortShootFlag decides what a creative's flag is about, with a plain word
// rule (no AI call; the same answer every time it is asked, so the job box,
// Kyle's loop and Jordan's list never disagree):
//   · words about the photos, the video, the edit or getting the files out
//     ("blurry", "missed the twilight shot", "drone footage", "upload",
//     "remove the trash cans") make it a JOB flag: it shows on that job's
//     "Before you send" box and goes to Kyle, as before;
//   · words about everything else at a shoot (the client or agent late, the
//     house not ready, a code or lockbox, equipment, scheduling, the client's
//     behaviour, pets, weather) and NO editing or delivery word make it an
//     OWNER flag: it goes only to Jordan (his own loop and this list), never
//     to Kyle or the job box;
//   · both kinds of words: both (Kyle and the job box, and Jordan's list);
//   · neither: unsure, so the safe default, a JOB flag (Kyle and the job box).
// `about` says which box shows a job flag: photo, video, delivery (both
// boxes) or both.
//
// ownerShootIssues is what Jordan's Home shows: his open shoot issues (one
// loop per job, key shoot-owner-<projectId>) and, over the last 60 days, how
// many non-editing flags each client's shoots had, so repeats stand out.
// ---------------------------------------------------------------------------

export type ShootIssue = { id: string; client: string; street: string | null; text: string; by: string | null; atISO: string; href: string };

export type FlagRoute = "job" | "owner" | "both";
export type FlagAbout = "photo" | "video" | "delivery" | "both";

/** Jordan's loop for one job's non-editing shoot flags. */
export const ownerShootLoopKey = (projectId: string) => `shoot-owner-${projectId}`;

const PHOTO_RE =
  /\b(photos?|pics?|pictures?|images?|stills?|retouch\w*|hdr|exposure|over-?exposed|under-?exposed|sky|skies|twilight|floor ?plans?|matterport|3d tour|zillow|virtual(?:ly)? stag\w*|lot ?lines?|mirrors?|reflections?|trash ?cans?|photoshop|white balance|headshots?|exteriors?|interiors?)\b/i;
const VIDEO_RE =
  /\b(videos?|footage|clips?|reels?|b-?roll|audio|sound|music|songs?|voice-?over|script|talking head|on camera|teleprompter|gimbal|walk-?through|cinematic|intro|outro|interview)\b/i;
const EDIT_RE =
  /\b(shots?|edit(?:s|ed|ing|or|ors)?|remov\w*|angles?|lens|blurr?y|blur|out of focus|colou?rs?|drone|aerials?|re-?shoot|re-?take|coverage|missed shot|cull\w*|rooms?|bedrooms?|bathrooms?|basements?|kitchens?|garages?|yards?)\b/i;
const DELIVERY_RE =
  /\b(deliver\w*|upload\w*|files?|raws?|sd ?cards?|memory cards?|dropbox|aryeo|links?|due|rush|same[- ]day|turnaround|corrupt\w*|backups?)\b/i;
const OTHER_RE =
  /\b(late|waited|waiting|no[- ]?show|not home|wasn'?t home|weren'?t home|(?:not|wasn'?t|weren'?t|isn'?t)(?:\s+\w+)?\s+ready|set(?:ting)? (?:it|the house|the home|everything) up|asleep|sleeping|occupied|unprepared|not prepared|(?:didn'?t|did not) prepare|bother\w*|ran out of gas|car trouble|stuck|bad area|someone (?:was|is) (?:home|there|in)|took (?:over |about |almost )?(?:\d+|an?) (?:min\w*|hours?)|messy|dirty|clutter\w*|a mess|lock ?box|codes?|keys?|gate|locked|access|(?:couldn'?t|could not|can'?t|cannot) get in|let (?:me|us) in|alarm|batter(?:y|ies)|equipment|gear|broke|broken|forgot|crash\w*|tripod|charger|reschedul\w*|cancel\w*|double[- ]?book\w*|appointment|parking|traffic|rude|upset|angry|argu\w*|yell\w*|complain\w*|homeowners?|sellers?|tenants?|occupants?|pets?|dogs?|cats?|weather|rain\w*|snow\w*|storm\w*|construction|contractors?|workers?|unsafe|hazard\w*|safety|police|neighbou?rs?|paid|payment|price|extra (?:charge|fee)|not on the order|(?:wasn'?t|was not|not|didn'?t|did not) order(?:ed)?|upsell\w*|agent (?:wanted|wants|asked))\b/i;

const LABEL_PREFIX_RE = /^(?:shoot debrief\s*[—-]\s*had issues|shoot issue|shoot debrief|missed shot)\s*:\s*/i;

/** A field flag's own words, without the "Shoot debrief — had issues:" style label the hub put in front. */
export function flagWords(body: string): string {
  return (body ?? "").trim().replace(LABEL_PREFIX_RE, "").trim();
}

/**
 * What a creative's flag is about (pure). `label` is the flag's kind as filed
 * ("Shoot issue", "Shoot debrief", "Missed shot"): a missed shot is always
 * about the work.
 */
export function sortShootFlag(note: string, label?: string | null): { route: FlagRoute; about: FlagAbout; why: string } {
  // Phone keyboards write curly apostrophes ("wasn’t"): straighten them first.
  const raw = (note ?? "").replace(/[\u2018\u2019]/g, "'").trim();
  const words = flagWords(raw);
  const missedShot = /^missed shot/i.test(label ?? "") || /^missed shot\b/i.test(raw);
  const photo = PHOTO_RE.test(words);
  const video = VIDEO_RE.test(words);
  const delivery = DELIVERY_RE.test(words);
  const edit = EDIT_RE.test(words);
  const job = missedShot || photo || video || delivery || edit;
  const other = OTHER_RE.test(words);
  const about: FlagAbout = photo && !video ? "photo" : video && !photo ? "video" : delivery && !photo && !video && !edit ? "delivery" : "both";
  if (job && other) return { route: "both", about, why: "about the work and about the shoot itself" };
  if (job) return { route: "job", about, why: missedShot ? "a missed shot" : "about the photos, the video or delivery" };
  if (other) return { route: "owner", about: "both", why: "about the shoot itself, not the editing or delivery" };
  return { route: "job", about: "both", why: "unclear, kept with Kyle and on the job" };
}

/** Shows on the job box and goes to Kyle. */
export const isJobFlag = (route: FlagRoute) => route === "job" || route === "both";
/** Goes to Jordan's list. */
export const isOwnerFlag = (route: FlagRoute) => route === "owner" || route === "both";

const streetOf = (title?: string | null) => (title ?? "").split(",")[0].trim() || null;
const DAY = 86_400_000;

/** Jordan's open non-editing shoot issues, and those flags counted by client over 60 days (most first). */
/** One client's flags over the window, newest first: what the Client issues panel lists as the records (Oct 26 2026). */
export type ShootFlagGroup = { client: string; clientId: string | null; count: number; items: { id: string; text: string; street: string | null; atISO: string; href: string }[] };

export async function ownerShootIssues(now: Date = new Date()): Promise<{ open: ShootIssue[]; byClient: ShootFlagGroup[] }> {
  try {
    const [loops, flags] = await Promise.all([
      prisma.smartTask.findMany({
        where: { dedupeKey: { startsWith: "shoot-owner-" }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        orderBy: [{ flaggedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        take: 40,
        select: { id: true, projectId: true, description: true, flaggedBy: true, flaggedAt: true, updatedAt: true, project: { select: { title: true, client: { select: { name: true } } } } },
      }),
      prisma.activity.findMany({
        where: { type: "FLAG", createdAt: { gte: new Date(now.getTime() - 60 * DAY) } },
        orderBy: { createdAt: "desc" },
        take: 1000,
        select: { id: true, body: true, createdAt: true, projectId: true, project: { select: { title: true, clientId: true, client: { select: { name: true } } } } },
      }),
    ]);
    const { isFieldFlag } = await import("@/lib/debrief");
    const { isSyntheticClientRow } = await import("@/lib/testClients");
    const open: ShootIssue[] = loops
      .filter((l) => !isSyntheticClientRow({ name: l.project?.client?.name ?? "" }))
      .map((l) => {
        // The newest entry on the loop: one line, the creative's words.
        const entries = (l.description ?? "").split(/\n• /).map((x) => x.replace(/^• /, "").trim()).filter(Boolean);
        const last = entries[entries.length - 1] ?? "";
        return {
          id: l.id,
          client: l.project?.client?.name ?? "Client",
          street: streetOf(l.project?.title),
          text: clip(last.replace(/\s+/g, " "), 240),
          by: l.flaggedBy ?? null,
          atISO: (l.flaggedAt ?? l.updatedAt).toISOString(),
          href: l.projectId ? `/projects/${l.projectId}` : "/tasks",
        };
      });
    const groups = new Map<string, ShootFlagGroup>();
    for (const f of flags) {
      if (!isFieldFlag(f.body)) continue;
      const name = f.project?.client?.name;
      if (!name || isSyntheticClientRow({ id: f.project?.clientId, name })) continue;
      if (!isOwnerFlag(sortShootFlag(f.body).route)) continue;
      const g = groups.get(name) ?? { client: name, clientId: f.project?.clientId ?? null, count: 0, items: [] };
      g.count++;
      g.items.push({ id: f.id, text: clip(flagWords(f.body).replace(/\s+/g, " "), 240), street: streetOf(f.project?.title), atISO: f.createdAt.toISOString(), href: f.projectId ? `/projects/${f.projectId}` : "/jobs" });
      groups.set(name, g);
    }
    const byClient = [...groups.values()].sort((a, b) => b.count - a.count || a.client.localeCompare(b.client));
    return { open, byClient };
  } catch (e) {
    console.error("[shoot-issues] owner list failed", e);
    return { open: [], byClient: [] };
  }
}

/**
 * A SHOOT FLAG CLEARS WHEN ITS JOB IS DELIVERED (Jordan, Oct 19 2026: "Only
 * flagged issues should show up on the shoot itself. It should clear once the
 * job is delivered."). Every open flag loop (Kyle's `field-flag-<job>` and
 * the older `shoot-issue-<job>`, Jordan's `shoot-owner-<job>`) on a job that
 * is DELIVERED or CANCELLED is
 * completed with the reason. A job reopened for revisions is not delivered,
 * so its flags stay. Run every five minutes from the comms cron; cheap (open
 * loops only). Never throws.
 */
export async function closeShootFlagsOnDeliveredJobs(now: Date = new Date()): Promise<{ closed: number }> {
  const out = { closed: 0 };
  try {
    const open = await prisma.smartTask.findMany({
      where: {
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        projectId: { not: null },
        // Kyle's loop has been keyed `field-flag-<job>` since Sep 8 (fieldIssues
        // fieldFlagLoopKey); `shoot-issue-` is the older debrief key. Without it
        // Kyle's flags never cleared (audit, Oct 25 2026: 116 W Windsor St,
        // 326 Spring Garden St and 18 Benner Rd open on delivered jobs).
        OR: [{ dedupeKey: { startsWith: "field-flag-" } }, { dedupeKey: { startsWith: "shoot-issue-" } }, { dedupeKey: { startsWith: "shoot-owner-" } }],
      },
      select: { id: true, status: true, summary: true, project: { select: { status: true } } },
      take: 500,
    });
    for (const t of open) {
      const st = t.project?.status;
      if (st !== "DELIVERED" && st !== "CANCELLED") continue;
      const why = st === "CANCELLED" ? "Closed by the hub: the job was cancelled." : "Closed by the hub: the job was delivered.";
      const r = await prisma.smartTask.updateMany({
        where: { id: t.id, status: t.status },
        data: { status: "COMPLETED", completedAt: now, summary: clip(t.summary ? `${why}\n${t.summary}` : why, 500) },
      });
      out.closed += r.count;
    }
  } catch (e) {
    console.error("[shoot issues] closing flags on delivered jobs failed", e);
  }
  return out;
}
