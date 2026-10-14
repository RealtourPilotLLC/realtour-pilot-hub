"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  decideFindingsAction, setHeroAction, setPhotoExcludedAction, stopFlaggingAction, type ActionResult,
} from "@/app/ops/photo-delivery/actions";
import { EXCLUDE_PRESETS, HUMAN_CALL_LABEL, IGNORE_PRESETS, UNDOABLE, findingPhotoIds, reasonRequired } from "./format";
import { usePrompt, type AskOptions } from "./usePrompt";
import type { CartLineView, FindingView, JobDetail, PhotoView, Viewer } from "./types";

// ---------------------------------------------------------------------------
// The job page's shared state (plan 9.4, 9.5): which photo is open, which tab
// is showing, what is in the Fix Cart, and one way to run a decision so every
// surface (the Issues tab, the lightbox, review mode) asks for a reason the
// same way, shows the same toast, and never double-submits.
// Server actions revalidate the job page, so the data refreshes on its own.
// ---------------------------------------------------------------------------

export type TabKey = "issues" | "cart" | "coverage" | "activity" | "files";
export type DecisionStatus = "IGNORED" | "FALSE_POSITIVE" | "OVERRIDDEN" | "SENT_TO_EDITOR" | "RESHOOT_REQUESTED" | "OPEN";

type Ctx = {
  data: JobDetail;
  viewer: Viewer;
  jobId: string;
  mode: "workspace" | "review";
  photoById: Map<string, PhotoView>;
  /** Every finding that mentions a photo, by photo id. */
  findingsByPhoto: Map<string, FindingView[]>;
  cartLineByFinding: Map<string, CartLineView>;
  selected: Set<string>;
  setSelected: (fn: (s: Set<string>) => Set<string>) => void;
  addToCart: (findingIds: string[]) => boolean;
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
};

const JobCtx = createContext<Ctx | null>(null);

export function useJob(): Ctx {
  const c = useContext(JobCtx);
  if (!c) throw new Error("useJob outside JobProvider");
  return c;
}

/** "Photo 04" for an included photo, else its file name. */
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
  const { toast, show } = useToast();
  const { ask, confirm, dialog, open: promptOpen } = usePrompt();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [cartOpen, setCartOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(initialPhoto);

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
    [show],
  );

  const addToCart = useCallback(
    (findingIds: string[]) => {
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
      setLightbox(null);
      if (mode === "workspace") setTab("cart");
      else setCartOpen(true);
      show("ok", runnable.length === 1 ? "Added to the Fix Cart." : `${runnable.length} fixes added to the Fix Cart.`);
      return true;
    },
    [cartLineByFinding, mode, setSelected, show],
  );

  const decide = useCallback(
    async (list: FindingView[], status: DecisionStatus) => {
      const target = status === "OPEN" ? list.filter((f) => UNDOABLE.has(f.status)) : list.filter((f) => f.status === "OPEN" || UNDOABLE.has(f.status));
      if (!target.length) {
        show("err", "Nothing to change there: those issues are already in a fix or decided.");
        return false;
      }
      const required = reasonRequired(status, target.map((f) => f.severity));
      const n = target.length;
      const what = n === 1 ? "this issue" : `these ${n} issues`;
      let reason: string | null = null;
      if (status === "IGNORED" && required) {
        reason = await ask({ title: `Ignore ${what}?`, description: "A major or critical issue needs a reason. It stays in the activity log.", presets: IGNORE_PRESETS, required: true, confirmLabel: "Ignore" });
        if (reason === null) return false;
      } else if (status === "FALSE_POSITIVE" && required) {
        reason = await ask({
          title: n === 1 ? "Not an issue?" : `Mark ${n} issues as not an issue?`,
          description: "Say what QC got wrong. False positives are how the checks get better.",
          presets: ["Nothing like this is in the photo", "It is part of the house", "It is intended staging"],
          required: true,
          confirmLabel: "Not an issue",
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
    [ask, jobId, run, show],
  );

  const excludePhoto = useCallback(
    async (photo: PhotoView, exclude: boolean) => {
      if (!exclude) return run(() => setPhotoExcludedAction({ jobId, photoId: photo.id, excluded: false }));
      const reason = await ask({
        title: `Leave ${photoTitle(photo)} out of the delivery?`,
        description: "Its own open issues are set aside with this reason. Putting it back reopens them.",
        presets: EXCLUDE_PRESETS,
        required: true,
        confirmLabel: "Leave it out",
      });
      if (reason === null) return false;
      return run(() => setPhotoExcludedAction({ jobId, photoId: photo.id, excluded: true, reason }));
    },
    [ask, jobId, run],
  );

  const makeHero = useCallback((photo: PhotoView) => run(() => setHeroAction(jobId, photo.id)), [jobId, run]);

  const stopFlagging = useCallback(
    async (ruleId: string, label: string) => {
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
    [ask, jobId, run],
  );

  const value: Ctx = {
    data,
    viewer,
    jobId,
    mode,
    photoById,
    findingsByPhoto,
    cartLineByFinding,
    selected,
    setSelected,
    addToCart,
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
  };
  return (
    <JobCtx.Provider value={value}>
      {children}
      {dialog}
      {toast}
    </JobCtx.Provider>
  );
}
