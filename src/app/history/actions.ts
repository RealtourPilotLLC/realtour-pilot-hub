"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { getTaskHistory, getDeliveryHistory, getShootHistory } from "@/lib/queries";
import { etDayKey } from "@/lib/datetime";

// AI recap of one ET calendar day, built from that day's completed tasks,
// deliveries, and shoots. On-demand (a button on the history page) to keep AI
// cost down. Friendly task-type names so the recap reads cleanly.
const TYPE_NAME: Record<string, string> = {
  media_qa: "QC", client_reply: "client reply", comms_followup: "job instruction",
  confirmation_text: "confirmation text", delivery: "delivery prep", delivery_text: "delivery text",
  revision: "revision", vendor_update: "vendor update", image_fixes: "photo fixes", internal_instruction: "team task",
};

export async function summarizeDay(dayKey: string): Promise<{ ok: boolean; text?: string; message?: string }> {
  await requireAdmin(); // costs an AI call — staff only
  const [tasks, deliveries, shoots] = await Promise.all([
    getTaskHistory(120),
    getDeliveryHistory(120),
    getShootHistory(120),
  ]);
  const dt = tasks.filter((t) => etDayKey(new Date(t.completedAt)) === dayKey);
  const dd = deliveries.filter((d) => etDayKey(new Date(d.deliveredAt)) === dayKey);
  const ds = shoots.filter((s) => etDayKey(new Date(s.at)) === dayKey);
  if (!dt.length && !dd.length && !ds.length) return { ok: false, message: "Nothing recorded that day." };

  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to generate recaps." };

  try {
    const { summarizeWorkday } = await import("@/lib/integrations/ai");
    const text = await summarizeWorkday({
      date: dayKey,
      tasks: dt.map((t) => ({ type: TYPE_NAME[t.taskType] ?? t.taskType.replace(/_/g, " "), title: t.clientName ? `${t.title} (${t.clientName})` : t.title })),
      deliveries: dd.map((d) => (d.clientName ? `${d.title} (${d.clientName})` : d.title)),
      shoots: ds.map((s) => ({ title: s.title, time: s.time, photographer: s.photographer })),
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not generate a recap." };
  }
}
