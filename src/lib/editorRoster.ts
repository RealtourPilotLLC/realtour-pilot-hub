import "server-only";
import { prisma } from "@/lib/prisma";
import { applyEditorRoster } from "@/lib/editors";

// ---------------------------------------------------------------------------
// The editors onboarded on People, read into lib/editors' roster (Oct 30
// 2026). Called where a request begins: getCurrentUser (every page and server
// action), editorRouting (every routing decision) and the cron runner. A 60 s
// cache per lambda, like the settings: an editor added on one lambda reaches
// the others within a minute, and the lambda that saved her refreshes at once.
// A failed read keeps the last good roster; it never throws into the caller.
// ---------------------------------------------------------------------------

const TTL = 60_000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export async function ensureEditorRoster(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - loadedAt < TTL) return;
  if (inflight && !opts.force) return inflight;
  const run = (async () => {
    try {
      const rows = await prisma.teamMember.findMany({
        where: { editorKey: { not: null } },
        select: { editorKey: true, name: true, active: true, timezone: true },
        orderBy: { createdAt: "asc" },
      });
      applyEditorRoster(rows.map((r) => ({ key: r.editorKey as string, name: r.name, active: r.active, timezone: r.timezone })));
      loadedAt = Date.now();
    } catch {
      /* keep the last good roster */
    } finally {
      inflight = null;
    }
  })();
  inflight = run;
  return run;
}
