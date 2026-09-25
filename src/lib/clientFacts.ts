import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { normalizeTitle } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Client knowledge as STRUCTURED facts (spec §23) replacing the unreviewed
// ContentNote.intelligence pile. Every fact carries source, date, scope
// (permanent / month / project), status, visibility, an AI-context
// permission and supersession. Generators read ONLY status=ACCEPTED +
// aiContext=ALLOWED + confidential=false facts (factsForPrompt). A fact that
// contradicts an accepted one on the same field becomes an EXCEPTION
// (conflictsWithId) for a human — confidence never overrides.
//
// Confidentiality is a column here. The [CONFIDENTIAL] text marker stays as
// the interim guard on the legacy readers; both are honoured.
// ---------------------------------------------------------------------------

export type FactCategory = "BRAND_PREFERENCE" | "PRODUCTION_PREFERENCE" | "PERFORMANCE_REPORTED" | "PERFORMANCE_MEASURED" | "DECISION" | "COMMITMENT" | "INTERNAL" | "PROPOSED_CHANGE" | "FEEDBACK";
export type FactScope = "PERMANENT" | "MONTH" | "PROJECT";

export const CONFIDENTIAL_RE = /\[CONFIDENTIAL[^\]]*\]/i;

// Field keys whose routine, high-confidence updates MAY auto-accept when the
// fact_extraction switch is on (still undoable). Brand positioning, audience,
// strategy, pricing, package and billing are NEVER on this list (design §3.4).
export const AUTO_ACCEPT_FIELD_KEYS = new Set(["production.location_preference", "production.preferred_days", "production.teleprompter", "production.wardrobe", "editing.pace", "editing.captions", "editing.music"]);
const NEVER_AUTO_RE = /^(brand\.|audience\.|strategy\.|pricing|package|billing)/i;

// Cheap keyword classifier for migrated notes (a human resolves the rest).
export function classifyFactBody(body: string): FactCategory {
  const b = body.toLowerCase();
  if (/\b(views|followers|engagement|reach|impressions|went viral|performed|performance)\b/.test(b)) return "PERFORMANCE_REPORTED";
  if (/\b(prefers?|likes?|wants?|doesn'?t (like|want)|hates?|avoid|comfortable|not comfortable)\b/.test(b) && /\b(edit|cut|pace|caption|music|graphic|b-roll|filming|film|shoot|location|teleprompter|wardrobe|camera|lighting)\b/.test(b)) return "PRODUCTION_PREFERENCE";
  if (/\b(prefers?|likes?|wants?|voice|tone|brand|positioning|audience|niche|market|style|feel)\b/.test(b)) return "BRAND_PREFERENCE";
  if (/\b(decided|agreed|will (not )?do|going to|plan(s|ned)? to|commit(ted|s)?|promised)\b/.test(b)) return /\b(will send|will provide|will share|promised|committed)\b/.test(b) ? "COMMITMENT" : "DECISION";
  if (/\b(feedback|loved|liked the|didn'?t like the|complain)\b/.test(b)) return "FEEDBACK";
  return "PROPOSED_CHANGE";
}

export function factDedupeHash(body: string): string {
  return sha256(normalizeTitle(body).slice(0, 400));
}

export type NewFact = {
  clientId: string; enrollmentId?: string | null; category: FactCategory; fieldKey?: string | null; body: string;
  source: "call" | "import" | "client" | "staff" | "ai" | "note_migration" | "review" | "comms"; sourceRef?: string | null; callRecordId?: string | null; transcriptSourceId?: string | null;
  excerpt?: { time?: string | null; speaker?: string | null; text: string }[] | null; speaker?: string | null; factDate?: Date | null;
  scope?: FactScope; monthId?: string | null; projectId?: string | null; confidential?: boolean; confidence?: number | null; aiRunId?: string | null; legacyNoteId?: string | null;
  /** "let's try faster cuts on this one" → PROJECT scope by default when a projectId is at hand. */
  unattended?: boolean;
};

/**
 * Create a fact as PROPOSED / aiContext DENIED. Duplicates of an existing
 * body (same dedupeHash, same client) are not re-created. A conflict with
 * an ACCEPTED fact on the same fieldKey (different wording) is flagged, not
 * resolved. Auto-accept only for whitelisted keys, only when fact_extraction
 * is on, and only for unattended extraction — and it stays undoable.
 */
export async function createFact(f: NewFact): Promise<{ id: string; existed: boolean; conflict: boolean; autoAccepted: boolean }> {
  const raw = f.body.trim().slice(0, 4000);
  if (!raw) throw new Error("A fact needs a body.");
  const confidential = f.confidential === true || CONFIDENTIAL_RE.test(raw);
  const body = raw.replace(CONFIDENTIAL_RE, "").replace(/\s+/g, " ").trim();
  const dedupeHash = factDedupeHash(body);
  const dup = await prisma.clientFact.findFirst({ where: { clientId: f.clientId, dedupeHash, status: { not: "UNDONE" } }, select: { id: true } });
  if (dup) return { id: dup.id, existed: true, conflict: false, autoAccepted: false };
  let conflictsWithId: string | null = null;
  if (f.fieldKey) {
    const other = await prisma.clientFact.findFirst({ where: { clientId: f.clientId, fieldKey: f.fieldKey, status: "ACCEPTED" }, select: { id: true, body: true } });
    if (other && normalizeTitle(other.body) !== normalizeTitle(body)) conflictsWithId = other.id;
  }
  const scope: FactScope = f.scope ?? (f.projectId ? "PROJECT" : f.monthId ? "MONTH" : "PERMANENT");
  let autoAccepted = false;
  if (f.unattended && f.fieldKey && AUTO_ACCEPT_FIELD_KEYS.has(f.fieldKey) && !NEVER_AUTO_RE.test(f.fieldKey) && !confidential && !conflictsWithId && (f.confidence ?? 0) >= 0.8) {
    autoAccepted = await isAutomationEnabled("fact_extraction");
  }
  const row = await prisma.clientFact.create({
    data: {
      clientId: f.clientId, enrollmentId: f.enrollmentId ?? null, category: f.category, fieldKey: f.fieldKey ?? null, body, source: f.source, sourceRef: f.sourceRef ?? null, callRecordId: f.callRecordId ?? null,
      transcriptSourceId: f.transcriptSourceId ?? null, excerptJson: f.excerpt?.length ? JSON.stringify(f.excerpt).slice(0, 20_000) : null, speaker: f.speaker ?? null, factDate: f.factDate ?? null,
      scope, monthId: f.monthId ?? null, projectId: f.projectId ?? null, status: autoAccepted ? "ACCEPTED" : "PROPOSED", visibility: "INTERNAL",
      aiContext: autoAccepted && !confidential ? "ALLOWED" : "DENIED", confidential, confidence: f.confidence ?? null, conflictsWithId, autoAccepted, reviewedBy: autoAccepted ? "auto" : null, reviewedAt: autoAccepted ? new Date() : null,
      legacyNoteId: f.legacyNoteId ?? null, aiRunId: f.aiRunId ?? null, dedupeHash,
    },
    select: { id: true },
  });
  return { id: row.id, existed: false, conflict: !!conflictsWithId, autoAccepted };
}

/** Accept: ACCEPTED + aiContext ALLOWED (never for a confidential fact). Scope may be set at the same time. */
export async function acceptFact(id: string, by: string, opts: { scope?: FactScope; monthId?: string | null; projectId?: string | null; category?: FactCategory } = {}): Promise<void> {
  const f = await prisma.clientFact.findUnique({ where: { id }, select: { confidential: true, conflictsWithId: true, fieldKey: true, clientId: true } });
  if (!f) throw new Error("Fact not found.");
  // Accepting the newer side of a conflict supersedes the older accepted one — explicitly, by a person.
  if (f.conflictsWithId) {
    await prisma.clientFact.updateMany({ where: { id: f.conflictsWithId, status: "ACCEPTED" }, data: { status: "SUPERSEDED", supersededById: id } });
  }
  await prisma.clientFact.update({
    where: { id },
    data: {
      status: "ACCEPTED", aiContext: f.confidential ? "DENIED" : "ALLOWED", reviewedBy: by, reviewedAt: new Date(), undoneBy: null, undoneAt: null,
      ...(opts.scope ? { scope: opts.scope, monthId: opts.scope === "MONTH" ? opts.monthId ?? null : null, projectId: opts.scope === "PROJECT" ? opts.projectId ?? null : null } : {}),
      ...(opts.category ? { category: opts.category } : {}), supersedesId: f.conflictsWithId ?? undefined, conflictsWithId: null,
    },
  });
}

export async function rejectFact(id: string, by: string): Promise<void> {
  await prisma.clientFact.update({ where: { id }, data: { status: "REJECTED", aiContext: "DENIED", reviewedBy: by, reviewedAt: new Date() } });
}

/** Undo a review: back to PROPOSED / DENIED, with who undid it on the row. A superseded partner comes back too. */
export async function undoFactReview(id: string, by: string): Promise<void> {
  const f = await prisma.clientFact.findUnique({ where: { id }, select: { supersedesId: true, status: true } });
  if (!f) throw new Error("Fact not found.");
  if (f.supersedesId) await prisma.clientFact.updateMany({ where: { id: f.supersedesId, status: "SUPERSEDED", supersededById: id }, data: { status: "ACCEPTED", supersededById: null } });
  await prisma.clientFact.update({ where: { id }, data: { status: "PROPOSED", aiContext: "DENIED", reviewedBy: null, reviewedAt: null, undoneBy: by, undoneAt: new Date(), autoAccepted: false, conflictsWithId: f.supersedesId ?? null, supersedesId: null } });
}

export async function setFactScope(id: string, scope: FactScope, ref: { monthId?: string | null; projectId?: string | null }): Promise<void> {
  await prisma.clientFact.update({ where: { id }, data: { scope, monthId: scope === "MONTH" ? ref.monthId ?? null : null, projectId: scope === "PROJECT" ? ref.projectId ?? null : null } });
}

export async function setFactAiContext(id: string, allowed: boolean, by: string): Promise<void> {
  const f = await prisma.clientFact.findUnique({ where: { id }, select: { confidential: true } });
  if (!f) throw new Error("Fact not found.");
  if (allowed && f.confidential) throw new Error("A confidential fact can never be AI context.");
  await prisma.clientFact.update({ where: { id }, data: { aiContext: allowed ? "ALLOWED" : "DENIED", reviewedBy: by, reviewedAt: new Date() } });
}

export type PromptFact = { id: string; category: FactCategory; body: string; scope: FactScope; factDate: Date | null; source: string; monthId: string | null; projectId: string | null };

/**
 * The ONLY read a generator may use: accepted, AI-allowed, non-confidential
 * facts in scope for this month/project. Reported performance is labelled
 * so no prompt or page can treat it as measured.
 */
export async function factsForPrompt(clientId: string, opts: { monthId?: string | null; projectId?: string | null; take?: number; production?: boolean } = {}): Promise<PromptFact[]> {
  const rows = await prisma.clientFact.findMany({
    where: {
      clientId, status: "ACCEPTED", aiContext: "ALLOWED", confidential: false,
      OR: [{ scope: "PERMANENT" }, ...(opts.monthId ? [{ scope: "MONTH", monthId: opts.monthId }] : []), ...(opts.projectId ? [{ scope: "PROJECT", projectId: opts.projectId }] : [])],
      // Narrowed IN the query, before `take` (review, Sep 24 2026): taking the
      // newest N of every category and filtering afterwards let twenty newer
      // goal or audience facts push every production preference out of the
      // editor's brief without a word.
      ...(opts.production ? { AND: [{ OR: [{ category: "PRODUCTION_PREFERENCE" }, ...(opts.projectId ? [{ scope: "PROJECT", projectId: opts.projectId }] : [])] }] } : {}),
    },
    orderBy: [{ factDate: "desc" }, { createdAt: "desc" }],
    take: opts.take ?? 40,
    select: { id: true, category: true, body: true, scope: true, factDate: true, source: true, monthId: true, projectId: true },
  });
  return rows.map((r) => ({ ...r, category: r.category as FactCategory, scope: r.scope as FactScope }));
}

/** Prompt lines with the category made explicit — "(reported by the client, not verified)" on reported performance. */
export function factLines(facts: PromptFact[]): string[] {
  return facts.map((f) => {
    const tag = f.category === "PERFORMANCE_REPORTED" ? " (reported by the client, not verified)" : f.category === "PERFORMANCE_MEASURED" ? " (measured)" : f.scope !== "PERMANENT" ? ` (${f.scope.toLowerCase()} scope)` : "";
    return `${f.body}${tag}`;
  });
}

/** Accepted production/editing preferences for an editor brief — reaches the editor only once accepted. */
export async function productionFactsForProject(clientId: string, projectId: string | null): Promise<string[]> {
  const facts = await factsForPrompt(clientId, { projectId, take: 20, production: true });
  return factLines(facts.filter((f) => f.category === "PRODUCTION_PREFERENCE" || (f.scope === "PROJECT" && f.projectId === projectId)));
}

/** The "Updated from your latest call" strip: proposed facts newest first, conflicts flagged. */
export async function factsForReview(clientId: string, take = 60) {
  return prisma.clientFact.findMany({ where: { clientId, status: { in: ["PROPOSED", "ACCEPTED", "REJECTED"] } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take });
}

export async function factCounts(clientId: string): Promise<{ proposed: number; accepted: number; rejected: number; conflicts: number; confidential: number }> {
  const [proposed, accepted, rejected, conflicts, confidential] = await Promise.all([
    prisma.clientFact.count({ where: { clientId, status: "PROPOSED" } }),
    prisma.clientFact.count({ where: { clientId, status: "ACCEPTED" } }),
    prisma.clientFact.count({ where: { clientId, status: "REJECTED" } }),
    prisma.clientFact.count({ where: { clientId, conflictsWithId: { not: null }, status: "PROPOSED" } }),
    prisma.clientFact.count({ where: { clientId, confidential: true } }),
  ]);
  return { proposed, accepted, rejected, conflicts, confidential };
}

// ---------------------------------------------------------------------------
// ONE-TIME MIGRATION — ContentNote.intelligence → ClientFact (design §3).
// Read-through, never a bulk edit: every note becomes one PROPOSED fact
// (aiContext DENIED; confidential rows DENIED regardless of status), and the
// note is stamped migratedFactId/migratedAt. legacyNoteId is unique, so a
// rerun creates nothing. Rows are never deleted.
// ---------------------------------------------------------------------------
const MONTH_PREFIX_RE = /^(?:From the )?(\d{4}-\d{2})(?: strategy call)?:\s*/i;

export async function migrateContentNotesToFacts(opts: { limit?: number } = {}): Promise<{ created: number; skipped: number; confidential: number; monthScoped: number }> {
  const notes = await prisma.contentNote.findMany({ where: { migratedFactId: null }, orderBy: { createdAt: "asc" }, take: opts.limit ?? 5000 });
  const enrollments = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } });
  const enrollmentOf = new Map(enrollments.map((e) => [e.clientId, e.id]));
  let created = 0, skipped = 0, confidential = 0, monthScoped = 0;
  for (const n of notes) {
    const already = await prisma.clientFact.findUnique({ where: { legacyNoteId: n.id }, select: { id: true } });
    if (already) { await prisma.contentNote.update({ where: { id: n.id }, data: { migratedFactId: already.id, migratedAt: new Date() } }); skipped++; continue; }
    const isConf = CONFIDENTIAL_RE.test(n.body);
    let text = n.body.replace(CONFIDENTIAL_RE, "").trim();
    const m = MONTH_PREFIX_RE.exec(text);
    let monthId: string | null = null;
    let monthKey: string | null = null;
    if (m) {
      monthKey = m[1];
      text = text.slice(m[0].length).trim();
      const enrollmentId = enrollmentOf.get(n.clientId);
      if (enrollmentId) {
        const month = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey } }, select: { id: true } });
        monthId = month?.id ?? null;
      }
    }
    if (!text) { skipped++; continue; }
    const category: FactCategory = n.intelligence ? classifyFactBody(text) : "INTERNAL";
    const row = await prisma.clientFact.create({
      data: {
        clientId: n.clientId, enrollmentId: enrollmentOf.get(n.clientId) ?? null, category, body: text.slice(0, 4000), source: "note_migration", sourceRef: `ContentNote:${n.id}`,
        speaker: null, factDate: n.createdAt, scope: monthId ? "MONTH" : "PERMANENT", monthId, status: "PROPOSED", visibility: "INTERNAL", aiContext: "DENIED", confidential: isConf, autoAccepted: false,
        legacyNoteId: n.id, dedupeHash: factDedupeHash(text),
      },
      select: { id: true },
    });
    await prisma.contentNote.update({ where: { id: n.id }, data: { migratedFactId: row.id, migratedAt: new Date() } });
    created++;
    if (isConf) confidential++;
    if (monthId) monthScoped++;
  }
  return { created, skipped, confidential, monthScoped };
}
