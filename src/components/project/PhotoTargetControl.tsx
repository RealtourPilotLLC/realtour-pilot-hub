"use client";

import { useState, useTransition } from "react";
import { Camera, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { setPhotoTarget } from "@/app/actions";

// Owner/admin control for a project's photo-culling BUDGET. Shows the effective
// target (explicit override or the computed default) and lets the owner pin it
// to 50 / 80 / a custom number, or clear it back to auto. Counts only — no money.
//
// `computed` is photoTargetFor with the override stripped (the sq-ft default), so
// the "auto" hint reads correctly whether or not an override is set.
export function PhotoTargetControl({
  projectId,
  photoTarget,
  computed,
  squareFeet,
}: {
  projectId: string;
  photoTarget: number | null;
  computed: number;
  squareFeet: number | null;
}) {
  const [pending, startTransition] = useTransition();
  const [custom, setCustom] = useState("");
  const effective = photoTarget ?? computed;

  function save(target: number | null) {
    startTransition(async () => {
      try {
        await setPhotoTarget(projectId, target);
        setCustom("");
      } catch {
        /* the page revalidates on success; a failure just leaves state as-is */
      }
    });
  }

  const chip = (label: string, value: number | null, active: boolean) => (
    <button
      key={label}
      type="button"
      disabled={pending}
      onClick={() => save(value)}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors disabled:opacity-50",
        active
          ? "bg-brand text-white ring-brand"
          : "bg-surface-2 text-muted ring-transparent hover:bg-surface hover:ring-border",
      )}
    >
      {active && <Check className="mr-1 inline size-3" />}
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border bg-surface-2/40 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Camera className="size-3.5 text-brand" />
        Photo budget
        {pending && <Loader2 className="size-3 animate-spin text-muted-2" />}
        <span className="ml-auto font-normal text-muted">
          Effective: <strong className="text-foreground">~{effective}</strong>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {chip("Auto", null, photoTarget == null)}
        {chip("40", 40, photoTarget === 40)}
        {chip("50", 50, photoTarget === 50)}
        {chip("60", 60, photoTarget === 60)}
        {chip("70", 70, photoTarget === 70)}
        {chip("90", 90, photoTarget === 90)}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseInt(custom, 10);
            if (!Number.isNaN(n)) save(n);
          }}
          className="flex items-center gap-1"
        >
          <input
            type="number"
            min={1}
            max={500}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Custom"
            className="w-20 rounded-full border bg-surface px-2.5 py-1 text-xs outline-none focus:border-brand"
          />
          {custom !== "" && (
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-brand px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Set
            </button>
          )}
        </form>
      </div>

      <p className="mt-1.5 text-[11px] text-muted-2">
        {photoTarget == null
          ? `Auto: ${computed}${squareFeet != null ? ` (from ${squareFeet.toLocaleString()} sq ft)` : " (default)"}`
          : `Override set — auto would be ${computed}${squareFeet != null ? ` (from ${squareFeet.toLocaleString()} sq ft)` : ""}.`}
      </p>
    </div>
  );
}
