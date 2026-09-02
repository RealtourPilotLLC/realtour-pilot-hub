"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin } from "@/lib/auth/guards";
import {
  editorRouting, putSetting, ROUTABLE_EDITORS, autoTextRules, DEFAULT_AUTO_TEXTS,
  turnaroundRules, internalAlertRules, textTemplates,
  type EditorRoutingRules, type AutoTextRules, type TurnaroundRules,
  type InternalAlertRules, type TextTemplates,
  reviewRoomRules, type ReviewRoomRules,
} from "@/lib/settings";
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

// ---- Automated client texts (Jordan, Sep 1) --------------------------------
// The sweeps read these on every cron tick, so a change lands within a minute
// and OFF stops the next tick. Values are clamped again in autoTextRules() —
// this saves what the form sent; that guards what the sender trusts.
export async function saveAutoTextRules(input: AutoTextRules): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    const from = Math.min(23, Math.max(0, Math.round(input.sendFromHour)));
    const until = Math.min(24, Math.max(from + 1, Math.round(input.sendUntilHour)));
    const rules: AutoTextRules = {
      enabled: !!input.enabled,
      sendFromHour: from,
      sendUntilHour: until,
      confirmation: {
        enabled: !!input.confirmation?.enabled,
        hoursBefore: Math.min(168, Math.max(1, Math.round(input.confirmation?.hoursBefore ?? DEFAULT_AUTO_TEXTS.confirmation.hoursBefore))),
      },
      delivery: {
        enabled: !!input.delivery?.enabled,
        maxTaskAgeHours: Math.min(720, Math.max(1, Math.round(input.delivery?.maxTaskAgeHours ?? DEFAULT_AUTO_TEXTS.delivery.maxTaskAgeHours))),
        requireMonthlyBatch: !!input.delivery?.requireMonthlyBatch,
      },
      skipWhenClientWaiting: !!input.skipWhenClientWaiting,
      onePerClientPerRun: !!input.onePerClientPerRun,
      // Carried through explicitly: this action rebuilds the object field by
      // field, so anything omitted here is silently dropped on every save.
      ...(input.sendUntilMinute != null ? { sendUntilMinute: Math.min(59, Math.max(0, Math.round(input.sendUntilMinute))) } : {}),
      ...(input.weekdaysOnly != null ? { weekdaysOnly: !!input.weekdaysOnly } : {}),
      ...(input.afterHours ? { afterHours: input.afterHours } : {}),
    };
    await putSetting("auto_texts", rules, me?.email ?? null);
    revalidatePath("/settings");
    return { ok: true, message: "Saved — the next hourly run follows these rules." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function loadAutoTextRules(): Promise<AutoTextRules> {
  await requireSettingsActor();
  return autoTextRules();
}

// ---- Turnaround promises ---------------------------------------------------
export async function saveTurnarounds(input: TurnaroundRules): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    await putSetting("turnarounds", input, me?.email ?? null);
    revalidatePath("/settings");
    return { ok: true, message: "Saved — new work uses these promises; existing due dates re-sync on the next hourly run." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
export async function loadTurnarounds(): Promise<TurnaroundRules> {
  await requireSettingsActor();
  return turnaroundRules();
}

// ---- Internal alerts -------------------------------------------------------
export async function saveInternalAlerts(input: InternalAlertRules): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    await putSetting("internal_alerts", input, me?.email ?? null);
    revalidatePath("/settings");
    return { ok: true, message: "Saved — the next run follows these rules." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
export async function loadInternalAlerts(): Promise<InternalAlertRules> {
  await requireSettingsActor();
  return internalAlertRules();
}

// ---- Review Room -----------------------------------------------------------
export async function saveReviewRoomRules(input: ReviewRoomRules): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    await putSetting("review_room", input, me?.email ?? null);
    revalidatePath("/settings");
    return { ok: true, message: "Saved — the next hourly run follows these rules." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
export async function loadReviewRoomRules(): Promise<ReviewRoomRules> {
  await requireSettingsActor();
  return reviewRoomRules();
}

// ---- Client text wording ---------------------------------------------------
export async function saveTextTemplates(input: TextTemplates): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    await putSetting("text_templates", input, me?.email ?? null);
    revalidatePath("/settings");
    return { ok: true, message: "Saved — the next automated text uses this wording." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
export async function loadTextTemplates(): Promise<TextTemplates> {
  await requireSettingsActor();
  return textTemplates();
}
