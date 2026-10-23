"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/Toast";
import {
  decideFindingsAction, setHeroAction, setPhotoExcludedAction, stopFlaggingAction, type ActionResult,
} from "@/app/ops/photo-delivery/actions";
import { EXCLUDE_PRESETS, HUMAN_CALL_LABEL, IGNORE_PRESETS, UNDOABLE, findingPhotoIds, reasonRequired } from "./format";
import { usePrompt, type AskOptions } from "./usePrompt";
import { MIN_OWN_WORDS, needsOwnWords } from "@/lib/photoDelivery/careRules";
import { VIEW_ONLY_NOTE, type CartLineView, type FindingView, type JobDetail, type PhotoView, type Viewer } from "./types";

// ---------------------------------------------------------------------------
// The job page's shared state (plan 9.4, 9.5): which photo is open, which tab
// is showing, what is in the Fix Cart, and one way to run a decision so every
// surface (the Issues tab, the lightbox, review mode) asks for a reason the
// same way, shows the same toast, and never double-submits.
// Server actions revalidate the job page, so the data refreshes on its own.
//
// VIEW ONLY (Oct 22 2026): `readOnly` comes from the server (viewer.readOnly,
// the creative manager) and every surface reads it here to draw no control.
// The writes below also stop on it before calling the server, which refuses
// them on its own anyway (requireAdmin, requireOwner).
// ---------------------------------------------------------------------------

export type TabKey = "issues" | "cart" | "coverage" | "activity" | "files";
export type DecisionStatus = "IGNORED" | "FALSE_POSITIVE" | "OVERRIDDEN" | "SENT_TO_EDITOR" | "RESHOOT_REQUESTED" | "OPEN";

type Ctx = {
  data: JobDetail;
  viewer: Viewer;
  /** Oct 22 2026: the viewer reads the job and acts on none of it (viewer.readOnly): every control hides on it. */
  readOnly: boolean;
  jobId: string;
  mode: "workspace" | "review";
  photoById: Map<string, PhotoView>;
  /** Every finding that mentions a photo, by photo id. */
  findingsByPhoto: Map<string, FindingView[]>;
  cartLineByFinding: Map<string, CartLineView>;
  selected: Set<string>;
  setSelected: (fn: (s: Set<string>) => Set<string>) => void;
  /**
   * Put fixes in the Fix Cart. `stay` (Oct 23 2026, huddle item 6: Fix sent
   * Kyle back to the top of the job and he lost his place): the issue is
   * queued where he is, like Not worth fixing; no tab switch, no drawer, the
   * lightbox stays open. Without it (review mode's F key) the cart opens.
   */
  addToCart: (findingIds: string[], opts?: { stay?: boolean }) => boolean;
  /** Oct 23 2026: findings Kyle pressed Fix on here (queued in the Fix Cart): the Issues tab folds their group away and moves on. */
  queued: Set<string>;
  unqueue: (findingIds: string[]) => void;
  tab: TabKey;
  setTab: (t: TabKey) => void;
  cartOpen: boolean;
  setCartOpen: (v: boolean) => void;
  lightbox: string | null;
  openLightbox: (photoId: string | null) => void;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>) => Promise<boolean>;
  decide: (findings: FindingView[], status: DecisionStatus) => Promise<boolean>;
  /** Owner: stop flagging this check on every shoot (Oct 14 2026). */
  stopFlagging: (ruleId: string, label: string) => Promise<boolean>;
  excludePhoto: (photo: PhotoView, exclude: boolean) => Promise<boolean>;
  makeHero: (photo: PhotoView) => Promise<boolean>;
  ask: (o: AskOptions) => Promise<string | null>;
  confirm: (o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  promptOpen: boolean;
  notify: (kind: "ok" | "err", text: string) => void;
  /** Is this finding at or above the display floor (plan 7.5)? */
  shown: (f: FindingView) => boolean;
  /** Oct 21 2026: the photo open in Straighten and crop (PhotoEditor), from the lightbox or a geometry finding. */
  openEditor: (photoId: string | null) => void;
};

// Oct 21 2026: loaded when first opened (its canvas code is only needed then).
const PhotoEditor = dynamic(() => import("./PhotoEditor"), { ssr: false });

const JobCtx = createContext<Ctx | null>(null);

export function useJob(): Ctx {
  const c = useContext(JobCtx);
  if (!c) throw new Error("useJob outside JobProvider");
  return c;
}

/** "Photo 04" for an included photo (on a split job, its place on the listing), else its file name. */
export function photoTitle(p: PhotoView | undefined | null): string {
  if (!p) return "Photo";
  return p.position ? `Photo ${String(p.position).padStart(2, "0")}` : p.name;
}

export function JobProvider({ data, viewer, mode, initialTab = "issues", initialPhoto = null, children }: {
  data: JobDetail;
  viewer: Viewer;
  mode: "workspace" | "review";
  initialTab?: TabKey;
  initialPhoto?: string | null;
  children: ReactNode;
}) {
  const jobId = data.header.id;
  const readOnly = !!viewer.readOnly;
  const { toast, show } = useToast();
  const { ask, confirm, dialog, open: promptOpen } = usePrompt();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [cartOpen, setCartOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(initialPhoto);
  const [editing, setEditing] = useState<string | null>(null);

  const photoById = useMemo(() => new Map(data.photos.map((p) => [p.id, p])), [data.photos]);
  const findingsByPhoto = useMemo(() => {
    const m = new Map<string, FindingView[]>();
    for (const f of data.findings) {
      for (const id of findingPhotoIds(f)) {
        const list = m.get(id);
        if (list) list.push(f);
        else m.set(id, [f]);
      }
    }
    return m;
  }, [data.findings]);
  const cartLineByFinding = useMemo(() => {
    const m = new Map<string, CartLineView>();
    for (const l of data.cart?.lines ?? []) for (const id of l.findingIds) m.set(id, l);
    return m;
  }, [data.cart]);

  // The workspace starts with the planner's default picks (plan 8.2: all fixable
  // findings selected); review mode starts empty and fills as F is pressed.
  const [selected, setSelectedState] = useState<Set<string>>(() =>
    mode === "workspace" ? new Set((data.cart?.lines ?? []).filter((l) => !l.humanCall && l.selectedByDefault).flatMap((l) => l.findingIds)) : new Set(),
  );
  const setSelected = useCallback((fn: (s: Set<string>) => Set<string>) => setSelectedState((s) => fn(new Set(s))), []);

  const run = useCallback(
    (fn: () => Promise<ActionResult>) =>
      new Promise<boolean>((resolve) => {
        if (readOnly) {
          show("err", VIEW_ONLY_NOTE);
          resolve(false);
          return;
        }
        start(async () => {
          try {
            const r = await fn();
            show(r.ok ? "ok" : "err", r.message);
            resolve(r.ok);
          } catch {
            show("err", "The hub didn't answer. Reload the page to see what is saved.");
            resolve(false);
          }
        });
      }),
    [readOnly, show],
  );

  const [queued, setQueued] = useState<Set<string>>(() => new Set());
  const unqueue = useCallback(
    (findingIds: string[]) => {
      setQueued((q) => new Set([...q].filter((id) => !findingIds.includes(id))));
      setSelected((s) => {
        for (const id of findingIds) s.delete(id);
        return s;
      });
    },
    [setSelected],
  );

  const addToCart = useCallback(
    (findingIds: string[], opts: { stay?: boolean } = {}) => {
      if (readOnly) return false;
      const runnable = findingIds.filter((id) => {
        const l = cartLineByFinding.get(id);
        return !!l && !l.humanCall;
      });
      if (!runnable.length) {
        const line = findingIds.map((id) => cartLineByFinding.get(id)).find(Boolean);
        show("err", line?.humanCall ? HUMAN_CALL_LABEL[line.humanCall] ?? "This one needs a person's call." : "There is no automatic fix for this issue. Send it to the editor or decide it.");
        return false;
      }
      setSelected((s) => {
        for (const id of runnable) s.add(id);
        return s;
      });
      if (opts.stay) {
        // Oct 23 2026 (huddle item 6): queued where Kyle is; the next issue takes its place.
        setQueued((q) => new Set([...q, ...runnable]));
        show("ok", `${runnable.length === 1 ? "Fix queued" : `${runnable.length} fixes queued`} in the Fix Cart. Run them from the Fix Cart tab when you're done here.`);
        return true;
      }
      setLightbox(null);
      if (mode === "workspace") setTab("cart");
      else setCartOpen(true);
      show("ok", runnable.length === 1 ? "Added to the Fix Cart." : `${runnable.length} fixes added to the Fix Cart.`);
      return true;
    },
    [cartLineByFinding, mode, readOnly, setSelected, show],
  );

  const decide = useCallback(
    async (list: FindingView[], status: DecisionStatus) => {
      if (readOnly) return false;
      const target = status === "OPEN" ? list.filter((f) => UNDOABLE.has(f.status)) : list.filter((f) => f.status === "OPEN" || UNDOABLE.has(f.status));
      if (!target.length) {
        show("err", "Nothing to change there: those issues are already in a fix or decided.");
        return false;
      }
      const required = reasonRequired(status, target.map((f) => f.severity));
      const n = target.length;
      const what = n === 1 ? "this issue" : `these ${n} issues`;
      // WHAT THE CLIENT ASKED COMES FIRST (Oct 21 2026): a finding the client
      // asked to have removed is set aside only once that request is answered.
      const asked = status === "IGNORED" || status === "OVERRIDDEN" ? target.find((f) => f.clientAsk)?.clientAsk : null;
      if (asked) {
        show("err", `${asked.label}. Answer that request first (the Deliver panel, Before the photos go out: Done, or Answer with a note), then decide this.`);
        return false;
      }
      let reason: string | null = null;
      // IGNORING WITH CARE (Oct 21 2026, careRules.ts): a major issue outside
      // the house, or one the hub always fixes, needs the person's own words
      // (one reason for the group), never the stock "Not worth a fix". The
      // presets stay for minor and inside items.
      const careful = status === "IGNORED" || status === "OVERRIDDEN" ? target.filter((f) => needsOwnWords({ severity: f.severity, exterior: !!f.exterior, alwaysFixed: !!f.alwaysFixed })) : [];
      if (careful.length) {
        const outside = careful.some((f) => f.exterior);
        const always = careful.some((f) => f.alwaysFixed);
        reason = await ask({
          title: status === "IGNORED" ? (n === 1 ? "Leave this one as it is?" : `Leave these ${n} issues as they are?`) : `Override ${what}?`,
          description: `${outside && always ? "This is outside the house and something the hub always fixes" : outside ? "This is a major issue outside the house" : "This is something the hub always fixes (trash cans, cars, camera mistakes)"}. Write why it can go out as it is: what the client was told, or why it is not a problem on this listing. It stays on the job's activity.`,
          required: true,
          minLength: MIN_OWN_WORDS,
          placeholder: "In your own words, e.g. the client said the forms stay, the builder wants them shown",
          confirmLabel: status === "IGNORED" ? "Leave as is" : "Override",
        });
        if (reason === null) return false;
      } else if (status === "IGNORED") {
        // Oct 23 2026 (huddle item 5): a few words why, kept with the check and
        // the photo. The same reason on several jobs teaches the check house-wide
        // (houseRules.learnedChecks); a minor one can still go without words.
        reason = await ask({
          title: n === 1 ? "Not worth fixing?" : `Mark ${n} issues not worth fixing?`,
          description: required
            ? "It is there, but not worth fixing here. A major or critical issue needs a reason; it stays in the activity log, and the same reason on several jobs teaches the check."
            : "It is there, but not worth fixing here. A few words why (optional) teach the check: the same reason on several jobs stops it flagging this kind of thing.",
          presets: IGNORE_PRESETS,
          required,
          confirmLabel: "Not worth fixing",
        });
        if (reason === null) return false;
      } else if (status === "FALSE_POSITIVE" && required) {
        reason = await ask({
          title: n === 1 ? "Not there?" : `Mark ${n} issues as not there?`,
          description: "The check saw something that is not in the photo. Say what it got wrong: these calls make the hub stricter before it fixes this kind of thing on its own.",
          presets: ["Nothing like this is in the photo", "It is part of the house", "It is intended staging"],
          required: true,
          confirmLabel: "Not there",
        });
        if (reason === null) return false;
      } else if (status === "OVERRIDDEN") {
        reason = await ask({ title: `Override ${what}?`, description: "Delivering with it open needs a reason, kept in the activity log.", required, confirmLabel: "Override" });
        if (reason === null) return false;
      } else if (status === "RESHOOT_REQUESTED") {
        reason = await ask({ title: "Recommend a reshoot", description: "A recommendation for Jordan. Nothing is booked or sent automatically.", required: false, confirmLabel: "Recommend" });
        if (reason === null) return false;
      }
      return run(() => decideFindingsAction({ jobId, findingIds: target.map((f) => f.id), status, reason: reason || null }));
    },
    [ask, jobId, readOnly, run, show],
  );

  const excludePhoto = useCallback(
    async (photo: PhotoView, exclude: boolean) => {
      // Oct 22 2026: a photo already delivered on the listing is not in or out of this delivery.
      if (readOnly || photo.status === "ON_LISTING") return false;
      if (!exclude) return run(() => setPhotoExcludedAction({ jobId, photoId: photo.id, excluded: false }));
      const reason = await ask({
        title: `Leave ${photoTitle(photo)} out of the delivery?`,
        description: "Its own open issues are set aside with this reason. Putting it back reopens them.",
        presets: EXCLUDE_PRESETS,
        required: true,
        confirmLabel: "Leave out",
      });
      if (reason === null) return false;
      return run(() => setPhotoExcludedAction({ jobId, photoId: photo.id, excluded: true, reason }));
    },
    [ask, jobId, readOnly, run],
  );

  const makeHero = useCallback((photo: PhotoView) => (photo.status === "ON_LISTING" ? Promise.resolve(false) : run(() => setHeroAction(jobId, photo.id))), [jobId, run]);

  const stopFlagging = useCallback(
    async (ruleId: string, label: string) => {
      if (readOnly) return false;
      const reason = await ask({
        title: `Stop flagging "${label}"?`,
        description: "QC stops checking for this on every shoot, and its open findings are set aside. Turn it back on any time in Photo Delivery settings.",
        presets: ["We don't need to know this", "Not an issue for us", "Lighting differences are fine", "Not worth fixing"],
        required: false,
        confirmLabel: "Stop flagging it",
      });
      if (reason === null) return false;
      return run(() => stopFlaggingAction({ jobId, ruleId, reason }));
    },
    [ask, jobId, readOnly, run],
  );

  const value: Ctx = {
    data,
    viewer,
    readOnly,
    jobId,
    mode,
    photoById,
    findingsByPhoto,
    cartLineByFinding,
    selected,
    setSelected,
    addToCart,
    queued,
    unqueue,
    tab,
    setTab,
    cartOpen,
    setCartOpen,
    lightbox,
    openLightbox: setLightbox,
    pending,
    run,
    decide,
    stopFlagging,
    excludePhoto,
    makeHero,
    ask,
    confirm,
    promptOpen,
    notify: show,
    shown: (f) => f.confidence >= data.displayFloor,
    // Straighten and crop is the office's edit tool: never opens on a view-only page.
    openEditor: readOnly ? () => {} : setEditing,
  };
  return (
    <JobCtx.Provider value={value}>
      {children}
      {editing && !readOnly && <PhotoEditor photoId={editing} onClose={() => setEditing(null)} />}
      {dialog}
      {toast}
    </JobCtx.Provider>
  );
}
