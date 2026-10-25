"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canSeeMoney } from "@/lib/auth/access";

import { getTaskHistory, getDeliveryHistory, getShootHistory } from "@/lib/queries";
import { etAt, etDayStartUtc } from "@/lib/datetime";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { scrubMoney } from "@/lib/text";

// AI recap of one ET calendar day, built from that day's completed tasks,
// deliveries, and shoots. On-demand (a button on the history page) to keep AI
// cost down. Friendly task-type names so the recap reads cleanly.
const TYPE_NAME: Record<string, string> = {
  media_qa: "QC", client_reply: "client reply", comms_followup: "job instruction",
  confirmation_text: "confirmation text", delivery: "delivery prep", delivery_text: "delivery text",
  revision: "revision", vendor_update: "vendor update", image_fixes: "photo fixes", internal_instruction: "team task",
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3_600_000;

export async function summarizeDay(dayKey: string, opts: { includeTest?: boolean } = {}): Promise<{ ok: boolean; text?: string; message?: string }> {
  await requireAdmin(); // costs an AI call — staff only
  if (typeof dayKey !== "string" || !DAY_KEY.test(dayKey)) return { ok: false, message: "Pick a day." };
  // No money for anyone but the owner (Oct 20 2026, audit A1): the ledger this
  // button sits on scrubs task titles for a non-owner (DoneView), and the
  // recap is the same titles in a paragraph, so both what the model reads and
  // what it writes back pass the same scrub. Sessionless = owner, as there.
  const me = await getCurrentUser().catch(() => null);
  const clean = (s: string) => (!me || canSeeMoney(me.role) ? s : scrubMoney(s));
  const excludeClientIds = opts.includeTest ? []
    : await syntheticClientIds();
  // That one ET day, not the last 120 (audit A4). Noon plus a day lands inside
  // the next ET day whatever the clocks did overnight.
  const noon = etAt(dayKey, 12);
  const oneDay = { excludeClientIds, since: etDayStartUtc(noon), until: etDayStartUtc(new Date(noon.getTime() + 24 * HOUR)) };
  const [dt, dd, ds] = await Promise.all([
    // The ledger's rows for this reader: the owner's books-audit items and pay
    // questions are in nobody else's recap (audit Oct 25 2026, F7).
    getTaskHistory(0, { ...oneDay, hideOwnerPrivate: !!me && !canSeeMoney(me.role) }),
    getDeliveryHistory(0, oneDay),
    getShootHistory(0, oneDay),
  ]);
  if (!dt.length && !dd.length && !ds.length) return { ok: false, message: "Nothing recorded that day." };

  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to generate recaps." };

  try {
    const { summarizeWorkday } = await import("@/lib/integrations/ai");
    const text = await summarizeWorkday({
      date: dayKey,
      tasks: dt.map((t) => ({ type: TYPE_NAME[t.taskType] ?? t.taskType.replace(/_/g, " "), title: clean(t.clientName ? `${t.title} (${t.clientName})` : t.title) })),
      deliveries: dd.map((d) => clean(d.clientName ? `${d.title} (${d.clientName})` : d.title)),
      shoots: ds.map((s) => ({ title: clean(s.title), time: s.time, photographer: s.photographer })),
    });
    return { ok: true, text: clean(text) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not generate a recap." };
  }
}
