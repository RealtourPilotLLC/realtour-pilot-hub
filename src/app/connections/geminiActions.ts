"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { saveSecret, getSecret, disconnect as disconnectConn, markError } from "@/lib/integrations/connections";
import { GEMINI_CONNECTION, testGeminiKey } from "@/lib/integrations/gemini";
import { fpsWords, clampFps, clampDailyCap } from "@/lib/videoAnalysisCore";

// ---------------------------------------------------------------------------
// Connections → Gemini (video analysis), Oct 24 2026. Owner only, like every
// credential on this page; a "view as" preview cannot save (requireOwner
// refuses it). The key is tested with a call that generates nothing (it reads
// the model's description); a key that fails is NOT saved. Saved keys are
// encrypted (saveSecret) and never echoed back: the messages carry a label,
// never the value.
// ---------------------------------------------------------------------------

export type GeminiActionResult = { ok: boolean; message: string };

const by = async () => (await getCurrentUser().catch(() => null))?.email ?? null;

export async function saveGeminiKey(_prev: GeminiActionResult | null, formData: FormData): Promise<GeminiActionResult> {
  await requireOwner();
  const key = String(formData.get("key") || "").trim();
  if (!key) return { ok: false, message: "Paste the Gemini API key from Google AI Studio." };
  const test = await testGeminiKey(key);
  if (!test.ok) return { ok: false, message: `Not saved. ${test.error}` };
  const who = await by();
  await saveSecret(GEMINI_CONNECTION, key, { accountLabel: test.label, metadata: { connectedBy: who, connectedAt: new Date().toISOString() } });
  // The clock starts now: only videos that come in from here on are read (no backfill).
  const { markGeminiStarted } = await import("@/lib/videoAnalysis");
  await markGeminiStarted(who);
  revalidatePath("/connections");
  return { ok: true, message: `${test.label}. Saved (encrypted). Covers start with the next approved video; the spelling check starts with the next video in review, visible only to you.` };
}

export async function testGeminiNow(): Promise<GeminiActionResult> {
  await requireOwner();
  const key = await getSecret(GEMINI_CONNECTION);
  if (!key) return { ok: false, message: "No Gemini key is saved." };
  const test = await testGeminiKey(key);
  if (!test.ok) {
    await markError(GEMINI_CONNECTION, test.error).catch(() => {});
    revalidatePath("/connections");
    return { ok: false, message: test.error };
  }
  await saveSecret(GEMINI_CONNECTION, key, { accountLabel: test.label });
  revalidatePath("/connections");
  return { ok: true, message: `${test.label}. Checking reads the model's description: it costs nothing and sends no video.` };
}

export async function disconnectGemini(): Promise<GeminiActionResult> {
  await requireOwner();
  await disconnectConn(GEMINI_CONNECTION);
  revalidatePath("/connections");
  return { ok: true, message: "Gemini key removed. Nothing more is sent to Google; covers already made stay." };
}

export async function saveGeminiOptions(input: { fps: number; dailyCap: number; covers: boolean; spelling: boolean }): Promise<GeminiActionResult> {
  await requireOwner();
  const { saveGvaSettings } = await import("@/lib/videoAnalysis");
  const s = await saveGvaSettings({ fps: clampFps(input.fps), dailyCap: clampDailyCap(input.dailyCap), covers: !!input.covers, spelling: !!input.spelling }, await by());
  revalidatePath("/connections");
  return { ok: true, message: `Saved: ${fpsWords(s.fps)}, at most ${s.dailyCap} requests a day. Covers ${s.covers ? "on" : "off"}, spelling check ${s.spelling ? "on" : "off"}.` };
}
