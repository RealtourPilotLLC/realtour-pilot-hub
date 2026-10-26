import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// THE KEY VALUES OF A SETTINGS SECTION AT A GLANCE (Oct 26 2026). The same
// facts on the overview tile and under the section's heading, read from the
// same values the forms below were given. "Couldn't read" is a value of its
// own (tone "warn"), never a default dressed up as the saved one.

export type SettingsFact = { label: string; value: ReactNode; tone?: "ok" | "warn" | "muted" };

const TONE = { ok: "text-success", warn: "text-warning", muted: "text-muted" } as const;

export function SettingsFacts({ facts, layout = "rows" }: { facts: SettingsFact[]; layout?: "rows" | "grid" }) {
  if (layout === "grid") {
    return (
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-ui-status text-muted">{f.label}</dt>
            <dd className={cn("mt-0.5 break-words text-sm font-medium", f.tone && TONE[f.tone])}>{f.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="space-y-1.5">
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="shrink-0 text-muted">{f.label}</dt>
          <dd className={cn("min-w-0 break-words text-right font-medium", f.tone && TONE[f.tone])}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
