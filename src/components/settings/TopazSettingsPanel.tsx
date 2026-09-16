"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Toggle, SaveRow } from "@/components/settings/OperatingRules";
import { saveTopazRules } from "@/app/settings/actions";
// Type-only (erased at build). A client component must never import the
// settings MODULE — it reaches prisma and would break the production build
// while tsc stays quiet — but its shapes are free.
import type { TopazSettings, TopazProteusParams } from "@/lib/settings";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE 1080p PASS — Jordan's own controls.
//
// Three things live here, in the order he will care about them:
//   1. the switch, and which work it applies to;
//   2. what he is willing to spend, with what this month has already cost;
//   3. the preset itself — every slider from his desktop export, labelled in
//      HIS words, editable without a deploy.
//
// (3) is the reason this panel exists rather than a constant in the code.
// Topaz does not document which API setting each desktop slider drives, nor
// how its 0-100 scale becomes the API's -1..1 — their own docs agent was asked
// and said so. So the first real render has to be compared against his desktop
// export and the numbers nudged until they match, possibly several times. A
// preset that needed a deploy to tune would be a preset nobody ever tunes.
//
// Everything saved here is clamped again on the server (topazSettings), so a
// stale tab, a hand-typed number or a future field can never put an
// out-of-range value in front of a paid API. The clamped result comes back and
// re-seeds this form, so what is on screen is always what is stored.
// ---------------------------------------------------------------------------

export type TopazUsage = {
  connected: boolean;
  /** null = Topaz couldn't be reached. Never shown as 0. */
  balance: number | null;
  todayRenders: number;
  monthRenders: number;
  monthCredits: number;
};

/** His desktop sliders, in his words, and the API parameter each one is our
 *  best reading of. The 0-100 number on screen is the number on his screen;
 *  what gets sent is that ÷ 100, which is the whole of the mapping and is
 *  written out under each row so it is never a mystery. */
type SliderKey = "compression" | "details" | "blur" | "noise" | "halo" | "preblur" | "recover_original_detail_value";

const SLIDERS: { key: SliderKey; label: string; hint: string; min: number }[] = [
  { key: "compression", label: "Fix compression", hint: "cleans up blocky patches in sky, shadow and gradients", min: -100 },
  { key: "details", label: "Improve detail", hint: "brings back texture — brick, grass, fabric", min: -100 },
  { key: "blur", label: "Sharpen", hint: "crispness; too much looks crunchy on a phone", min: -100 },
  { key: "noise", label: "Reduce noise", hint: "smooths grain from dark rooms and high ISO", min: -100 },
  { key: "halo", label: "Dehalo", hint: "kills the bright outline around rooflines and window frames", min: -100 },
  { key: "preblur", label: "Anti-alias / deblur", hint: "for stair-stepped edges on railings and blinds", min: -100 },
  { key: "recover_original_detail_value", label: "Recover detail", hint: "puts back some of the original picture after the clean-up", min: 0 },
];

export function TopazSettingsPanel({
  initial,
  defaults,
  aryeoNote,
  usage,
}: {
  initial: TopazSettings;
  /** The values we start from — Jordan's desktop preset as we read it. Passed
   *  in by the server page rather than copied here, so the "put it back" button
   *  can never drift from what the engine actually defaults to. */
  defaults: TopazProteusParams;
  /** ARYEO_MANUAL_NOTE. A separate prop from `usage` on purpose: the numbers
   *  can fail to load, and this sentence must still be on the screen. */
  aryeoNote: string;
  /** null when the counts couldn't be read — the strip is simply omitted
   *  rather than shown as zeroes. */
  usage: TopazUsage | null;
}) {
  const [r, setR] = useState<TopazSettings>(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const set = (patch: Partial<TopazSettings>) => {
    setR((p) => ({ ...p, ...patch }));
    setMsg(null);
  };
  const setParam = (patch: Partial<TopazProteusParams>) => {
    setR((p) => ({ ...p, params: { ...p.params, ...patch } }));
    setMsg(null);
  };
  const toggleType = (t: string) => {
    const has = r.deliverableTypes.includes(t);
    set({ deliverableTypes: has ? r.deliverableTypes.filter((x) => x !== t) : [...r.deliverableTypes, t] });
  };

  const grainOn = r.params.grain > 0;

  return (
    <div className="space-y-5">
      {/* ---- 1. the switch ------------------------------------------------ */}
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Run every approved cut through Topaz</p>
            <p className="text-[13px] leading-relaxed text-muted">
              When you approve a video in the Review Room, the hub sends it to Topaz, gets a cleaned-up 1080p version back,
              and puts it in that job&rsquo;s <b className="font-medium text-foreground/80">05-Final-Video</b> folder beside
              the editor&rsquo;s original — which is never overwritten. Approving stays instant either way: if this is off,
              or Topaz is down, or the credits have run out, the approval and the delivery carry on exactly as they do today.
            </p>
          </div>
          <Toggle on={r.enabled} onChange={(v) => set({ enabled: v })} label="Run approved cuts through Topaz" />
        </div>
        {!usage?.connected && (
          <p className="mt-2 flex items-start gap-2 border-t border-border pt-2 text-[12px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              No Topaz key is stored yet, so this switch does nothing on its own. Paste your key on the Connections page
              first — testing it only reads your credit balance and spends nothing.
            </span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-4 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Applies to</span>
          <Check label="Videos" on={r.deliverableTypes.includes("VIDEO")} onChange={() => toggleType("VIDEO")} />
          <Check label="Social reels" on={r.deliverableTypes.includes("SOCIAL_REEL")} onChange={() => toggleType("SOCIAL_REEL")} />
        </div>
        {r.deliverableTypes.length === 0 && (
          <p className="mt-1 text-[12px] text-warning">Nothing is ticked, so no video will be sent. Tick at least one.</p>
        )}
      </div>

      {/* The step that cannot be automated, said here too — this is one of the
          two screens where somebody reads how the whole pipeline works. */}
      {aryeoNote && (
        <p className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[12px] leading-relaxed text-muted">
          <b className="font-semibold text-foreground/80">The last step is Kyle&rsquo;s, by hand.</b> {aryeoNote} The
          hub gives him a card with the street, the file, the folder and a link to the right Aryeo listing, and he taps it
          done when the listing has gone out.
        </p>
      )}

      {/* ---- 2. what it may spend ----------------------------------------- */}
      <div>
        <h3 className="text-sm font-semibold">What it may spend</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
          Your Topaz plan tops itself up automatically, so these limits are what stands between a bad day and a bill. Every
          one is enforced on the server before anything is sent. A video stopped by a limit is not lost — it waits, and
          starts on its own when the limit resets or you raise it.
        </p>

        {usage && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-surface-2/60 px-3 py-2 text-[12px] text-muted">
            <span>
              <b className="font-semibold text-foreground/80">{usage.monthRenders}</b> video
              {usage.monthRenders === 1 ? "" : "s"} this month
            </span>
            <span>
              <b className="font-semibold text-foreground/80">{usage.monthCredits.toLocaleString()}</b> credits this month
            </span>
            <span>
              <b className="font-semibold text-foreground/80">{usage.todayRenders}</b> today
            </span>
            <span>
              Credits left:{" "}
              <b className="font-semibold text-foreground/80">
                {usage.balance === null ? (usage.connected ? "couldn't ask Topaz just now" : "—") : usage.balance.toLocaleString()}
              </b>
            </span>
          </div>
        )}

        <div className="mt-2 space-y-1.5">
          <NumRow
            label="Most one video may cost"
            hint="a minute of 1080p is about 8 credits, so 20 is roughly a two-and-a-half-minute video. Anything dearer is left out and told to you rather than charged."
            value={r.maxCreditsPerVideo}
            onChange={(n) => set({ maxCreditsPerVideo: n })}
            min={1}
            max={400}
            suffix="credits"
          />
          <NumRow
            label="Most videos in one day"
            hint="counted in Eastern time, so an evening approval doesn't spill into tomorrow's allowance"
            value={r.maxRendersPerDay}
            onChange={(n) => set({ maxRendersPerDay: n })}
            min={0}
            max={200}
            suffix="videos"
          />
          <NumRow
            label="Most videos in one month"
            hint="you finish about 49 a month, with a busy month near 68"
            value={r.maxRendersPerMonth}
            onChange={(n) => set({ maxRendersPerMonth: n })}
            min={0}
            max={1000}
            suffix="videos"
          />
          <NumRow
            label="Most credits in one month"
            hint="this is the limit that actually bounds the bill. Your plan includes 400 a month; 900 works out around $79 all-in, under your $100 cap."
            value={r.maxCreditsPerMonth}
            onChange={(n) => set({ maxCreditsPerMonth: n })}
            min={0}
            max={4000}
            suffix="credits"
          />
          <NumRow
            label="Stop when credits fall below"
            hint="so it can never run out halfway through a delivery. You get told once a day while it is stopped."
            value={r.minBalanceCredits}
            onChange={(n) => set({ minBalanceCredits: n })}
            min={0}
            max={2000}
            suffix="credits"
          />
          <NumRow
            label="Most videos at Topaz at once"
            hint="your plan allows 8; leaving a couple spare means a render you start on your own desktop still has room"
            value={r.maxConcurrent}
            onChange={(n) => set({ maxConcurrent: n })}
            min={1}
            max={8}
            suffix="at a time"
          />
          <NumRow
            label="Biggest video file it will send"
            hint="Topaz refuses anything over 500 MB. A bigger cut is left out with a note, not silently dropped."
            value={r.maxSourceMB}
            onChange={(n) => set({ maxSourceMB: n })}
            min={1}
            max={500}
            suffix="MB"
          />
          <NumRow
            label="Tries before it gives up"
            hint="a video that keeps failing stops and tells somebody instead of retrying forever — retrying forever is what costs money"
            value={r.maxAttempts}
            onChange={(n) => set({ maxAttempts: n })}
            min={1}
            max={10}
            suffix="tries"
          />
        </div>
      </div>

      {/* ---- 3. the preset ------------------------------------------------ */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">The preset</h3>
          <button
            type="button"
            onClick={() => { setR((p) => ({ ...p, params: { ...defaults } })); setMsg(null); }}
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium hover:bg-surface-2"
          >
            <RotateCcw className="size-3.5" /> Put the sliders back
          </button>
        </div>

        <p className="mt-1 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <b className="font-semibold">These numbers are our best reading of your desktop preset, not a confirmed match.</b>{" "}
            Topaz doesn&rsquo;t publish how the sliders in the desktop app line up with the ones their API takes — we asked
            them directly. So run one video through, put the result next to the same clip you exported from your desktop, and
            nudge whatever looks off. Changes take effect on the very next video; nothing needs rebuilding.
          </span>
        </p>

        {/* The single most likely thing to be wrong, so it is first and it says so. */}
        <div className="mt-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">How hard the model works</p>
              <p className="text-[12px] leading-relaxed text-muted">
                Your desktop app calls this <b className="font-medium text-foreground/80">Dynamic</b>. Their API offers three
                words instead, and none of them is that one — <b className="font-medium text-foreground/80">Auto</b> is our
                reading of it. <b className="font-medium text-foreground/80">If the first render comes back stronger or
                weaker than your desktop export, change this before you touch any slider.</b>
              </p>
            </div>
            <Select
              value={r.params.auto}
              onChange={(v) => setParam({ auto: v as TopazProteusParams["auto"] })}
              options={[
                ["Auto", "Auto — let it vary across the clip (our reading of Dynamic)"],
                ["Manual", "Manual — one fixed amount everywhere"],
                ["Relative", "Relative — Topaz doesn't document this one"],
              ]}
            />
          </div>
        </div>

        <div className="mt-2 space-y-1.5">
          {SLIDERS.map((s) => {
            const shown = Math.round(r.params[s.key] * 100);
            const fromDesktop = Math.round(defaults[s.key] * 100);
            return (
              <div key={String(s.key)} className="rounded-lg border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px]">
                    <b>{s.label}</b>
                    <span className="text-muted"> — {s.hint}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{shown}</span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={100}
                  step={1}
                  value={shown}
                  aria-label={s.label}
                  onChange={(e) => setParam({ [s.key]: Number(e.target.value) / 100 } as Partial<TopazProteusParams>)}
                  className="mt-1.5 w-full accent-[var(--brand)]"
                />
                <p className="text-[11px] text-muted-2">
                  Your desktop preset: {fromDesktop}
                  {shown !== fromDesktop && <span className="text-warning"> · changed</span>}
                </p>
              </div>
            );
          })}

          {/* The one slider whose scale we genuinely cannot guess. Saying so is
              better than inventing a conversion and hiding it. */}
          <div className="rounded-lg border border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px]">
                <b>Add noise</b>
                <span className="text-muted"> — puts a little grain back so the picture doesn&rsquo;t look plastic</span>
              </span>
              <DecBox value={r.params.prenoise} onChange={(n) => setParam({ prenoise: n })} min={0} max={0.1} step={0.005} />
            </div>
            <p className="text-[11px] text-muted-2">
              This one runs 0 to 0.1 on their API and there is no published way to convert your desktop number to it. Yours is
              at 0, which is 0 here too.
            </p>
          </div>
        </div>

        {/* Output size — a real correction to what the screenshots showed, so it
            is on the main panel rather than hidden under Advanced. */}
        <div className="mt-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Finished size</p>
              <p className="text-[12px] leading-relaxed text-muted">
                &ldquo;1080p&rdquo; here means the <b className="font-medium text-foreground/80">short side</b> is 1080 and
                the shape is kept. An upright reel comes out 1080×1920; the wide 4K pieces come out 1920×1080. Both are
                1080p, and nothing is ever stretched or letterboxed to fit a number.
              </p>
            </div>
            <Num value={r.outputShortSide} onChange={(n) => set({ outputShortSide: n })} min={240} max={2160} suffix="px" wide />
          </div>
          <div className="mt-2 flex items-start justify-between gap-3 border-t border-border pt-2">
            <p className="text-[13px] text-muted">
              <b className="text-foreground">Leave small videos alone</b> — a clip that is already under 1080 stays its own
              size instead of being enlarged. Off by default: making a small video bigger and cleaner is exactly what Topaz
              is for.
            </p>
            <Toggle on={r.neverUpscale} onChange={(v) => set({ neverUpscale: v })} label="Leave small videos alone" />
          </div>
        </div>

        {/* ---- advanced ---------------------------------------------------- */}
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="mt-3 text-[12px] font-medium text-brand hover:underline"
        >
          {advanced ? "Hide the rest" : "The rest of the preset (grain, film type, file settings)"}
        </button>

        {advanced && (
          <div className="mt-2 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span className="text-[13px]">
                <b>Kind of footage</b>
                <span className="text-muted"> — everything you shoot is Progressive</span>
              </span>
              <Select
                value={r.params.video_type}
                onChange={(v) => setParam({ video_type: v as TopazProteusParams["video_type"] })}
                options={[["Progressive", "Progressive"], ["Interlaced", "Interlaced"], ["ProgressiveInterlaced", "Mixed"]]}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span className="text-[13px]">
                <b>Focus fix</b>
                <span className="text-muted"> — your desktop preset has this off</span>
              </span>
              <Select
                value={r.params.focus_fix_level}
                onChange={(v) => setParam({ focus_fix_level: v as TopazProteusParams["focus_fix_level"] })}
                options={[["None", "Off"], ["Normal", "Normal"], ["Strong", "Strong"]]}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span className="text-[13px]">
                <b>Field order</b>
                <span className="text-muted"> — only matters for interlaced footage, so it never affects your videos</span>
              </span>
              <Select
                value={r.params.field_order}
                onChange={(v) => setParam({ field_order: v as TopazProteusParams["field_order"] })}
                options={[["Auto", "Auto"], ["TopFirst", "Top field first"], ["BottomFirst", "Bottom field first"]]}
              />
            </div>

            <div className="rounded-lg border border-border px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <span className="text-[13px]">
                  <b>Film grain</b>
                  <span className="text-muted"> — your desktop preset has this unticked, so it is off here too</span>
                </span>
                <Toggle
                  on={grainOn}
                  onChange={(v) => setParam(v ? { grain: 0.02, grain_sigma: 0.5, grain_size: 1 } : { grain: 0, grain_sigma: 0, grain_size: 0 })}
                  label="Film grain"
                />
              </div>
              {grainOn && (
                <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] text-muted">How much</span>
                    <DecBox value={r.params.grain} onChange={(n) => setParam({ grain: n })} min={0} max={0.1} step={0.005} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] text-muted">How soft</span>
                    <DecBox value={r.params.grain_sigma} onChange={(n) => setParam({ grain_sigma: n })} min={0} max={1} step={0.05} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] text-muted">How big</span>
                    <DecBox value={r.params.grain_size} onChange={(n) => setParam({ grain_size: n })} min={0} max={5} step={0.1} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] text-muted">Style</span>
                    <Select
                      value={r.params.grain_type}
                      onChange={(v) => setParam({ grain_type: v as TopazProteusParams["grain_type"] })}
                      options={[["gaussian", "Gaussian"], ["silver_rich", "Silver rich"], ["grey", "Grey"]]}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border px-3 py-2">
              <p className="text-[13px]">
                <b>File settings</b>
                <span className="text-muted">
                  {" "}
                  — how the finished file is packaged. Topaz doesn&rsquo;t publish the list of words their API accepts here,
                  so these are boxes rather than menus: if a render ever comes back refused because of one of them, correct it
                  here and try again.
                </span>
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <TextRow label="File type" value={r.container} onChange={(v) => set({ container: v })} />
                <TextRow label="Sound" value={r.audioCodec} onChange={(v) => set({ audioCodec: v })} />
                <TextRow label="Sound handling" value={r.audioTransfer} onChange={(v) => set({ audioTransfer: v })} />
                <TextRow label="Compression level" value={r.dynamicCompressionLevel} onChange={(v) => set({ dynamicCompressionLevel: v })} />
              </div>
            </div>
          </div>
        )}
      </div>

      <SaveRow
        busy={busy}
        msg={msg}
        onSave={() =>
          start(async () => {
            const res = await saveTopazRules(r).catch(() => ({
              ok: false,
              message: "Couldn't save — try again.",
              settings: undefined,
            }));
            // Re-seed from what was actually stored: every number is range-checked
            // again on the server, so this is how the screen stays honest about a
            // value that was pulled back into range.
            if (res.settings) setR(res.settings);
            setMsg(res.message);
          })
        }
      />
    </div>
  );
}

// ---- small inputs ----------------------------------------------------------
// Local copies rather than shared ones: the number boxes on the operating-rules
// card are whole numbers only, and half of this panel is decimals.

function Num({
  value,
  onChange,
  min,
  max,
  suffix,
  wide,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  suffix?: string;
  wide?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className={cn(
          "rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand",
          wide ? "w-20" : "w-16",
        )}
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}

function NumRow({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  suffix: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <span className="min-w-0 flex-1 text-[13px]">
        <b>{label}</b>
        <span className="text-muted"> — {hint}</span>
      </span>
      <Num value={value} onChange={onChange} min={min} max={max} suffix={suffix} wide />
    </div>
  );
}

function DecBox({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={(e) => {
        // Keep the keystrokes ("0.", "0.0") while they are still being typed —
        // parsing on every key turns "0.05" into 0 the moment the dot lands.
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
      onBlur={() => setDraft(null)}
      step={step}
      className="w-20 shrink-0 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand"
    />
  );
}

function TextRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[13px]">
      <span className="text-muted">{label}</span>
      <input
        value={value}
        maxLength={40}
        onChange={(e) => onChange(e.target.value)}
        className="w-28 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand"
      />
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-full shrink-0 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Check({ label, on, onChange }: { label: string; on: boolean; onChange: () => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[13px]">
      <input type="checkbox" checked={on} onChange={onChange} className="size-4 accent-[var(--brand)]" />
      {label}
    </label>
  );
}
