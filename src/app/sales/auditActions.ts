"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// Finance → Audit (Oct 24 2026): put the audit's action items on the task
// list now (the daily run does it every morning too), and import Venmo
// statement CSVs (lib/venmoStatement). Owner only; a "view as" preview writes
// nothing (requireRole refuses an impersonated session).
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };

async function ownerOnly(): Promise<Result | null> {
  try { await requireRole(["OWNER"]); return null; } catch (e) { return { ok: false, message: (e as Error).message }; }
}

export async function syncAuditTasksAction(): Promise<Result> {
  const refused = await ownerOnly();
  if (refused) return refused;
  try {
    const { runBooksAudit } = await import("@/lib/financeAuditTasks");
    const r = await runBooksAudit();
    revalidatePath("/sales"); revalidatePath("/"); revalidatePath("/tasks");
    const parts = [r.opened ? `${r.opened} added` : null, r.reopened ? `${r.reopened} reopened` : null, r.closed ? `${r.closed} closed (fixed)` : null].filter(Boolean);
    return { ok: true, message: `${r.open} audit task${r.open === 1 ? "" : "s"} on your list${parts.length ? ` (${parts.join(", ")})` : ""}.` };
  } catch (e) {
    console.warn("audit task sync failed", (e as Error)?.message);
    return { ok: false, message: "That didn't go through. Nothing was changed; try again." };
  }
}

export async function uploadVenmoStatementsAction(form: FormData): Promise<{ ok: boolean; results: Result[] }> {
  const refused = await ownerOnly();
  if (refused) return { ok: false, results: [refused] };
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "text" in f);
  if (!files.length) return { ok: false, results: [{ ok: false, message: "Pick one or more Venmo statement CSV files." }] };
  const { importVenmoStatement } = await import("@/lib/venmoStatement");
  const results: Result[] = [];
  for (const f of files.slice(0, 24)) {
    if (f.size > 3_000_000) { results.push({ ok: false, message: `${f.name}: too big for a Venmo statement.` }); continue; }
    try {
      const r = await importVenmoStatement(await f.text(), { apply: true });
      results.push({ ok: r.ok, message: `${f.name}: ${r.message}` });
    } catch (e) {
      console.warn("venmo import failed", f.name, (e as Error)?.message);
      results.push({ ok: false, message: `${f.name}: couldn't be read. Nothing from it was added.` });
    }
  }
  if (results.some((r) => r.ok)) {
    try { const { runBooksAudit } = await import("@/lib/financeAuditTasks"); await runBooksAudit(); } catch { /* the morning run catches up */ }
    revalidatePath("/sales");
  }
  return { ok: results.every((r) => r.ok), results };
}
