"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Upload,
  CheckCircle2,
  Circle,
  XCircle,
  AlertTriangle,
  Star,
  Flag,
  FileText,
  Loader2,
  Check,
} from "lucide-react";
import { DELIVERABLE_META, type VideoStepSpec } from "@/lib/pipeline";
import { markDeliverableUploaded, markDeliverableNotCompleted, flagIssue, finalizeUpload, submitUploadFeedback } from "@/app/upload/actions";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { etDateTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Markdown } from "@/components/ui/Markdown";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";

// ---------------------------------------------------------------------------
// The shoot debrief portal (rebuilt Aug 31 2026 per Jordan; readability pass
// Sep 1: numbered steps a tired photographer can scan on a phone at 9 PM).
// Files go to Dropbox directly — THIS page is where the photographer and the
// office get aligned. The job is not done until every step is answered.
// ---------------------------------------------------------------------------

type AskAction =
  | { kind: "submit"; force: boolean }
  | { kind: "toggle"; id: string; next: boolean; prevReason: string | undefined };

type Deliverable = {
  id: string;
  type: DeliverableType;
  quantity: number;
  status: DeliverableStatus;
  uploadedAt: string | null;
  notCompletedReason: string | null;
};

const DETECTED: DeliverableStatus[] = ["UPLOADED", "IN_PROGRESS", "DONE"];
function initialUploaded(d: Deliverable): boolean {
  // A saved "couldn't complete" reason is authoritative — a mis-tap-promoted
  // status must not re-render the row green on reload while /ops shows the
  // reason (review). Marking uploaded always clears the reason server-side,
  // so a genuine upload can never carry a stale one.
  if (d.notCompletedReason) return false;
  return d.uploadedAt != null || DETECTED.includes(d.status);
}

import { NOTHING_TO_REMOVE_SENTINEL as NOTHING_SENTINEL, FRONT_TO_BACK_SENTINEL, INTERIOR_EXTERIOR_SENTINEL } from "@/lib/debrief";

// ---------------------------------------------------------------------------
// Video instructions are STRUCTURED (Jordan, Sep 1: "sectioning it off so it's
// nice and organized for the editor vs a big paragraph"). Stored composed into
// the one videoInstructions column with these labels, so the editor brief PDF
// and /edit render it sectioned with zero schema churn — and parsed back out
// on re-open.
// ---------------------------------------------------------------------------
const VID_STYLES = {
  fast: "Fast-Paced",
  cinematic: "Timeless & Elegant (Cinematic)",
  // Monthly plans (Starter/Accelerator/Pro) are ALWAYS this — Jordan, Sep 1:
  // no dropdown, the style is fixed. Kept in the same map so it composes,
  // parses and renders through the identical STYLE: line as the others.
  branding: "Personal Branding",
} as const;
type VidStyle = keyof typeof VID_STYLES;
// Reverse lookup so compose/parse can never drift — a style added to
// VID_STYLES round-trips automatically (review: "Personal Branding" was
// composed but not parsed, so it vanished on re-open).
const STYLE_BY_LABEL = new Map<string, VidStyle>(
  (Object.entries(VID_STYLES) as [VidStyle, string][]).map(([k, v]) => [v, k]),
);
const VID_SECTIONS = [
  { key: "vision", label: "VISION FOR THE EDIT", title: "Vision for the edit", required: true, placeholder: "The feel and the story — e.g. luxury and calm; let the property breathe; the hook is the double-height foyer." },
  { key: "summary", label: "SUMMARY", title: "Summary", required: false, placeholder: "The shoot in two lines — what was captured, the flow, anything unusual." },
  { key: "mustShow", label: "SHOTS THAT MUST BE SHOWN", title: "Shots that must be shown", required: false, placeholder: "e.g. drone push-in over the pool · the kitchen island reveal · sunset patio clips at the end." },
  { key: "avoid", label: "AREAS TO AVOID", title: "Areas to avoid", required: false, placeholder: "e.g. skip the unfinished office · avoid the neighbor's yard in the drone pass." },
  { key: "realtor", label: "REALTOR REQUESTS", title: "Realtor requests", required: false, placeholder: "Anything the agent asked for on site — features to hit, order, moments they want kept." },
  { key: "additional", label: "ADDITIONAL NOTES", title: "Additional notes", required: false, placeholder: "Anything else that shapes this edit." },
  // Agent-intro packages only (Jordan, Sep 1): the typed intro script +
  // simple editing notes replace the full section set. Same composed-column
  // storage, so the editor brief PDF and /edit render them for free.
  { key: "intro", label: "INTRO SCRIPT", title: "Intro script — exactly as the agent delivered it", required: true, placeholder: "Type the intro word for word as it was filmed — the editor cuts and captions to this." },
  { key: "editNotes", label: "EDITING NOTES", title: "Editing instructions / notes", required: false, placeholder: "Anything the editor should know — order, must-show moments, things to avoid." },
] as const;
type VidKey = (typeof VID_SECTIONS)[number]["key"];
// Which sections each package flavor shows (all compose/parse identically).
const AGENT_INTRO_KEYS: readonly VidKey[] = ["intro", "editNotes"];
const FULL_KEYS: readonly VidKey[] = ["vision", "summary", "mustShow", "avoid", "realtor", "additional"];
// A plain social reel needs no brief at all (Jordan, Sep 1: "if it's a
// standard social reel, it doesn't need additional notes") — one optional
// box, nothing demanded.
const MINIMAL_KEYS: readonly VidKey[] = ["editNotes"];
const COLOR_PROFILE_LINE = "COLOR PROFILE: S-Log3, D-LogM";

function composeVideoInstructions(style: VidStyle | null, sections: Record<VidKey, string>): string {
  const hasContent = style !== null || VID_SECTIONS.some((s) => sections[s.key]?.trim());
  // Nothing filled (photo-only jobs, untouched video forms) → EMPTY, so the
  // server never persists a brief that is just the auto color-profile line
  // (review: that vacuously satisfied the required-brief gate).
  if (!hasContent) return "";
  const parts: string[] = [];
  if (style) parts.push(`STYLE: ${VID_STYLES[style]}`);
  parts.push(COLOR_PROFILE_LINE);
  for (const s of VID_SECTIONS) {
    const v = sections[s.key]?.trim();
    if (v) parts.push(`${s.label}\n${v}`);
  }
  return parts.join("\n\n");
}

// Labels only count as section headers when they are an ENTIRE line — a legacy
// free-text brief that merely contains the word "SUMMARY" mid-sentence must
// not be mis-split and truncated on re-submit (review: silent prod data loss).
function parseVideoInstructions(text: string | null): { style: VidStyle | null; sections: Record<VidKey, string> } {
  const sections = Object.fromEntries(VID_SECTIONS.map((s) => [s.key, ""])) as Record<VidKey, string>;
  if (!text?.trim()) return { style: null, sections };
  let style: VidStyle | null = null;
  const lines = text.split("\n");
  const keyForLabel = new Map<string, VidKey>(VID_SECTIONS.map((s) => [s.label, s.key as VidKey]));
  let current: VidKey | null = null;
  const prefix: string[] = []; // content before any label line (legacy text)
  for (const raw of lines) {
    const line = raw.trim();
    const styleMatch = line.match(/^STYLE:\s*(.+)$/);
    if (styleMatch && current === null) {
      const v = styleMatch[1].trim();
      style = STYLE_BY_LABEL.get(v) ?? style;
      continue;
    }
    if (line === COLOR_PROFILE_LINE) continue; // re-added automatically on compose
    const key = keyForLabel.get(line);
    if (key) { current = key; continue; }
    if (current) sections[current] += (sections[current] ? "\n" : "") + raw;
    else prefix.push(raw);
  }
  for (const s of VID_SECTIONS) sections[s.key] = sections[s.key].trim();
  const prefixText = prefix.join("\n").trim();
  if (prefixText) sections.vision = sections.vision ? `${prefixText}\n${sections.vision}` : prefixText;
  return { style, sections };
}

// One numbered step card: orange number while open, green check once its
// requirement is satisfied. The whole page reads as a checklist.
function StepCard({
  n, title, done, subtitle, children,
}: {
  n: number; title: string; done: boolean; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold",
            done ? "bg-success/15 text-success" : "bg-brand text-white",
          )}
        >
          {done ? <Check className="size-4.5" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3 sm:pl-11">{children}</div>
    </section>
  );
}

// Small uppercase label that groups the standard into scannable chunks.
function MiniHeading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-widest text-brand first:mt-0">{children}</div>;
}

// One group of the SOP §27 pre-upload checklist.
function CheckRow({ checked, onChange, title, text }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: string }) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors",
      checked ? "border-success/40 bg-success-soft/30" : "border-border hover:bg-surface-2",
    )}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
      <span className="text-sm leading-snug">
        <span className={cn("font-semibold", checked && "text-success")}>{title}.</span>{" "}
        <span className="text-foreground/75">{text}</span>
      </span>
    </label>
  );
}

export function UploadPortal({
  project,
  deliverables,
  specialRequests,
  flags: initialFlags,
  policy,
  script,
  foldersSlot,
}: {
  project: {
    id: string;
    title: string;
    addressLine: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    packageName: string | null;
    shootDate: string | null;
    status: string;
    editorBrief: string | null;
    uploadedAt: string | null;
    editorPdfPath: string | null;
    clientName: string;
    editingPreferences: string | null;
    photographerName: string | null;
    cullingConfirmedAt: string | null;
    shotOrderNotes: string | null;
    removalNotes: string | null;
    videoInstructions: string | null;
    videosFilmed: number | null;
    scriptConfirmedAt: string | null;
    scriptConfirmNote: string | null;
  };
  deliverables: Deliverable[];
  specialRequests: string[];
  flags: string[];
  policy: {
    photosOrdered: boolean;
    videoOrdered: boolean;
    photoTarget: number;
    range: { low: number; high: number; upper: number | null };
    rangeMode: "sop" | "legacy" | "override";
    squareFeet: number | null;
    /** what this order's video step must show and demand — see videoStepSpec */
    videoSpec: VideoStepSpec;
  };
  /** the shoot script pulled from Script Studio (null = none exists there) */
  script: { body: string; hook: string | null; url: string | null } | null;
  /** the Dropbox folders card, rendered by the server page */
  foldersSlot: React.ReactNode;
}) {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>(
    Object.fromEntries(deliverables.map((d) => [d.id, initialUploaded(d)])),
  );
  const [editorBrief, setEditorBrief] = useState(project.editorBrief ?? "");
  const [flags, setFlags] = useState(initialFlags);
  const [flagInput, setFlagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [toggling, startToggle] = useTransition();
  const [done, setDone] = useState(project.uploadedAt != null);
  const [pdfPath, setPdfPath] = useState<string | null>(project.editorPdfPath);
  const [err, setErr] = useState<string | null>(null);
  const [processNote, setProcessNote] = useState("");
  const [processNoteSent, setProcessNoteSent] = useState(false);

  // --- Debrief state (prefilled from prior submits — re-opening never re-asks). ---
  // The SOP §27 pre-upload checklist: four groups, all four required.
  const confirmedBefore = !!project.cullingConfirmedAt;
  const [checks, setChecks] = useState({ coverage: confirmedBefore, culling: confirmedBefore, quality: confirmedBefore, count: confirmedBefore });
  const cullOk = checks.coverage && checks.culling && checks.quality && checks.count;
  const setCheck = (k: keyof typeof checks) => (v: boolean) => setChecks((c) => ({ ...c, [k]: v }));
  const priorNothing = project.removalNotes === NOTHING_SENTINEL;
  const [removal, setRemoval] = useState(priorNothing ? "" : project.removalNotes ?? "");
  const [nothingToRemove, setNothingToRemove] = useState(priorNothing);
  const priorStandardOrder =
    project.shotOrderNotes === FRONT_TO_BACK_SENTINEL || project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL;
  const [orderChoice, setOrderChoice] = useState<"front-to-back" | "interior-exterior" | "out-of-order" | null>(
    !project.shotOrderNotes ? null
      : project.shotOrderNotes === FRONT_TO_BACK_SENTINEL ? "front-to-back"
      : project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL ? "interior-exterior"
      : "out-of-order",
  );
  // Strip the storage prefix on rehydrate — otherwise every re-submit would
  // re-wrap it ("Out of order — Out of order — …") — same pattern as scriptNote.
  const [orderNotes, setOrderNotes] = useState(
    priorStandardOrder ? "" : (project.shotOrderNotes ?? "").replace(/^Out of order — /, ""),
  );
  const parsedVid = parseVideoInstructions(project.videoInstructions);
  const [vidStyle, setVidStyle] = useState<VidStyle | null>(parsedVid.style);
  const [vidSections, setVidSections] = useState<Record<VidKey, string>>(parsedVid.sections);
  // A job that already carries a brief (legacy free text, or a prior submit)
  // is never retro-blocked for the new required fields — same rule as the
  // server's first-finalize-only gates.
  const hadPriorBrief = !!project.videoInstructions?.trim();
  // What "answered" means depends on the package flavor: agent-intro packages
  // need the typed intro script; everything else needs vision + style.
  // Monthly plans: how many videos actually got filmed. The editor works from
  // this number (Jordan, Sep 1) — it's the only place the real batch size is
  // known, since the order carries one line item.
  const [videosFilmed, setVideosFilmed] = useState<string>(
    project.videosFilmed != null ? String(project.videosFilmed) : "",
  );
  const videosFilmedNum = /^\d{1,3}$/.test(videosFilmed.trim()) ? Number(videosFilmed.trim()) : null;
  const spec = policy.videoSpec;
  // A fixed-style job composes with that style regardless of the picker state.
  // Scoped to a job that ACTUALLY ordered video: isMonthlyContentJob matches on
  // any deliverable label, so a "Content Day" photo-only job would otherwise
  // compose a phantom "STYLE: Personal Branding" brief and permanently waive
  // the vision gate (review).
  const effectiveStyle: VidStyle | null = spec.fixedStyle && policy.videoOrdered ? "branding" : vidStyle;
  const vidInstructions = composeVideoInstructions(effectiveStyle, vidSections);
  // Which sections this order shows. An agent-intro ADD-ON riding a bundle
  // keeps the bundle's full brief — that listing video is separately directed
  // (review HIGH) — while a standalone intro package gets intro + notes only.
  const sectionKeys: readonly VidKey[] = spec.minimalReel
    ? MINIMAL_KEYS
    : spec.requireIntro
      ? (spec.fullBrief ? (["intro", ...FULL_KEYS] as VidKey[]) : AGENT_INTRO_KEYS)
      : FULL_KEYS;
  // Names exactly what THIS order must fill, so the closing warning can't say
  // "vision and style" on a shape whose only required field is the intro.
  const requiredLabels = [
    spec.requireIntro ? "The intro script" : null,
    spec.requireVideoCount ? "The video count" : null,
    spec.fullBrief ? (spec.fixedStyle ? "vision" : "vision and style") : null,
  ].filter(Boolean) as string[];
  const isRequiredKey = (k: VidKey) => (k === "intro" && spec.requireIntro) || (k === "vision" && spec.fullBrief);
  const countAnswered = !spec.requireVideoCount || project.videosFilmed != null || (videosFilmedNum ?? 0) > 0;
  const vidAnswered =
    countAnswered &&
    (hadPriorBrief ||
    ((!spec.requireIntro || !!vidSections.intro.trim()) &&
      (!spec.fullBrief || (!!vidSections.vision.trim() && effectiveStyle !== null))));
  const [scriptChoice, setScriptChoice] = useState<"as-written" | "edited" | null>(
    project.scriptConfirmedAt
      ? project.scriptConfirmNote?.startsWith("Edited") ? "edited" : "as-written"
      : null,
  );
  const [scriptText, setScriptText] = useState(script?.body ?? "");
  // Re-hydrate the "what changed" detail so a re-submit can't wipe it.
  const [scriptNote, setScriptNote] = useState(
    project.scriptConfirmNote?.startsWith("Edited on site — ")
      ? project.scriptConfirmNote.slice("Edited on site — ".length)
      : "",
  );

  // "Couldn't complete" answers (Jordan, Sep 1): an unchecked box with no
  // explanation tells the admin nothing — each item can carry the reason it
  // wasn't completed, which lands on the project timeline + Kyle's QC card.
  const [notDone, setNotDone] = useState<Record<string, string>>(
    Object.fromEntries(deliverables.filter((d) => d.notCompletedReason).map((d) => [d.id, d.notCompletedReason as string])),
  );
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  // IN-PAGE confirmation, never window.confirm(). The portal is opened from a
  // text message, so it runs in mobile Safari / the Messages in-app browser —
  // and a native confirm() raised AFTER an await (outside the tap's gesture)
  // is suppressed or auto-answered "cancel" there. That's why Harrison's
  // "hold on" prompt wouldn't let him continue when he pressed OK (Jordan,
  // Sep 1). An inline panel is deterministic and readable on a phone.
  // The panel stores a SERIALISABLE intent, never a function: a stored closure
  // would capture the render it was created in, so anything typed while the
  // panel was open got silently dropped from the submit (review HIGH). The
  // yes button dispatches from the CURRENT render instead.
  const [ask, setAsk] = useState<{ body: string; yes: string; action: AskAction } | null>(null);

  const addr = [project.addressLine, project.city, project.state, project.zip].filter(Boolean).join(", ");
  const total = deliverables.length;
  const doneCount = Object.values(uploaded).filter(Boolean).length;
  const notDoneCount = deliverables.filter((d) => !uploaded[d.id] && notDone[d.id]).length;
  // "Remaining" = truly unanswered — a "couldn't complete + reason" item is
  // accounted for, so it doesn't nag on submit.
  const remaining = deliverables.filter((d) => !uploaded[d.id] && !notDone[d.id]);

  function toggle(id: string) {
    const next = !uploaded[id];
    const prevReason = notDone[id];
    // A saved "couldn't complete" reason must not be silently converted into
    // an upload by one stray tap on the amber row (review).
    if (next && prevReason) {
      setAsk({
        body: "Mark this as uploaded instead? That clears the “couldn’t complete” reason you saved.",
        yes: "Mark uploaded",
        action: { kind: "toggle", id, next, prevReason },
      });
      return;
    }
    applyToggle(id, next, prevReason);
  }

  function applyToggle(id: string, next: boolean, prevReason: string | undefined) {
    setUploaded((u) => ({ ...u, [id]: next }));
    if (next) {
      // Marking it uploaded supersedes an earlier "couldn't complete".
      setNotDone((m) => { const c = { ...m }; delete c[id]; return c; });
      if (reasonFor === id) setReasonFor(null);
    }
    startToggle(async () => {
      try {
        await markDeliverableUploaded(id, next);
      } catch {
        // Roll back BOTH optimistic changes — the DB still holds the reason.
        setUploaded((u) => ({ ...u, [id]: !next }));
        if (next && prevReason) setNotDone((m) => ({ ...m, [id]: prevReason }));
        setErr("Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function saveNotCompleted(id: string, r: string) {
    const prevReason = notDone[id];
    const prevUploaded = uploaded[id];
    if (r) {
      setNotDone((m) => ({ ...m, [id]: r }));
      setUploaded((u) => ({ ...u, [id]: false }));
    } else {
      if (prevReason === undefined) return;
      // Withdraw — back to a plain "Not yet" row.
      setNotDone((m) => { const c = { ...m }; delete c[id]; return c; });
    }
    setReasonFor(null);
    setReasonText("");
    startToggle(async () => {
      try {
        const res = await markDeliverableNotCompleted(id, r);
        if (!res.ok) throw new Error(res.message ?? "save failed");
      } catch (e) {
        // Restore exactly what was there before, and reopen the editor with
        // the typed text so retry is one tap — a silently-lost reason is the
        // bare unchecked box this feature exists to prevent (review).
        setNotDone((m) => {
          const c = { ...m };
          if (prevReason === undefined) delete c[id];
          else c[id] = prevReason;
          return c;
        });
        setUploaded((u) => ({ ...u, [id]: prevUploaded }));
        if (r) { setReasonFor(id); setReasonText(r); }
        setErr(e instanceof Error && e.message !== "save failed" ? e.message : "Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function submitFlag() {
    const body = flagInput.trim();
    if (!body) return;
    setFlags((prev) => [body, ...prev]);
    setFlagInput("");
    startTransition(async () => {
      await flagIssue(project.id, body);
    });
  }

  // Gate scoping follows the LIVE deliverables: a "couldn't complete" answer
  // excuses its whole category (the server mirrors this in finalizeUpload) —
  // a reel the agent canceled on site must not demand fabricated video
  // instructions or a script attestation (review HIGH).
  const liveType = (types: string[]) =>
    deliverables.some((d) => types.includes(d.type) && (uploaded[d.id] || !notDone[d.id]));
  const photosLive = policy.photosOrdered && liveType(["PHOTOS", "DRONE", "TWILIGHT"]);
  const videoLive = policy.videoOrdered && liveType(["VIDEO", "SOCIAL_REEL"]);

  // What still blocks the submit — same rules the server enforces.
  function missingItems(): string[] {
    const missing: string[] = [];
    if (photosLive && !cullOk) missing.push("the pre-upload checklist (all four boxes)");
    if (photosLive && orderChoice === null) missing.push("answer the shot order");
    if (photosLive && orderChoice === "out-of-order" && !orderNotes.trim()) missing.push("the order you shot the home (and why)");
    if (photosLive && !removal.trim() && !nothingToRemove) missing.push("answer the removal notes");
    if (videoLive && !hadPriorBrief) {
      if (spec.requireIntro && !vidSections.intro.trim()) missing.push("the agent's intro script — type it exactly as delivered");
      if (spec.fullBrief && !vidSections.vision.trim()) missing.push("the vision for the edit");
      if (spec.fullBrief && effectiveStyle === null) missing.push("pick an edit style");
    }
    if (videoLive && spec.requireVideoCount && project.videosFilmed == null && !((videosFilmedNum ?? 0) > 0)) {
      missing.push("how many videos you filmed");
    }
    if (videoLive && script && !scriptChoice) missing.push("confirm the script");
    if (videoLive && scriptChoice === "edited" && !scriptText.trim()) missing.push("the edited script text (or pick “Delivered as written”)");
    // Premium packages: the script can NOT be left blank (Jordan, Sep 1) —
    // when Studio has none, the photographer types what was delivered.
    if (videoLive && spec.requireScript && !script && !hadPriorBrief && !scriptText.trim()) {
      missing.push("the script — this premium package can't be submitted without it");
    }
    return missing;
  }

  function finalize() {
    const missing = missingItems();
    if (missing.length > 0) {
      setErr(`Not done yet — ${missing.join(" · ")}. The job isn't finished until every step is answered.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (remaining.length > 0) {
      setAsk({
        body:
          `${remaining.length} item${remaining.length === 1 ? " isn’t" : "s aren’t"} checked off yet ` +
          `(${remaining.map((d) => DELIVERABLE_META[d.type].label).join(", ")}). Submit to editors anyway?`,
        yes: "Submit anyway",
        action: { kind: "submit", force: false },
      });
      return;
    }
    runSubmit(false);
  }

  function runSubmit(force: boolean) {
    setErr(null);
    const payload = {
      editorBrief,
      cullingConfirmed: cullOk,
      shotOrder: orderChoice ? { mode: orderChoice, notes: orderNotes } : null,
      removalNotes: removal,
      nothingToRemove,
      videoInstructions: vidInstructions,
      scriptConfirm: scriptChoice
        ? { state: scriptChoice, ...(scriptChoice === "edited" ? { script: scriptText, note: scriptNote } : {}) }
        : null,
      sawScript: !!script,
      // Package-scoped requirements (keys ABSENT on pre-update pages — the
      // server treats absence as "old tab, ask for a refresh", null as
      // "unanswered, block with the real message").
      videosFilmed: spec.requireVideoCount ? videosFilmedNum : undefined,
      introScript: spec.requireIntro ? vidSections.intro.trim() || null : undefined,
      providedScript: spec.requireScript && !script ? scriptText.trim() || null : undefined,
      ...(force ? { force: true } : {}),
    };
    startTransition(async () => {
      try {
        const res = await finalizeUpload(project.id, payload);
        if (res.blocked) { setErr(res.blocked); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
        if (res.needsConfirm) {
          // Ask IN PAGE and re-submit with force on "yes" — never a native
          // dialog here: this point is past an await, where mobile browsers
          // silently swallow confirm() (Harrison's stuck "hold on").
          setAsk({
            body: res.warning ?? "Some ordered items look missing. Submit anyway?",
            yes: "Submit anyway",
            action: { kind: "submit", force: true },
          });
          return;
        }
        if (res.pdfPath) setPdfPath(res.pdfPath);
        setDone(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        setErr("Couldn’t submit — the editors were NOT notified. Please try again.");
      }
    });
  }

  const checkbox = "size-4 shrink-0 accent-[var(--brand)]";
  const choiceBtn = (active: boolean, tone: "ok" | "warn" = "ok") =>
    cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
      active
        ? tone === "ok" ? "border-success bg-success/10 text-success" : "border-warning bg-warning/10 text-warning"
        : "border-border hover:bg-surface-2",
    );

  // Step numbering adapts — photo-only jobs never see the video step, video-
  // only jobs never see the photo steps (Jordan, Sep 1).
  let stepNo = 1;
  const removalAnswered = !!removal.trim() || nothingToRemove;
  const orderAnswered =
    orderChoice === "front-to-back" || orderChoice === "interior-exterior" ||
    (orderChoice === "out-of-order" && !!orderNotes.trim());
  const videoDone =
    vidAnswered &&
    (!script || hadPriorBrief || (scriptChoice !== null && (scriptChoice !== "edited" || !!scriptText.trim()))) &&
    // Premium: no Studio script → the typed script is part of "done".
    (!spec.requireScript || !!script || hadPriorBrief || !!scriptText.trim());

  return (
    <div className="space-y-4">
      {/* ---- The job, big and first. ---- */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title.split(",")[0]}</h1>
        <p className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {project.clientName}
          {project.shootDate && <span> · {etDateTime(project.shootDate)}</span>}
        </p>
        {project.packageName && <p className="mt-0.5 text-[13px] text-muted-2">{project.packageName}</p>}
      </div>

      {/* Success banner + process feedback */}
      {done && (
        <div className="rounded-2xl border border-success/30 bg-success-soft/50 p-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5" />
            <span className="font-semibold">Submitted — editors notified</span>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            Thanks! Your notes are on the editor brief, the editors know the files are in Dropbox, and{" "}
            <strong>this shoot is on your payroll</strong> — you&rsquo;ll see it in My Pay.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {pdfPath && (
              <a href={pdfPath} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                <FileText className="size-4" /> View editor brief
              </a>
            )}
            <Link href={`/projects/${project.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:opacity-90">
              View project
            </Link>
          </div>
          {/* Post-job feedback on the PROCESS — Jordan reads every one. */}
          <div className="mt-3 border-t border-success/20 pt-3">
            {processNoteSent ? (
              <p className="text-[13px] text-success"><Check className="mr-1 inline size-3.5" />Feedback sent — thank you.</p>
            ) : (
              <>
                <p className="text-[13px] text-foreground/75">How was this upload process? Anything we should change?</p>
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={processNote}
                    onChange={(e) => setProcessNote(e.target.value)}
                    placeholder="Optional — goes straight to Jordan."
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <button
                    disabled={!processNote.trim() || isPending}
                    onClick={() => {
                      const note = processNote.trim();
                      // Confirm only AFTER the write lands — a dead cell
                      // connection must not eat feedback behind a thank-you.
                      startTransition(async () => {
                        const r = await submitUploadFeedback(project.id, note).catch(() => ({ ok: false }));
                        if (r.ok) setProcessNoteSent(true);
                        else setErr("Couldn't send the feedback — check your connection and try again.");
                      });
                    }}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Special requests reminder */}
      {specialRequests.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-warning">
            <Star className="size-4" /> Special requests for this shoot
          </div>
          <ul className="ml-6 list-disc space-y-0.5 text-sm text-foreground/85">
            {specialRequests.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {project.editingPreferences && (
            <p className="mt-2 text-xs text-muted">Editing preferences: {project.editingPreferences}</p>
          )}
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="font-medium">{err}</div>
        </div>
      )}

      {/* ---- STEP: Upload to Dropbox ---- */}
      <StepCard
        n={stepNo++}
        title="Upload everything to Dropbox"
        done={doneCount >= total && total > 0}
        subtitle="Raw files in the Raw folders · culled extras in Backup Photos."
      >
        {foldersSlot}
      </StepCard>

      {/* ---- STEP: The photo standard (the SOP, enforced) ---- */}
      {policy.photosOrdered && (
        <StepCard n={stepNo++} title="The photo standard — run your cull" done={cullOk}>
          <div className="rounded-xl bg-brand-soft/50 px-3.5 py-2.5 text-sm">
            {policy.rangeMode === "override" ? (
              <>
                <span className="font-semibold">This home&rsquo;s target: {policy.photoTarget} photos.</span>{" "}
                <span className="text-foreground/80">Set by the office for this property — it beats the size tier.</span>
              </>
            ) : policy.rangeMode === "legacy" ? (
              <>
                <span className="font-semibold">This shoot predates the new standard — ceiling ~{policy.photoTarget} finals.</span>{" "}
                <span className="text-foreground/80">Cull to the SOP anyway: hero shots, one composition once.</span>
              </>
            ) : policy.range.upper ? (
              <>
                <span className="font-semibold">This home: aim for {policy.range.low}–{policy.range.high} finals.</span>{" "}
                <span className="text-foreground/80">
                  {policy.range.upper} is the normal ceiling — and the ceiling is not a goal.
                  {policy.squareFeet ? ` (${policy.squareFeet.toLocaleString("en-US")} sq ft)` : ""}
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold">7,000+ sq ft — property dependent.</span>{" "}
                <span className="text-foreground/80">
                  Professional judgment: complete coverage without unnecessary repetition. The sweep checks in
                  around ~{policy.photoTarget} finals unless the office sets a target.
                </span>
              </>
            )}
          </div>

          <MiniHeading>The standard</MiniHeading>
          <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
            <li><strong>Every space gets one HERO SHOT</strong> — the photo you&rsquo;d pick if you could only show one. Supporting shots exist only to show what the hero can&rsquo;t.</li>
            <li><strong>One composition, once.</strong> No distance or zoom variations of the same angle.</li>
            <li><strong>Every photo must add new information.</strong> &ldquo;I like both&rdquo; is not a reason.</li>
            <li><strong>Open-concept areas are one space</strong> — not four rooms&rsquo; worth of angles.</li>
            <li><strong>5-bracket JPG.</strong> A bracket set counts as ONE composition. Not RAW, not 3-bracket.</li>
            <li><strong>Trash cans and pet items are a no-go.</strong> Fix it on site — don&rsquo;t lean on the editor.</li>
            <li><strong>Alternates go to Backup Photos</strong> — and cull that folder too.</li>
          </ul>

          <details className="mt-3 rounded-xl border border-border">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-muted hover:text-foreground">
              Room-by-room guide (guidelines, not quotas)
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-border/60">
                  {[
                    ["Front exterior", "2–4 · up to 5 with aerials"],
                    ["Rear exterior", "2–4 · up to 5 with aerials"],
                    ["Front door / entry", "1"],
                    ["Foyer / entrance", "1–2"],
                    ["Dining room", "1–2"],
                    ["Living / family room", "2–3"],
                    ["Kitchen", "3–5 · up to 6 when justified"],
                    ["Mudroom / laundry", "1–2"],
                    ["Powder room", "1"],
                    ["Full bathroom", "1 · 2 when necessary"],
                    ["Primary bathroom", "2–3"],
                    ["Primary bedroom", "2–3"],
                    ["Secondary bedroom", "1–2"],
                    ["Basement", "2–4 by layout"],
                    ["Office / bonus room", "1–2"],
                    ["Bar", "1–3"],
                    ["Deck / patio", "1–2"],
                    ["Pool", "2–3"],
                    ["Pool house / detached", "1–3 by importance"],
                    ["Other spaces", "1–2"],
                  ].map(([space, n]) => (
                    <tr key={space}>
                      <td className="px-3.5 py-1.5 text-foreground/85">{space}</td>
                      <td className="px-3.5 py-1.5 text-right text-muted tabular-nums">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-3.5 py-2 text-xs text-muted-2">
                Guidelines, not quotas — use professional judgment.{" "}
                <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                  Full table in the SOP ↗
                </a>
              </p>
            </div>
          </details>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Unnecessary photos cost real money — extra editing, plus an extra 1–2 hours per job of re-culling
            after the fact, which kills our turnaround time and pulls the admin and owner off other work. A{" "}
            <strong className="text-foreground/85">$1 production charge may be deducted per clearly unnecessary photo</strong>{" "}
            — duplicates, distance variations, backups uploaded as finals. You will never be charged for photos a
            property genuinely needed: this is not a photo-count penalty, and a property that truly needs more gets more.{" "}
            <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
              Read the full Photography SOP ↗
            </a>
          </p>

          <MiniHeading>Before you upload — confirm all four</MiniHeading>
          <div className="space-y-2">
            <CheckRow checked={checks.coverage} onChange={setCheck("coverage")} title="Coverage"
              text="Every important space is represented, each has its hero shot, exteriors and drone (if ordered) are complete." />
            <CheckRow checked={checks.culling} onChange={setCheck("culling")} title="Culling"
              text="Failures and test shots gone, duplicates and distance variations gone, every supporting photo adds something, backups separated." />
            <CheckRow checked={checks.quality} onChange={setCheck("quality")} title="Quality"
              text="Distractions were fixed on site — no avoidable trash cans, pets, or pet items in frame." />
            <CheckRow checked={checks.count} onChange={setCheck("count")} title="Count"
              text={policy.rangeMode !== "sop"
                ? `The gallery makes sense for this home (~${policy.photoTarget} target) — every photo has a reason to exist.`
                : policy.range.upper
                  ? `The gallery makes sense for this home (aim ${policy.range.low}–${policy.range.high}) — anything above has a reason to exist.`
                  : "The gallery size makes sense for this property — every photo has a reason to exist."} />
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Shot order ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Shot order — front to back?"
          done={orderAnswered}
          subtitle="The gallery should walk the house the way a buyer would. Organizing photos of a house we've never been in burns serious office time — presentation is everything."
        >
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setOrderChoice("front-to-back"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "front-to-back")}>
              <CheckCircle2 className="size-4" /> Front to back
            </button>
            <button onClick={() => { setOrderChoice("interior-exterior"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "interior-exterior")}>
              <CheckCircle2 className="size-4" /> Interior front-to-back, then exterior
            </button>
            <button onClick={() => setOrderChoice("out-of-order")} className={choiceBtn(orderChoice === "out-of-order", "warn")}>
              Different order
            </button>
          </div>
          {orderChoice === "out-of-order" && (
            <div className="mt-2.5">
              <AutoTextarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                minRows={2}
                placeholder="Why, and the order you shot — e.g. contractor in the kitchen: started upstairs beds → baths → living/dining → kitchen last → exteriors."
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-muted">
                Totally fine when the seller, a contractor, or the agent forces it — just tell us the order so nobody has to guess what&rsquo;s where.
              </p>
            </div>
          )}
        </StepCard>
      )}

      {/* ---- STEP: Removal notes ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Anything to remove in editing?"
          done={removalAnswered}
          subtitle="Pets, trash cans, vehicles, clutter that couldn’t be moved. Move what you can on site — we aren’t stagers, but we’re professionals with strong attention to detail."
        >
          <AutoTextarea
            value={removal}
            onChange={(e) => { setRemoval(e.target.value); if (e.target.value.trim()) setNothingToRemove(false); }}
            minRows={2}
            placeholder="e.g. Trash cans in exterior 3–4 · dog bed in the primary bedroom · neighbor's car in the driveway shots."
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={nothingToRemove}
              onChange={(e) => { setNothingToRemove(e.target.checked); if (e.target.checked) setRemoval(""); }}
              className={checkbox}
            />
            Nothing needs removal — I checked.
          </label>
        </StepCard>
      )}

      {/* ---- STEP: Video (only when a video is on the order). The step's
          shape follows the PACKAGE (Jordan, Sep 1): premium packages show the
          full fields and REQUIRE the script; agent-intro packages require the
          typed intro script + just editing notes; everything else keeps the
          vision + style flow. ---- */}
      {policy.videoOrdered && (
        <StepCard
          n={stepNo++}
          title={spec.requireIntro && !spec.fullBrief ? "Video — agent intro script & notes" : "Video — script & your instructions"}
          done={videoDone}
        >
          {script ? (
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-muted">The shoot script (from Script Studio)</p>
                {script.url && (
                  <a href={script.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand hover:underline">
                    Open in Studio ↗
                  </a>
                )}
              </div>
              {/* Studio scripts are MARKDOWN (Jordan, Sep 1) — read it rendered,
                  and only open the formatting editor after "Changed on site". */}
              {scriptChoice === "edited" ? (
                <MarkdownEditor value={scriptText} onChange={setScriptText} minRows={5} className="mt-1.5" />
              ) : (
                <div className="mt-1.5 max-h-80 overflow-y-auto scroll-thin rounded-lg border border-border bg-surface-2/60 px-3 py-2">
                  <Markdown content={scriptText} />
                </div>
              )}
              <p className="mt-1.5 text-[13px] text-muted">
                Did the agent deliver it as written? If anything changed on site, pick &ldquo;Changed on site&rdquo; and fix the text — the editor cuts to what you confirm here.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => { setScriptChoice("as-written"); setScriptText(script.body); }} className={choiceBtn(scriptChoice === "as-written")}>
                  <CheckCircle2 className="size-4" /> Delivered as written
                </button>
                <button onClick={() => setScriptChoice("edited")} className={choiceBtn(scriptChoice === "edited", "warn")}>
                  Changed on site — edit it
                </button>
              </div>
              {scriptChoice === "edited" && (
                <input
                  value={scriptNote}
                  onChange={(e) => setScriptNote(e.target.value)}
                  placeholder="What changed? (one line — e.g. agent swapped the hook, dropped talking point 2)"
                  className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              )}
            </div>
          ) : spec.requireScript ? (
            <div>
              <p className="text-sm font-semibold">
                The script <span className="text-brand">— required for this package</span>
              </p>
              <p className="mt-0.5 text-[13px] text-muted">
                No script came through from Script Studio — type or paste the script exactly as it was delivered on camera. Premium packages can&rsquo;t be submitted without it.
              </p>
              <MarkdownEditor
                value={scriptText}
                onChange={setScriptText}
                minRows={4}
                placeholder="The full script, word for word as filmed."
                className="mt-1.5"
              />
            </div>
          ) : spec.requireIntro ? null : (
            <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-[13px] text-muted">
              No script found in Script Studio for this shoot. If the agent read from one, put it in the instructions below so the editor has it.
            </p>
          )}

          <div className={cn("border-border", (script || !spec.requireIntro) && "mt-4 border-t pt-3.5")}>
            {spec.minimalReel ? (
              <p className="text-sm font-semibold">
                Anything the editor should know? <span className="font-normal text-muted">— optional</span>
              </p>
            ) : spec.requireIntro && !spec.fullBrief ? (
              <p className="text-sm font-semibold">
                Intro script &amp; editing notes <span className="text-brand">— intro required</span>
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold">
                  Your instructions for the edit <span className="text-brand">— required</span>
                </p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Sectioned so the editor can act on it — fill what applies; vision and style are required.
                </p>

                {/* Monthly plans have ONE style — no dropdown (Jordan, Sep 1). */}
                {spec.fixedStyle ? (
                  <div className="mt-2.5">
                    <label className="text-[13px] font-medium text-muted">Edit style</label>
                    <p className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium">
                      <CheckCircle2 className="size-4 text-success" /> {VID_STYLES.branding}
                    </p>
                    <p className="mt-1 text-xs text-muted">Monthly content is always cut in the personal-branding style.</p>
                  </div>
                ) : (
                  <div className="mt-2.5">
                    <label className="text-[13px] font-medium text-muted">Edit style <span className="text-brand">*</span></label>
                    <select
                      value={vidStyle ?? ""}
                      onChange={(e) => setVidStyle((e.target.value || null) as VidStyle | null)}
                      className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand sm:max-w-xs"
                    >
                      <option value="">Pick a style…</option>
                      <option value="fast">{VID_STYLES.fast}</option>
                      <option value="cinematic">{VID_STYLES.cinematic}</option>
                    </select>
                    <p className="mt-1 text-xs text-muted">
                      Ask the realtor on site which they want — luxury often leans timeless &amp; elegant, but not always. Never guess, just ask.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* Monthly plans: the batch size the editor cuts to. The order
                carries ONE line item, so this number is the only truth about
                how many videos were actually filmed (Jordan, Sep 1). */}
            {spec.requireVideoCount && (
              <div className="mt-3">
                <label className="text-[13px] font-medium text-muted">
                  How many videos did you film? <span className="text-brand">*</span>
                </label>
                <input
                  inputMode="numeric"
                  value={videosFilmed}
                  onChange={(e) => setVideosFilmed(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  placeholder="e.g. 4"
                  className="mt-1 w-28 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-muted">
                  The number of finished videos this session should produce — the editor cuts to this count.
                </p>
              </div>
            )}

            <div className="mt-3 space-y-3">
              {sectionKeys.map((k) => VID_SECTIONS.find((sec) => sec.key === k)!).map((s) => (
                <div key={s.key}>
                  <label className="text-[13px] font-medium text-muted">
                    {s.title}{isRequiredKey(s.key) && <span className="text-brand"> *</span>}
                  </label>
                  <AutoTextarea
                    value={vidSections[s.key]}
                    onChange={(e) => setVidSections((v) => ({ ...v, [s.key]: e.target.value }))}
                    minRows={s.key === "vision" || s.key === "intro" ? 3 : 2}
                    placeholder={s.placeholder}
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              ))}
            </div>

            {requiredLabels.length > 0 && (
              <p className="mt-1.5 text-xs text-warning">
                {`${requiredLabels.length > 2 ? `${requiredLabels.slice(0, -1).join(", ")} and ${requiredLabels[requiredLabels.length - 1]}` : requiredLabels.join(" and ")} can’t be left blank${spec.requireIntro ? " — the editor cuts and captions to the intro" : ""}. Skipping the instructions forfeits future premium shoot assignments.`}
              </p>
            )}
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Wrap up ---- */}
      <StepCard
        n={stepNo++}
        title="Check off & wrap up"
        done={done}
        subtitle="Tick each item once its files are in Dropbox, add anything else the editor should know, then submit."
      >
        <div className="space-y-2">
          {deliverables.map((d) => {
            const meta = DELIVERABLE_META[d.type];
            const on = uploaded[d.id];
            const reason = !on ? notDone[d.id] : undefined;
            const editing = reasonFor === d.id;
            return (
              <div key={d.id}>
                <button
                  onClick={() => toggle(d.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                    on ? "border-success/40 bg-success-soft/30" : reason ? "border-warning/40 bg-warning/5" : "bg-surface hover:bg-surface-2",
                  )}
                >
                  {on ? (
                    <CheckCircle2 className="size-5 shrink-0 text-success" />
                  ) : reason ? (
                    <XCircle className="size-5 shrink-0 text-warning" />
                  ) : (
                    <Circle className="size-5 shrink-0 text-muted-2" />
                  )}
                  <span className="flex-1 text-sm font-medium">
                    {meta.label}
                    {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                  </span>
                  <span className={cn("text-xs", reason ? "font-semibold text-warning" : "text-muted")}>
                    {on ? "Uploaded" : reason ? "Couldn't complete" : "Not yet"}
                  </span>
                </button>
                {reason && !editing && (
                  <p className="mt-1 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-foreground/80">
                    <span className="font-semibold text-warning">Why:</span> {reason}{" "}
                    <button
                      onClick={() => { setReasonFor(d.id); setReasonText(reason); }}
                      className="ml-1 font-medium text-muted underline"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => saveNotCompleted(d.id, "")}
                      title="Remove the reason — it's just not done yet"
                      className="ml-2 font-medium text-muted underline"
                    >
                      clear
                    </button>
                  </p>
                )}
                {!on && !reason && !editing && (
                  <button
                    onClick={() => { setReasonFor(d.id); setReasonText(""); }}
                    className="mt-1 px-1 text-xs text-muted underline hover:text-foreground"
                  >
                    Can&rsquo;t complete this? Tell the admin why
                  </button>
                )}
                {editing && (
                  <div className="mt-1.5 flex gap-2">
                    <input
                      autoFocus
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && reasonText.trim()) saveNotCompleted(d.id, reasonText.trim());
                        if (e.key === "Escape") { setReasonFor(null); setReasonText(""); }
                      }}
                      placeholder="Why couldn't it be completed? e.g. Seller refused the drone — needs a re-shoot"
                      className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <button
                      disabled={toggling || !reasonText.trim()}
                      onClick={() => saveNotCompleted(d.id, reasonText.trim())}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setReasonFor(null); setReasonText(""); }}
                      className="rounded-lg px-2 py-2 text-sm text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <label className="block text-sm font-semibold">Anything else for the editor?</label>
          <AutoTextarea
            value={editorBrief}
            onChange={(e) => setEditorBrief(e.target.value)}
            minRows={2}
            placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office."
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <Flag className="size-4 text-danger" /> Flag a problem
          </div>
          <div className="flex gap-2">
            <input
              value={flagInput}
              onChange={(e) => setFlagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitFlag()}
              placeholder="e.g. Couldn’t shoot the garage — heads up for the editor."
              className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <button onClick={submitFlag} className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2">
              Flag
            </button>
          </div>
          {flags.length > 0 && (
            <ul className="mt-2 space-y-1">
              {flags.map((f, i) => (
                <li key={i} className="flex items-center gap-2 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger">
                  <AlertTriangle className="size-3.5" /> {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      </StepCard>

      {/* Submit */}
      <div className="sticky bottom-4 rounded-2xl border bg-surface p-4 shadow-lg">
        {/* In-page confirmation — replaces window.confirm(), which mobile and
            in-app browsers swallow after an await (Harrison's stuck "hold on"). */}
        {ask && (
          <div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground/90">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{ask.body}</span>
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  const a = ask.action;
                  setAsk(null);
                  // Dispatched from THIS render, so it carries whatever the
                  // photographer has typed up to the moment they confirm.
                  if (a.kind === "submit") runSubmit(a.force);
                  else applyToggle(a.id, a.next, a.prevReason);
                }}
                className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
              >
                {ask.yes}
              </button>
              <button
                onClick={() => setAsk(null)}
                className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
              >
                Go back
              </button>
            </div>
          </div>
        )}
        {!done && !ask && (
          <p className="mb-2.5 text-[13px] font-medium text-brand">
            Once submitted, this shoot is added to your payroll.
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {doneCount}/{total} uploaded
          {notDoneCount > 0 && <span className="text-warning"> · {notDoneCount} couldn&rsquo;t be completed</span>}
          {project.photographerName && ` · ${project.photographerName}`}
        </div>
        <button
          onClick={finalize}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {done ? "Re-submit to editors" : "Everything's uploaded — submit"}
        </button>
        </div>
      </div>
    </div>
  );
}
