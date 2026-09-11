"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
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
      // The welcome text (Jordan, Sep 7). Stored trimmed and bounded; a blank
      // message is saved as blank on purpose, because autoTextRules() reads an
      // empty box as "use the built-in wording" rather than as an empty text.
      ...(input.welcome
        ? {
            welcome: {
              enabled: !!input.welcome.enabled,
              strategyCallUrl: String(input.welcome.strategyCallUrl ?? "").trim().slice(0, 300),
              message: String(input.welcome.message ?? "").slice(0, 1000),
            },
          }
        : {}),
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

// ---- The owner's texts (Jordan, Sep 11: "make sure I get a text when a video
// is in review or I'm mentioned in a chat") -----------------------------------
// Owner only — this is HIS phone. The row is keyed on the owner's own
// TeamMember, resolved server-side from the login (never from the form), and
// the bridge in notify.ts reads it on the next bell row: no cron, no wait.
export async function saveOwnerSmsPrefs(input: { reviewReady: boolean; mention: boolean }): Promise<{ ok: boolean; message: string }> {
  try {
    await requireOwner();
    const me = await getCurrentUser().catch(() => null);
    const { ownerSmsSettings, smsPrefsKey } = await import("@/lib/smsPrefs");
    const { teamMemberId } = await ownerSmsSettings(me ? { teamMemberId: me.teamMemberId, email: me.email } : null);
    if (!teamMemberId) {
      return { ok: false, message: "Your login isn't linked to a team-member row yet — add your number on People first." };
    }
    const kinds = [...(input.reviewReady ? ["review_ready" as const] : []), ...(input.mention ? ["mention" as const] : [])];
    await putSetting(smsPrefsKey(teamMemberId), { kinds }, me?.email ?? null);
    revalidatePath("/settings");
    return {
      ok: true,
      message: kinds.length === 0 ? "Saved — no texts; the bell still rings." : "Saved — the next one texts you (7 AM–10 PM ET; later ones wait for the morning).",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
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
  // A box that still reads exactly the built-in wording is not an override —
  // store it empty so the built-in composer (which can also drop " for
  // {items}" on a job with none) stays in charge (Jordan, Sep 7: the boxes
  // now SHOW the current wording instead of sitting empty).
  const { BUILTIN_TEMPLATE_TEXT } = await import("@/lib/settings");
  for (const key of ["confirmation", "deliveryAll", "deliveryPartial"] as const) {
    if ((input as Record<string, unknown>)[key] === BUILTIN_TEMPLATE_TEXT[key]) (input as Record<string, unknown>)[key] = "";
  }

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
