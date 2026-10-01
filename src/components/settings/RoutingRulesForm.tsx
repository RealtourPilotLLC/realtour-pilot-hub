"use client";

import { useSettingsDraft } from "@/components/settings/useSettingsDraft";
import { SaveRow } from "@/components/settings/OperatingRules";
import { saveEditorRouting } from "@/app/settings/actions";
import type { EditorRoutingRules } from "@/lib/settings";

const LANES = [
  { key: "standardVideo", label: "Standard reels & video", hint: "One-off standard edits — next-day promise" },
  { key: "premiumVideo", label: "Premium reels", hint: "The all-out Studio-910-style edits — 3-day internal bar" },
  { key: "personalBranding", label: "Personal branding (monthly)", hint: "Monthly content batches — 7–8h edits" },
] as const;

const CHOICES = [
  { value: "john", label: "John Mark" },
  { value: "kim", label: "Kim" },
  { value: "manual", label: "Manual — Needs assigning" },
];

export function RoutingRulesForm({ initial }: { initial: EditorRoutingRules }) {
  const { value: form, setValue: setForm, busy, feedback, dirty, save } = useSettingsDraft({
    standardVideo: initial.standardVideo ?? "manual",
    premiumVideo: initial.premiumVideo ?? "manual",
    personalBranding: initial.personalBranding ?? "manual",
  });

  return (
    <div className="space-y-3">
      {LANES.map((lane) => (
        <div key={lane.key} className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface-2/40 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">{lane.label}</p>
            <p className="text-xs text-muted">{lane.hint}</p>
          </div>
          <select
            value={form[lane.key]}
            onChange={(e) => { setForm((f) => ({ ...f, [lane.key]: e.target.value })); }}
            aria-label={lane.label}
            className="min-h-11 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-brand"
          >
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      ))}
      <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save routing rules" onSave={() => save(saveEditorRouting)} />
    </div>
  );
}
