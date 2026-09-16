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
  topazSettings, saveTopazSettings, type TopazSettings,
} from "@/lib/settings";
import type { EditorKey } from "@/lib/editors";
import { NOTIFY_EVENTS, clearInapplicable, parseNotifyPrefs, type NotifyPrefs } from "@/lib/notifyPrefDefaults";
import { staffTextNumber } from "@/lib/hubSms";

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

// ---- Team notifications (Jordan, Sep 15: "I should be able to manage team
// notifications in settings") ---------------------------------------------
// Replaces the Sep 11 owner-only "Text me" save: every active person is a
// row now, the owner included, and the same store (notify-prefs:<id>) is what
// the bridge in notify.ts reads on the next bell row — no cron, no wait. Owner
// or admin (Kyle): a switch on the wrong row would text or DM the wrong
// person, so the id is checked against the roster before anything is written.
export async function saveTeamNotifyPrefs(teamMemberId: string, prefs: NotifyPrefs): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireSettingsActor();
    if (typeof teamMemberId !== "string" || !/^[a-z0-9_-]{8,64}$/i.test(teamMemberId)) {
      return { ok: false, message: "That row doesn't point at a person — reload and try again." };
    }
    const parsed = parseNotifyPrefs(prefs);
    if (!parsed) return { ok: false, message: "Something's off with what was sent — reload the page and try again." };
    const { prisma } = await import("@/lib/prisma");
    const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true, slackId: true, phone: true } });
    if (!member) return { ok: false, message: "That person isn't on the roster any more." };
    const first = member.name.split(/\s+/)[0];
    const { saveNotifyPrefs, notifyGroupFor } = await import("@/lib/notifyPrefs");
    // Sep 16 (Kyle call): the store may only hold switches an emitter can
    // actually fire for this person's group — the card greys the rest out, and
    // clearing them here means a stale tab or a hand-rolled call can't plant a
    // switch that looks on forever and never rings (Kyle's "Video in review"
    // was exactly that until the broadcast bridge learned to reach the office).
    const group = await notifyGroupFor(teamMemberId).catch(() => null);
    const clean = group ? clearInapplicable(parsed, group) : parsed;
    await saveNotifyPrefs(teamMemberId, clean, me?.email ?? null);
    revalidatePath("/settings");
    const onSlack = NOTIFY_EVENTS.filter((e) => clean[e.key].slack).map((e) => e.short.toLowerCase());
    const onSms = NOTIFY_EVENTS.filter((e) => clean[e.key].sms).map((e) => e.short.toLowerCase());
    const parts: string[] = [];
    if (onSlack.length) parts.push(`Slack: ${onSlack.join(", ")}${member.slackId ? "" : " (once a Slack ID is on the card)"}`);
    // The same number rule the sender applies (a US/Canada line) — a +63 on
    // the roster is "no phone" to the text bridge, and the message says so.
    if (onSms.length) parts.push(`texts: ${onSms.join(", ")}${staffTextNumber(member.phone) ? "" : " (once a US phone is on the roster)"}`);
    const summary = parts.length ? parts.join(" · ") : "bell only";
    return {
      ok: true,
      message: `Saved for ${first} — ${summary}. Applies from the next ping.`,
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

// ---- The 1080p video pass (Topaz) -----------------------------------------
// Owner or admin, like every other rule on this page. The real guard is not the
// door, though — it is saveTopazSettings(), which range-checks every field on
// the way in AND on the way out, so nothing typed into a box (or posted by a
// stale tab) can put an out-of-range number in front of an API that charges
// per render. The clamped result is returned so the form can re-seed from what
// was actually stored rather than from what was typed.
export async function saveTopazRules(
  input: TopazSettings,
): Promise<{ ok: boolean; message: string; settings?: TopazSettings }> {
  try {
    const me = await requireSettingsActor();
    const saved = await saveTopazSettings(input, me?.email ?? null);
    revalidatePath("/settings");
    revalidatePath("/connections");
    // Say what the setting now MEANS, not "saved" — the switch being off is the
    // one thing somebody could change here and then wait forever on.
    const message = !saved.enabled
      ? "Saved. The 1080p pass is switched off, so approving a cut queues nothing — everything else about approving and delivering carries on as normal."
      : saved.deliverableTypes.length === 0
        ? "Saved, but no kind of video is ticked, so nothing will be sent. Tick videos, reels or both."
        : `Saved — the next cut you approve goes through at ${saved.outputShortSide}p, up to ${saved.maxCreditsPerVideo} credits a video and ${saved.maxCreditsPerMonth} a month.`;
    return { ok: true, message, settings: saved };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function loadTopazRules(): Promise<TopazSettings> {
  await requireSettingsActor();
  return topazSettings();
}
