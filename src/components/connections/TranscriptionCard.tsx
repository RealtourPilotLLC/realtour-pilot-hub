"use client";

import { useActionState, useState, useTransition } from "react";
import { AudioLines, CheckCircle2, Circle, AlertCircle, Loader2, PowerOff } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import {
  saveTranscriptionKey,
  testTranscriptionNow,
  disconnectTranscription,
  type IntegrationActionResult,
} from "@/app/connections/integrationActions";

// ---------------------------------------------------------------------------
// Speech-to-text for cut transcripts (spec §9), Sep 16 2026. Two providers,
// one key each; pick one, paste, Test, save (encrypted). Saving is allowed
// tonight because it only makes the provider "configured" — the
// cut_transcripts switch is a separate thing this card cannot flip, and it
// says so in plain words so a saved key is never mistaken for a running
// automation.
// ---------------------------------------------------------------------------

export type TranscriptionProviderState = {
  id: "deepgram" | "openai_whisper";
  label: string;
  /** A key exists, decrypts, and its last check passed — a driver would use it. */
  configured: boolean;
  /** An encrypted key is in the row (true also when the last check FAILED). */
  stored: boolean;
  accountLabel: string | null;
  savedAt: string | null;
  lastError: string | null;
};

export type TranscriptionCardProps = {
  providers: TranscriptionProviderState[];
  /** Which provider a run would use (Deepgram first when both are saved). */
  activeProviderId: string | null;
  automation: { enabled: boolean; missing: boolean };
  /** Requests waiting for a provider / the switch. */
  waiting: number;
};

const KEY_HELP: Record<TranscriptionProviderState["id"], string> = {
  deepgram: "console.deepgram.com → API Keys → Create. Deepgram fetches the cut from the hub's store itself, with no size ceiling that a client cut would hit — the better fit. Test only lists your projects.",
  openai_whisper: "platform.openai.com → API keys → Create (starts with sk-). Whisper takes the file as an upload capped at 25 MB per request, so 4K exports may not fit. Test only lists models.",
};

export function TranscriptionCard({ providers, activeProviderId, automation, waiting }: TranscriptionCardProps) {
  const anyConfigured = providers.some((p) => p.configured);
  const [choice, setChoice] = useState<TranscriptionProviderState["id"]>(providers.find((p) => !p.configured)?.id ?? "deepgram");
  const [state, action, pending] = useActionState(saveTranscriptionKey, null);
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<IntegrationActionResult | null>(null);

  return (
    <div className="rounded-2xl border bg-surface p-4" data-card="transcription">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: "#0ea5e91a", color: "#0369a1" }}>
          <AudioLines className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Speech-to-text</span>
            {anyConfigured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <CheckCircle2 className="size-3" /> Key saved
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                <Circle className="size-3" /> Not connected
              </span>
            )}
          </div>
          <p className="text-xs text-muted">Transcribes each approved cut so captions describe what was actually said (spec §9)</p>
        </div>
      </div>

      {/* The switch, separately and loudly. A saved key is not a running
          automation; nothing transcribes until Jordan turns this on. */}
      <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${automation.enabled ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
        <PowerOff className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {automation.enabled
            ? "Cut transcripts are switched ON — queued requests run on the next pass."
            : automation.missing
              ? "Cut transcripts are switched OFF (never turned on). Saving a key here does not start anything; requests wait until the switch is on."
              : "Cut transcripts are switched OFF. Saving a key here does not start anything; requests wait until the switch is on."}
          {waiting > 0 && ` ${waiting} request${waiting === 1 ? "" : "s"} waiting.`}
        </span>
      </div>

      <ul className="mt-3 space-y-1.5">
        {providers.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            {p.configured ? <CheckCircle2 className="size-3 shrink-0 text-success" /> : <Circle className="size-3 shrink-0 text-muted-2" />}
            <span className="font-medium">{p.label}</span>
            {p.configured ? (
              <span className="text-muted">
                {p.accountLabel ?? "key saved"}
                {p.savedAt && ` · saved ${etDateTime(p.savedAt)}`}
                {activeProviderId === p.id && <span className="ml-1 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">would be used</span>}
              </span>
            ) : p.stored ? (
              // The key is still there, its last check failed: it will not be
              // used, and the person can re-test (a passing test restores it)
              // or remove it.
              <span className="text-warning">key saved — failing check, not in use</span>
            ) : (
              <span className="text-muted">no key</span>
            )}
            {p.lastError && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertCircle className="size-3" /> {p.lastError}
              </span>
            )}
            {p.stored && (
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => startTransition(async () => setMsg(await testTranscriptionNow(p.id)))}
                  disabled={busy}
                  className="text-[11px] font-medium text-brand hover:underline disabled:opacity-60"
                  title="Re-checks the saved key with a list call. Transcribes nothing, costs nothing."
                >
                  Test
                </button>
                <button
                  onClick={() => startTransition(async () => setMsg(await disconnectTranscription(p.id)))}
                  disabled={busy}
                  className="text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60"
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}

      <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
        <div className="flex gap-2">
          {providers.map((p) => (
            <label key={p.id} className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium ${choice === p.id ? "border-brand bg-brand/10 text-brand" : "hover:bg-surface"}`}>
              <input type="radio" name="provider" value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} className="sr-only" />
              {p.label}
            </label>
          ))}
        </div>
        <input
          name="key"
          type="password"
          autoComplete="off"
          placeholder={`Paste the ${providers.find((p) => p.id === choice)?.label ?? ""} API key`}
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <p className="text-[11px] text-muted">{KEY_HELP[choice]} The key is encrypted before it is stored and never shown again. A key that fails the test is not saved.</p>
        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Test &amp; save key
        </button>
        {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
      </form>
    </div>
  );
}
