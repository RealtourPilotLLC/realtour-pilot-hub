"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  MailPlus,
  RadioTower,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  generateAryeoWebhookSecret,
  armAryeoChecking,
  stopAryeoChecking,
  retireAryeoWebhookSecret,
  type ActionResult,
} from "@/app/connections/webhookActions";

// ---------------------------------------------------------------------------
// GETTING ARYEO BACK ON THE AIR — the owner's half, on one card.
//
// Everything the hub could do by itself is done by itself. What is left needs
// hands: the endpoint address and a secret have to get INTO Aryeo, and Aryeo's
// own docs say custom webhook setup may have to go through their support team.
// So this card is three things and nothing else — make a secret, put it into
// Aryeo (with a message ready to send if support has to do it), then turn
// checking on — and it never asks anyone to compose, look up or remember a
// value. The secret is shown exactly once, so the copy button is next to it.
//
// The honesty rule on this card: it says how long Aryeo has actually been
// silent, and it says the hourly catch-up is covering — because "nothing is
// being lost" is the reason nobody noticed for eight days, and pretending
// otherwise would be the same mistake from the other end.
// ---------------------------------------------------------------------------

export type CutoverState = {
  endpointUrl: string;
  supportMessage: string;
  events: readonly string[];
  /** null when no secret is stored at all. */
  armMode: "watching" | "armed" | "holding" | null;
  secretStored: boolean;
  secretReadable: boolean;
  /** When the stored secret was last written — "the one saved on 8 Sep". */
  secretSavedAt: string | null;
  lastDeliveredAt: string | null;
  quietHours: number | null;
  quietThresholdHours: number;
  /** Last time the half-past-the-hour catch-up finished a full pass of Aryeo. */
  reconcileLastCompletedAt: string | null;
  /** The header name to give Aryeo if their support can only offer a custom
   *  header rather than body signing. */
  tokenHeader: string;
  /** The OTHER switch: what the receiver does when NO secret is saved. It is
   *  never consulted while a secret is stored, so it is invisible most of the
   *  time — and then decides everything the moment the secret is removed. This
   *  card has a button that removes the secret, so it has to know. */
  enforcedWhenNoSecret: boolean;
};

export function AryeoCutover({ state }: { state: CutoverState }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [showSupport, setShowSupport] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);

  const silent = state.quietHours !== null && state.quietHours >= state.quietThresholdHours;
  const days = state.quietHours !== null ? Math.floor(state.quietHours / 24) : 0;

  return (
    <section className="rounded-2xl border-2 border-brand/40 bg-surface p-4">
      <div className="mb-1 flex items-center gap-2">
        <RadioTower className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Aryeo real-time feed — getting it back on</h2>
      </div>
      <p className="mb-3 text-[11px] text-muted-2">
        Aryeo doesn&apos;t hand out a signing secret; it lets you choose any string you like. So the hub makes one, you put it into
        Aryeo, and the hub starts checking it — in that order, and never before.
      </p>

      {/* 1. WHERE THINGS STAND. The silence, in days, from the last real
          delivery — and the honest note that the catch-up is covering. */}
      <div
        className={`rounded-xl border p-3 ${silent ? "border-danger/50 bg-danger-soft" : "border-border bg-surface-2/50"}`}
      >
        <div className="flex items-start gap-2">
          {silent ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          )}
          <div className="text-sm">
            {state.lastDeliveredAt ? (
              <p className={silent ? "font-medium text-danger" : "font-medium"}>
                {silent ? "Aryeo has stopped sending us anything live." : "Aryeo is delivering."} The last event it sent us arrived{" "}
                {etDateTime(state.lastDeliveredAt)}
                {state.quietHours !== null && (
                  <>
                    {" — "}
                    {days >= 2 ? `${days} days ago` : `${state.quietHours} hours ago`}
                  </>
                )}
                .
              </p>
            ) : (
              <p className="font-medium text-danger">Nothing from Aryeo is on record in the last 30 days.</p>
            )}
            <p className="mt-1 text-muted">
              Nothing is being lost while it&apos;s quiet. The hub asks Aryeo for orders and appointments at half past every hour and
              works through the whole history on a loop
              {state.reconcileLastCompletedAt
                ? ` — it last finished a complete pass ${etDateTime(state.reconcileLastCompletedAt)}`
                : ""}
              . New jobs still appear; they just turn up up to an hour late instead of within seconds, and the things that only the
              live feed does — a shoot confirmation the moment it&apos;s booked, a delivery flipping a job to QC — wait for that hour.
            </p>
          </div>
        </div>
      </div>

      {/* 2. THE CURRENT SETTING, in a sentence rather than a switch position. */}
      <div className="mt-3">
        <StateLine state={state} />
      </div>

      {/* 3. THE THREE STEPS. */}
      <ol className="mt-3 space-y-3">
        <Step n={1} title="Make a secret" done={state.secretStored}>
          <p className="text-[11px] text-muted">
            The hub picks a long random string. It&apos;s shown once, here, and never again — it&apos;s stored locked up, the same way
            your API keys are. Making a new one doesn&apos;t interrupt anything: Aryeo&apos;s posts keep being accepted exactly as they
            are today.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                start(async () => {
                  const r = await generateAryeoWebhookSecret();
                  setMsg({ ok: r.ok, message: r.message });
                  if (r.secret) setSecret(r.secret);
                })
              }
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {state.secretStored ? "Make a new secret" : "Make a secret"}
            </button>
            {state.secretStored && !secret && (
              <span className="text-[11px] text-muted">
                A secret is already saved
                {state.secretSavedAt ? ` (from ${etDateTime(state.secretSavedAt)})` : ""}. It can&apos;t be shown again — if you
                don&apos;t have a copy of it, make a new one.
              </span>
            )}
          </div>

          {secret && (
            <div className="mt-2 rounded-xl border-2 border-warning/60 bg-warning-soft p-3">
              <div className="flex items-center gap-2">
                <Lock className="size-4 shrink-0 text-warning" />
                <p className="text-xs font-semibold text-warning">Copy this now — it will not be shown again.</p>
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-lg border bg-surface px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
                <CopyButton value={secret} label="Copy" className="shrink-0" />
              </div>
              <p className="mt-2 text-[11px] text-warning">
                Treat it like a password. It is the only thing proving a post really came from Aryeo, so don&apos;t paste it into
                anything except Aryeo&apos;s own webhook settings. If it gets away from you, come back here and make another — that
                retires the old one instantly.
              </p>
            </div>
          )}
        </Step>

        {/* No tick on this one. It used to carry the same `done` as step 3, so
            the only step Jordan actually performs by hand stayed unticked until
            the hub armed itself — a checklist that never credits the work is
            worse than no checklist. The hub cannot see inside Aryeo, so it says
            so instead of guessing. */}
        <Step n={2} title="Put it into Aryeo" done={null}>
          <p className="text-[11px] text-muted">
            <strong>Aryeo has to do this one for you.</strong> Their own documentation says managing webhooks in the Aryeo web
            interface is still feature-flagged, and this account has no webhooks screen — only API keys. Send them the message below
            with the address and events, and say whether you want it signed. If a <strong>Group Settings → Developers → Webhooks</strong>
            section ever appears for you, the same details go in there. The hub can&apos;t see inside Aryeo, so it can&apos;t tick this
            step off for you; you&apos;ll know it worked when step 3 turns green by itself.
          </p>
          <Field label="The address Aryeo should post to" value={state.endpointUrl} mono />
          {/* A URL that isn't https is a localhost or preview address, and
              emailing one of those to Aryeo support wastes a round trip with a
              company that has to make the change for you. Catch it here. */}
          {!state.endpointUrl.startsWith("https://") && (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] font-medium text-danger">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              That address isn&apos;t the live hub — you&apos;re looking at this page on a test copy. Open Connections on
              hub.realtourpilot.com and copy it from there before sending anything to Aryeo.
            </p>
          )}
          <Field label="The events we need" value={state.events.join(", ")} />
          {/* The fallback Aryeo's docs leave room for. Without the header NAME
              on screen, "they offered us a custom header instead" becomes a
              support round trip and a guess. */}
          <p className="mt-2 text-[11px] text-muted">
            If Aryeo say they can&apos;t sign the message body and offer a custom header instead, that works too — ask them to send the
            secret as a header named <code className="rounded bg-surface-2 px-1 font-mono">{state.tokenHeader}</code>. The hub accepts
            either. Signing is better where it&apos;s available: it proves the message itself wasn&apos;t tampered with, where a header
            only proves the sender knew the secret.
          </p>
          <div className="mt-2">
            <button
              onClick={() => setShowSupport((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2"
            >
              <MailPlus className="size-4" />
              {showSupport ? "Hide the message for Aryeo support" : "Message for Aryeo support"}
            </button>
          </div>
          {showSupport && (
            <div className="mt-2 rounded-xl border bg-surface-2/50 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium">Ready to send — nothing to fill in.</p>
                <CopyButton value={state.supportMessage} label="Copy message" />
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-surface p-3 text-[11px] leading-relaxed">
                {state.supportMessage}
              </pre>
              <p className="mt-1.5 text-[11px] text-muted">
                The secret itself is deliberately not in this message — a support ticket is a permanent record in someone else&apos;s
                system. It asks them where you can enter it yourself. If they say they need it from you, copy it from the box above.
              </p>
            </div>
          )}
        </Step>

        <Step n={3} title="Turn on checking" done={state.armMode === "armed"}>
          <p className="text-[11px] text-muted">
            This part looks after itself. While the hub is waiting, Aryeo&apos;s posts are accepted exactly as they are now — refusing
            them before Aryeo has the secret is precisely what took the feed down on 8 September. The moment a post arrives that is
            genuinely signed with your secret, that proves Aryeo has it, and the hub starts refusing anything that isn&apos;t from then
            on. You&apos;ll get a notification when it does.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {state.armMode !== "armed" ? (
              <button
                onClick={() => start(async () => setMsg(await armAryeoChecking()))}
                disabled={pending || !state.secretReadable}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
                title="Don't wait for a post to prove it — start refusing unsigned posts now"
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                Start checking now
              </button>
            ) : (
              <button
                onClick={() => start(async () => setMsg(await stopAryeoChecking()))}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-2 text-sm font-medium text-danger hover:bg-danger-soft disabled:opacity-60"
                title="Go back to accepting Aryeo's posts — use this the moment real events start bouncing"
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldOff className="size-4" />}
                Stop checking
              </button>
            )}
          </div>
          {state.armMode !== "armed" && !state.secretReadable && state.secretStored && (
            <p className="mt-1 text-[11px] text-danger">
              The hub can&apos;t read the saved secret, so it has nothing to check against. Make a new one in step 1.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted">
            If real Aryeo events start bouncing in the first day after Aryeo starts posting again, the hub switches itself back off
            within about two minutes and tells you — Aryeo only retries a failed delivery twice, so waiting for a person is waiting
            too long. That first day is counted from Aryeo&apos;s next post, not from when you press the button, so pressing it while
            Aryeo is quiet doesn&apos;t use the safety net up.
          </p>
          {/* Pressing this early is now safe (the settling-in window starts at
              Aryeo's next post, not at the press) but it is still a guess, and
              a guess made about a silent lane is worth naming. */}
          {state.armMode !== "armed" && silent && (
            <p className="mt-1 text-[11px] text-warning">
              Worth waiting, though: Aryeo isn&apos;t sending anything at all right now, so there is nothing to check and nothing to
              gain by starting early. If you do, and its first post back isn&apos;t signed, the hub will catch that and switch itself
              off again.
            </p>
          )}
        </Step>
      </ol>

      {msg && (
        <p className={`mt-3 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.ok ? <CheckCircle2 className="mr-1 inline size-3" /> : <AlertTriangle className="mr-1 inline size-3" />}
          {msg.message}
        </p>
      )}

      {/* RETIRING THE OLD SECRET. Kept at the bottom, behind a confirm, because
          it is a loosening: it hands the endpoint back to accepting anything. */}
      {state.secretStored && (
        <div className="mt-3 border-t border-border pt-3">
          {!confirmRetire ? (
            <button onClick={() => setConfirmRetire(true)} className="text-[11px] font-medium text-muted hover:text-danger">
              Remove the saved secret entirely
            </button>
          ) : (
            <div className="rounded-xl border border-danger/40 bg-danger-soft p-3">
              <p className="text-xs font-medium text-danger">
                Remove the saved secret? The hub will go back to accepting any post sent to its Aryeo address, from anyone who knows
                it. Nothing about Aryeo&apos;s own settings changes, and your Aryeo API key is untouched.
              </p>
              <p className="mt-1 text-[11px] text-muted">
                You almost certainly don&apos;t need this. Making a new secret in step 1 already replaces the old one — including the
                one saved on 8 September that Aryeo was never given — and leaves the address protected. This button leaves it
                unprotected, so it is only for walking away from the whole idea.
              </p>
              {state.enforcedWhenNoSecret && (
                <p className="mt-1 text-[11px] font-medium text-warning">
                  One thing will be switched off with it: this page is currently set to refuse every Aryeo post while no secret is
                  saved. Left on, removing the secret would stop Aryeo getting in at all — so the hub will set that back to
                  accepting at the same time, and say so.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() =>
                    start(async () => {
                      setMsg(await retireAryeoWebhookSecret());
                      setConfirmRetire(false);
                    })
                  }
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-danger/50 bg-surface px-3 py-2 text-xs font-medium text-danger hover:opacity-90 disabled:opacity-60"
                >
                  {pending && <Loader2 className="size-3 animate-spin" />}
                  Yes, remove it
                </button>
                <button
                  onClick={() => setConfirmRetire(false)}
                  className="rounded-lg border px-3 py-2 text-xs font-medium hover:bg-surface-2"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** One line saying what the receiver is doing right now, in words rather than a
 *  switch position. Never says "secure" about a state that isn't. */
function StateLine({ state }: { state: CutoverState }) {
  // THE STATE THAT KILLED THE FEED, named on sight. No secret saved AND the
  // page set to refuse what it can't verify is not "wide open" — it is the
  // opposite, and it is exactly the 8 September configuration: every post
  // refused, Aryeo giving up after two retries, nothing arriving at all. This
  // line used to say "accepted without any check" in that state.
  if (!state.secretStored && state.enforcedWhenNoSecret) {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        Nothing is getting in. There is no secret saved, and this page is set to refuse every post it can&apos;t check — so the hub
        is turning Aryeo away. That is what happened on 8 September. Make a secret below, or change that setting on the webhook
        health panel underneath.
      </p>
    );
  }
  if (!state.secretStored) {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
        <ShieldOff className="mt-0.5 size-3.5 shrink-0" />
        No secret is saved. Every post to the Aryeo address is accepted without any check, so anyone who knows it can post here.
      </p>
    );
  }
  if (!state.secretReadable) {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
        <ShieldOff className="mt-0.5 size-3.5 shrink-0" />
        A secret is saved but the hub can no longer unlock it, so it is accepting posts without checking them. Make a new one.
      </p>
    );
  }
  if (state.armMode === "armed") {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-success-soft px-3 py-2 text-xs font-medium text-success">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        Checking is on. Aryeo has proved it has the secret, and any post that isn&apos;t signed with it is refused.
      </p>
    );
  }
  if (state.armMode === "holding") {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-xs font-medium text-warning">
        <ShieldOff className="mt-0.5 size-3.5 shrink-0" />
        Checking is off and will stay off until you turn it back on. Posts are being accepted and marked as unchecked. It was switched
        off either by hand or because real Aryeo events started bouncing.
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-xs font-medium text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      Waiting on Aryeo. A secret is saved, and posts are still being accepted as normal — nothing is being refused. Checking switches
      on by itself the first time Aryeo sends a post signed with it.
    </p>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean | null; children: React.ReactNode }) {
  return (
    <li className="rounded-xl border bg-surface-2/40 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
            done === true ? "bg-success text-white" : "bg-surface-2 text-muted"
          }`}
        >
          {done === true ? "✓" : n}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </li>
  );
}

/** A labelled, copyable value. Read-only on purpose — these are things to move
 *  somewhere else, not things to edit. */
function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
        <CopyButton value={value} label="Copy" />
      </div>
      <div className="flex items-center gap-2 rounded-lg border bg-surface px-3 py-2">
        <span className={`min-w-0 flex-1 break-all text-xs ${mono ? "font-mono" : ""}`}>{value}</span>
        <Copy className="size-3 shrink-0 text-muted-2" aria-hidden />
      </div>
    </div>
  );
}
