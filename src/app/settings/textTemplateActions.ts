"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { isTextTemplateKey } from "@/lib/textTemplates";
import { resetTextTemplate, saveTextTemplate, textTemplateRows, type TextTemplateRow } from "@/lib/textTemplateStore";

// ---------------------------------------------------------------------------
// Settings → Text messages (Oct 21 2026). OWNER only to change: these are the
// words every client and every teammate receives without anyone pressing send.
// Kyle (admin) reads the same card. Each action answers with the template's
// fresh row so the card shows exactly what was stored, and who stored it.
// ---------------------------------------------------------------------------

export type TextTemplateActionResult = { ok: boolean; message: string; problems?: string[]; row?: TextTemplateRow };

async function ownerOrRefusal(): Promise<{ by: { email: string | null; name: string | null } } | { refused: string }> {
  try {
    await requireOwner();
  } catch (e) {
    return { refused: e instanceof Error ? e.message : "Only Jordan can change the text wording." };
  }
  const me = await getCurrentUser().catch(() => null);
  return { by: { email: me?.email ?? null, name: me?.name ?? null } };
}

async function rowFor(key: string): Promise<TextTemplateRow | undefined> {
  return (await textTemplateRows().catch(() => [])).find((r) => r.key === key);
}

export async function saveTextTemplateAction(key: string, body: string): Promise<TextTemplateActionResult> {
  const who = await ownerOrRefusal();
  if ("refused" in who) return { ok: false, message: who.refused };
  if (!isTextTemplateKey(key)) return { ok: false, message: "That text is not one the hub sends." };
  try {
    const r = await saveTextTemplate(key, typeof body === "string" ? body : "", who.by);
    revalidatePath("/settings");
    return r.ok ? { ok: true, message: r.message, row: await rowFor(key) } : { ok: false, message: r.message, problems: r.problems };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn’t save. Try again." };
  }
}

export async function resetTextTemplateAction(key: string): Promise<TextTemplateActionResult> {
  const who = await ownerOrRefusal();
  if ("refused" in who) return { ok: false, message: who.refused };
  if (!isTextTemplateKey(key)) return { ok: false, message: "That text is not one the hub sends." };
  try {
    await resetTextTemplate(key, who.by);
    revalidatePath("/settings");
    return { ok: true, message: "Back to the default wording.", row: await rowFor(key) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn’t reset. Try again." };
  }
}
