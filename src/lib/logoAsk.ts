// ---------------------------------------------------------------------------
// THE LOGO THEIR NOTES ASK FOR, AND NONE ON FILE (Oct 16 2026).
//
// About fifteen videos came back over the end card or logo. The brief now
// shows the end card, but when a client's notes ask for their logo and there
// is no file, the editor used to find out at the end of the edit and the
// reviewer at review. Now the job asks Kyle for it the first time the brief
// is opened (by the editor it was assigned to, or the office), through the one
// existing door for "a file the work needs" (assetDependencies: a retrieval
// task on Kyle's list, keyed per job, so a reload, a second editor or a second
// video never raises it twice). The brief and the editor's final check then
// say plainly that Kyle has been asked, or name the file he attached.
// ---------------------------------------------------------------------------

/** The dependency's id (assetDependencies.assetKeys scope: the whole job). */
export const LOGO_ASK_SLUG = "client-logo";
/** The missing reference, in the words Kyle's task and the job's brief print. */
export const LOGO_ASK_NEED = "the client's logo or end card file, which their notes ask for";

const ASKS = /\b(?:logos?|end ?cards?|outro cards?|branding cards?)\b/i;
const DECLINES = /\b(?:no|without|don'?t|do not|never|remove|skip|leave off|leave out)\b[^.!?\n]{0,30}\b(?:logos?|end ?cards?|outro cards?|branding cards?)\b/i;

/** Do any of these notes ASK for a logo or end card? A sentence that turns it
 *  down ("no logo on this one") is not an ask. Pure. */
export function notesAskForLogo(texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((t) =>
    (t ?? "")
      .split(/(?<=[.!?])\s+|\n+/)
      .some((s) => ASKS.test(s) && !DECLINES.test(s)),
  );
}

export type LogoAsk = { state: "asked" | "attached" | "closed"; ref: string | null };

/** Make sure Kyle has been asked for the logo on this job, and say where the
 *  ask stands. Idempotent: one retrieval task per job, ever. `create: false`
 *  only reads (a "view as" preview writes nothing). A failed read or write
 *  answers null, and the brief then says "ask Kyle" as before. */
export async function ensureLogoAsk(projectId: string, opts: { create?: boolean } = {}): Promise<LogoAsk | null> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const { assetKeys, recordAssetDependency } = await import("@/lib/assetDependencies");
    const key = assetKeys(projectId, {}, LOGO_ASK_SLUG).retrieval;
    const read = () => prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { status: true, sourceDetail: true } });
    let row = await read();
    if (!row && opts.create !== false) {
      await recordAssetDependency({ projectId, slug: LOGO_ASK_SLUG, need: LOGO_ASK_NEED, by: "system" });
      row = await read();
    }
    if (!row) return null;
    if (row.status === "COMPLETED") return { state: "attached", ref: row.sourceDetail?.trim() || null };
    if (row.status === "CANCELLED") return { state: "closed", ref: null };
    return { state: "asked", ref: null };
  } catch {
    return null;
  }
}
