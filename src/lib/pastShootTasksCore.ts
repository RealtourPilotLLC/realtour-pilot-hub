// ---------------------------------------------------------------------------
// TO-DOS THAT OUTLIVED THEIR SHOOT (Oct 29 2026, Jordan: "the 6344 Reedland St
// booking happened a while ago and was delivered. Things like that referencing
// old shoots should automatically be cleared, I would think, but we don't want
// to clear important things, so how do we distinguish?").
//
// The pure decision, one task at a time (lib/pastShootTasks reads the rows and
// closes; the drill runs this alone). A task is cleared only when EVERY test
// below says so; any one of them keeps it:
//
//   · the hub made it, from a client's text or email or by itself, and it is
//     still plain OPEN: nobody delegated, flagged or reassigned it, it is not
//     from Jordan, nobody gave it a new date, a note or a "waiting on" after the
//     shoot day began;
//   · its words are a BEFORE-THE-SHOOT step (the booking, the time, access and
//     codes, prep, notes or scripts for the shoot), and none of the after-shoot
//     business (money, complaints, revisions and fixes, retakes, floor plans,
//     Zillow, Showcase, lot lines) and no later visit ("at a later date");
//   · its job's shoot day is over and the job is shot (photos or footage in);
//     anything about the video or the edit waits for the job to be DELIVERED;
//   · it was written by the end of the shoot day. One exception: an access note
//     that came in after the shoot, on a job already delivered and not reopened;
//   · every other address it carries is a past, shot job too. A task that later
//     messages were merged into can be ABOUT another shoot by now (Reedland's
//     row holds an access code for 5457 Cedar Ave, a shoot on Oct 29).
//
// Closing is the dismissal the rest of the hub already understands ("Dismissed
// by the hub — …"), recorded in AuditLog with what it was, and reversible.
// ---------------------------------------------------------------------------

/** Statuses that say the shoot happened. CANCELLED and anything before SHOT never clear. */
export const SHOT_STATUSES = ["SHOT", "EDITING", "REVIEW", "REVISION", "DELIVERED"] as const;

/** Only rows the hub itself makes from a client's text or email, or by itself. */
export const CLEARABLE_SOURCES = ["openphone", "gmail", "system"] as const;
/** Sources that mean a PERSON wrote the row (everything else is another part of the hub). */
const PERSON_SOURCES = ["manual", "team", "assistant", "delegation", "client_issue", "slack"];
/** Message and instruction to-dos. Production engines' rows (edits, QC, texts) close themselves. */
export const CLEARABLE_TYPES = ["todo", "client_reply", "comms_followup", "internal_instruction"] as const;

const STREET_RE = /\b(\d{1,6}[a-z]?)[\s-]+((?:[nsew]\.?[\s-]+)?[a-z][a-z'.]*(?:[\s-]+[a-z][a-z'.]*){0,3}?)[\s-]+(?:st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pike|hwy|highway|pkwy|parkway|trl|trail|run|sq|square|xing|crossing|aly|alley)\b/gi;

/** Each street address in the text, as written, with its key: "6344 reedland" for
 *  "6344 Reedland St" (number + the street's first word, a leading E/W/N/S skipped). */
export function streetMentions(text: string | null | undefined): { key: string; text: string }[] {
  const out = new Map<string, string>();
  const s = String(text ?? "");
  STREET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STREET_RE.exec(s))) {
    const name = m[2].toLowerCase().replace(/^[nsew]\.?[\s-]+/, "").split(/[\s-]+/)[0];
    const key = `${m[1].toLowerCase()} ${name}`;
    if (name && !out.has(key)) out.set(key, m[0].replace(/-/g, " ").replace(/\s+/g, " ").trim());
  }
  return [...out].map(([key, text]) => ({ key, text }));
}

export const streetKeys = (text: string | null | undefined): string[] => streetMentions(text).map((m) => m.key);

/** The street part of a job title ("6344 Reedland St, Philadelphia, PA" → "6344 Reedland St"). */
export const streetOfTitle = (title: string) => title.split(",")[0].trim();

// The hub's own words on the row (title + its summary) decide what the task is.
const BOOKING = /\b(book(?:ing|ed)?|schedul(?:e|ed|ing)|re-?schedul\w*|resched\w*|appointments?|availab\w*|confirm(?:ed|ing|ation)?\s+(?:the\s+)?(?:booking|appointment|shoot|time|date|order)|move[ds]?\s+(?:it\s+|the\s+shoot\s+)?(?:earlier|later|up|back))\b/i;
const ACCESS = /\b(lock ?box|access(?: code)?|gate code|door code|codes?|keys?|tenants?|occupants?|let (?:you|them|us|him|her|the photographer) in|vacant)\b/i;
const ETA = /\b(running late|on (?:my|the|his|her|their) way|eta|directions|parking)\b/i;
const PREP = /\b(prep|prepare[ds]?|preparing|brief|note|notes|remind(?:er)?|plan)\b/i;
const SHOOT_CONTEXT = /\b(shoot|shooting|appointment|session|visit|filming|film|arrival|on ?site|scripts?)\b/i;
/** After-the-shoot business: never cleared. */
const AFTER = /\b(invoice\w*|unpaid|payments?|pay|paid|refund\w*|credits?|charge[ds]?|billing|bill(?:ed)?|discount\w*|deposit|complain\w*|unhappy|upset|disappoint\w*|revisions?|redo|re-do|retakes?|re-?shoots?|re-?edit\w*|fix(?:es|ed|ing)?|wrong|mistakes?|missing|floor ?plans?|zillow|showcase|3d|matterport|tours?|lot lines?|plat|survey|testimonial)\b/i;
/** About the video or the edit: only once the job is DELIVERED. */
const EDIT = /\b(videos?|edit|edits|editing|editor|reels?|song|music|voice ?over|captions?|thumbnail|drone)\b/i;
/** A visit still to come, anywhere in the row (its merged messages included). */
const LATER = /\b(at a later date|later date|another (?:time|day|date|point in time|visit)|next (?:shoot|session|visit)|come back|go back|return (?:visit|trip)|second (?:visit|trip|session)|re-?visit)\b/i;

export type PastShootTask = {
  taskType: string;
  source: string;
  status: string;
  title: string;
  summary: string | null;
  description: string | null;
  reasonCreated: string | null;
  createdAt: Date;
  delegatedBy: string | null;
  flaggedBy: string | null;
  flaggedAt: Date | null;
  assignedManually: boolean;
};

export type PastShootJob = { title: string; status: string; shootDate: Date | null; deliveredAt: Date | null };

export type PastShootInput = {
  task: PastShootTask;
  /** the job the task is about: its projectId, else the address in its words */
  job: PastShootJob | null;
  /** a person acted on it after the shoot day began: a new date, a note, a "waiting on" */
  touchedAfterShoot: string | null;
  /** every OTHER address in the row, with its job (and that shoot's ET day) when the hub has one */
  others: { street: string; job: PastShootJob | null; shootKey: string | null }[];
  /** ET day keys ("2026-10-29"): today's, the shoot's, the task's, the delivery's */
  todayKey: string;
  shootKey: string | null;
  createdKey: string;
  deliveredKey: string | null;
};

export type PastShootVerdict =
  | { clear: true; rule: "before-shoot" | "late-access"; why: string }
  | { clear: false; why: string };

const keep = (why: string): PastShootVerdict => ({ clear: false, why });

/** Did the shoot happen (its day is over and the job says so)? */
export function shootIsPast(job: PastShootJob | null, shootKey: string | null, todayKey: string): boolean {
  return !!job && !!shootKey && shootKey < todayKey && (SHOT_STATUSES as readonly string[]).includes(job.status);
}

/** From Jordan, the way the desks read it (source "assistant", or Jordan named in why it was made). */
export const fromJordan = (t: { source: string; reasonCreated: string | null }) => t.source === "assistant" || /\bJordan\b/.test(t.reasonCreated ?? "");

/** THE RULE, for one task. Pure. */
export function classifyPastShootTask(x: PastShootInput): PastShootVerdict {
  const t = x.task;
  if (t.status !== "OPEN") return keep(`someone has it ${t.status === "IN_PROGRESS" ? "in progress" : t.status.toLowerCase().replace(/_/g, " ")}`);
  if (!x.job) return keep("not tied to a job");
  if (!shootIsPast(x.job, x.shootKey, x.todayKey)) return keep(x.job.status === "CANCELLED" ? "the job was cancelled" : "the shoot has not happened yet");
  if (!(CLEARABLE_SOURCES as readonly string[]).includes(t.source)) {
    return keep(PERSON_SOURCES.includes(t.source) ? `a person made it (${t.source})` : `made by another part of the hub, which closes it (${t.source})`);
  }
  if (!(CLEARABLE_TYPES as readonly string[]).includes(t.taskType)) return keep(`its own engine closes it (${t.taskType.replace(/_/g, " ")})`);
  if (t.delegatedBy) return keep("a person handed it to someone");
  if (t.flaggedBy || t.flaggedAt) return keep("a person flagged it");
  if (t.assignedManually) return keep("a person assigned it by hand");
  if (fromJordan(t)) return keep("from Jordan");
  if (x.touchedAfterShoot) return keep(x.touchedAfterShoot);

  const words = `${t.title}\n${t.summary ?? ""}`;
  const after = AFTER.exec(words);
  if (after) return keep(`after-the-shoot business ("${after[1]}")`);
  const later = LATER.exec(`${words}\n${t.description ?? ""}`);
  if (later) return keep(`mentions a visit still to come ("${later[1]}")`);
  const edit = EDIT.exec(words);
  if (edit && x.job.status !== "DELIVERED") return keep(`about the ${edit[1].toLowerCase()}, and the job is not delivered yet`);

  const booking = BOOKING.test(t.title);
  const access = ACCESS.test(t.title) || ETA.test(t.title);
  const prep = PREP.test(t.title) && SHOOT_CONTEXT.test(t.title);
  if (!booking && !access && !prep) return keep("not a before-the-shoot step");

  for (const o of x.others) {
    if (!o.job) return keep(`also mentions ${o.street}, which has no job in the hub`);
    if (!shootIsPast(o.job, o.shootKey, x.todayKey)) return keep(`also carries a message about ${o.street}, a shoot that has not happened yet`);
  }

  const shootKey = x.shootKey!;
  if (x.createdKey <= shootKey) {
    return { clear: true, rule: "before-shoot", why: booking ? "a booking step" : access ? "access or arrival details" : "prep for the shoot" };
  }
  // Written after the shoot: a real ask, except an access note on a job already delivered and not reopened.
  if (access && !booking && x.job.status === "DELIVERED" && x.deliveredKey && x.deliveredKey < x.todayKey) {
    return { clear: true, rule: "late-access", why: "access details that came in after the shoot, on a delivered job" };
  }
  return keep("written after the shoot: a new ask");
}

/** The words the closed row carries, after "Dismissed by the hub — ". */
export function clearedReason(street: string, shootWords: string, deliveredWords: string | null): string {
  return `cleared: the shoot at ${street} was on ${shootWords}${deliveredWords ? ` and delivered ${deliveredWords}` : ""}, so this before-the-shoot step is no longer needed`;
}
