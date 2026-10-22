"use server";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

type Result = { ok: boolean; message: string };

// Paid time off (Oct 22 2026, lib/pto): the owner adds, edits and removes a
// person's days. The bank is 10 service days an agreement year (from Sep 25);
// weekends and the six company holidays never use it. Nothing here touches
// pay: paid time off does not reduce regular pay.

async function actor(): Promise<string> {
  const u = await getCurrentUser().catch(() => null);
  return (u?.impersonating ? u.realName : u?.name)?.trim() || u?.email || "Jordan";
}

/** Add (no `id`) or change (with `id`) one stretch of time off. */
export async function savePto(
  memberId: string,
  input: { id?: string | null; yearKey?: string | null; startKey: string; endKey?: string | null; type: string; fraction?: number; note?: string },
): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const pto = await import("@/lib/pto");
  const member = (await pto.ptoRoster()).find((m) => m.id === memberId);
  if (!member) return { ok: false, message: "Time off is tracked for the people on the creative team terms only." };
  const startKey = input?.startKey;
  const endKey = input?.endKey || startKey;
  if (!pto.isDayKey(startKey) || !pto.isDayKey(endKey)) return { ok: false, message: "Pick the day, or the first and last day." };
  if (endKey < startKey) return { ok: false, message: "The last day is before the first." };
  const year = pto.agreementYearFor(startKey);
  if (endKey > year.endKey) return { ok: false, message: `That runs past the end of the agreement year (${year.label}). Split it at Sep 24.` };
  if (!pto.PTO_TYPES.some((t) => t.key === input.type)) return { ok: false, message: "Pick vacation, personal, sick or family care." };
  const { days, holidays } = pto.serviceDaysIn(startKey, endKey);
  if (days.length === 0) {
    return { ok: false, message: holidays.length ? `${holidays.map((h) => h.name).join(" and ")} is a company holiday: it does not use the bank.` : "Weekends do not use the bank: pick a Monday to Friday." };
  }
  if (days.length > 31) return { ok: false, message: "That is more than 31 service days: check the dates." };
  const fraction = Number(input.fraction ?? 1);
  if (!(pto.PTO_FRACTIONS as readonly number[]).includes(fraction)) return { ok: false, message: "A day is full, three quarters, half or a quarter." };
  if (fraction !== 1 && days.length !== 1) return { ok: false, message: "A partial day is one day: enter it on its own." };
  const note = (input.note ?? "").trim().slice(0, 500);
  const by = await actor();

  // An edit that moves the time off into another agreement year comes out of
  // the old year and goes into the new one.
  const fromYear = input.id ? (pto.isDayKey(input.yearKey ?? "") ? pto.agreementYearFor(input.yearKey!).key : year.key) : null;
  if (input.id && fromYear && fromYear !== year.key) {
    const gone = await pto.updatePto(memberId, fromYear, by, (entries) => {
      const hit = entries.find((e) => e.id === input.id);
      if (!hit) return "That time off is already gone.";
      return { entries: entries.filter((e) => e.id !== input.id), what: `Moved ${pto.rangeLabel(hit.startKey, hit.endKey)} to the next agreement year` };
    });
    if (!gone.ok) return gone;
  }
  const editing = !!input.id && fromYear === year.key;
  const r = await pto.updatePto(memberId, year.key, by, (entries) => {
    const overlap = entries.find((e) => e.id !== input.id && e.startKey <= endKey && e.endKey >= startKey);
    if (overlap) return `That overlaps ${pto.rangeLabel(overlap.startKey, overlap.endKey)} already on file.`;
    const now = new Date().toISOString();
    if (editing) {
      const i = entries.findIndex((e) => e.id === input.id);
      if (i < 0) return "That time off is already gone.";
      entries[i] = { ...entries[i], startKey, endKey, type: input.type as never, fraction, note, editedBy: by, editedAt: now };
      return { entries, what: `Changed to ${pto.rangeLabel(startKey, endKey)} (${input.type}${fraction !== 1 ? `, ${fraction} day` : ""})` };
    }
    entries.push({ id: input.id || crypto.randomUUID(), startKey, endKey, type: input.type as never, fraction, note, by, at: now });
    return { entries, what: `Added ${pto.rangeLabel(startKey, endKey)} (${input.type}${fraction !== 1 ? `, ${fraction} day` : ""})` };
  });
  if (!r.ok) return r;
  const bal = await pto.ptoBalance(memberId, member.name, year.key);
  revalidatePath("/sales");
  revalidatePath("/my-pay");
  const used = days.length * (days.length === 1 ? fraction : 1);
  return {
    ok: true,
    message: `${editing ? "Saved" : "Added"}: ${used} day${used === 1 ? "" : "s"}${holidays.length ? ` (${holidays.map((h) => h.name).join(", ")} skipped)` : ""}. ${bal.remaining} of ${bal.bank} left this agreement year${bal.over ? `; ${bal.over} over the paid bank` : ""}.`,
  };
}

export async function removePto(memberId: string, yearKey: string, id: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const pto = await import("@/lib/pto");
  if (!pto.isDayKey(yearKey) || typeof id !== "string" || !id) return { ok: false, message: "Bad entry." };
  const by = await actor();
  const r = await pto.updatePto(memberId, pto.agreementYearFor(yearKey).key, by, (entries) => {
    const hit = entries.find((e) => e.id === id);
    if (!hit) return "That time off is already gone.";
    return { entries: entries.filter((e) => e.id !== id), what: `Removed ${pto.rangeLabel(hit.startKey, hit.endKey)}` };
  });
  if (!r.ok) return r;
  revalidatePath("/sales");
  revalidatePath("/my-pay");
  return { ok: true, message: "Removed." };
}
