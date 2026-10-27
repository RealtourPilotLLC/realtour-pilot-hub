"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { addOwnerTodo } from "@/app/day/actions";
import { SNOOZE_DAYS, TOPIC_STATE_PREFIX, type TopicState } from "@/lib/ownerTopicsCore";

// ---------------------------------------------------------------------------
// JORDAN'S MOVES ON A TOPIC (Loom, Oct 27 2026: click a topic, then review,
// delegate, make it his task, mark it handled). Owner only. Delegate is the
// one delegation path (the panel's Assign form, keyed to the topic); these
// are the other three, stored as AppSetting `owner_topic:<key>`:
//   · Mark handled  hides the topic until a record it didn't count appears;
//   · Snooze 7 days hides it for a week whatever happens;
//   · Make it my task puts it on his own to-do list (/day) and hides it the
//     way Mark handled does.
// Nothing here touches the records themselves or tells anyone anything.
// ---------------------------------------------------------------------------

const KEY = /^[a-z0-9:_.-]{1,100}$/i;
type Out = { ok: boolean; message: string };

const cleanIds = (ids: unknown) => (Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, 400) : []);

async function save(key: string, state: TopicState): Promise<void> {
  const k = `${TOPIC_STATE_PREFIX}${key}`;
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value, updatedBy: state.by }, update: { value, updatedBy: state.by } });
}

export async function setOwnerTopicState(input: { key: string; state: "handled" | "snoozed" | "reopen"; ids: string[] }): Promise<Out> {
  await requireOwner();
  if (!KEY.test(input.key ?? "")) return { ok: false, message: "That topic isn't one the dashboard knows." };
  const me = await getCurrentUser().catch(() => null);
  const now = new Date();
  if (input.state === "reopen") {
    await prisma.appSetting.deleteMany({ where: { key: `${TOPIC_STATE_PREFIX}${input.key}` } });
    revalidatePath("/");
    return { ok: true, message: "Back on the dashboard." };
  }
  await save(input.key, {
    state: input.state === "snoozed" ? "snoozed" : "handled",
    at: now.toISOString(),
    until: input.state === "snoozed" ? new Date(now.getTime() + SNOOZE_DAYS * 86_400_000).toISOString() : null,
    ids: cleanIds(input.ids),
    by: me?.email ?? null,
  });
  revalidatePath("/");
  return { ok: true, message: input.state === "snoozed" ? `Snoozed for ${SNOOZE_DAYS} days.` : "Marked handled. It comes back if something new turns up." };
}

export async function makeOwnerTopicMyTask(input: { key: string; title: string; summary: string; ids: string[]; lines: string[] }): Promise<Out> {
  await requireOwner();
  if (!KEY.test(input.key ?? "")) return { ok: false, message: "That topic isn't one the dashboard knows." };
  const title = `${input.title}: ${input.summary}`.slice(0, 200);
  const notes = (input.lines ?? []).filter((l) => typeof l === "string").slice(0, 25).map((l) => `- ${l.slice(0, 160)}`).join("\n");
  const r = await addOwnerTodo({ title, notes, priority: "NEXT", sourceNote: `Dashboard topic: ${input.title}`.slice(0, 300) });
  if (r.error || !r.id) return { ok: false, message: r.error ?? "It couldn't be added to your list." };
  const me = await getCurrentUser().catch(() => null);
  await save(input.key, { state: "mine", at: new Date().toISOString(), until: null, ids: cleanIds(input.ids), by: me?.email ?? null });
  revalidatePath("/");
  return { ok: true, message: "On your list in My Day." };
}
