"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin } from "@/lib/auth/guards";
import { editorRouting, putSetting, ROUTABLE_EDITORS, type EditorRoutingRules } from "@/lib/settings";
import type { EditorKey } from "@/lib/editors";

// Settings writes: owner or admin (Kyle) — requireAdmin is the house guard
// (blocks view-as, passes sessionless local dev, always enforced in prod).
async function requireSettingsActor() {
  await requireAdmin();
  return getCurrentUser().catch(() => null);
}

const parseKey = (v: string): EditorKey | null =>
  v === "manual" ? null : (ROUTABLE_EDITORS as string[]).includes(v) ? (v as EditorKey) : null;

export async function saveEditorRouting(input: {
  standardVideo: string;
  premiumVideo: string;
  personalBranding: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    const rules: EditorRoutingRules = {
      standardVideo: parseKey(input.standardVideo),
      premiumVideo: parseKey(input.premiumVideo),
      personalBranding: parseKey(input.personalBranding),
    };
    await putSetting("editor_routing", rules, me?.email ?? null);
    revalidatePath("/settings");
    revalidatePath("/editing");
    return { ok: true, message: "Routing updated — new jobs follow these rules within a minute." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function loadEditorRouting(): Promise<EditorRoutingRules> {
  await requireSettingsActor();
  return editorRouting();
}
