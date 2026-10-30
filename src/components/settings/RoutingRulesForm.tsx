"use client";

import { useSettingsDraft } from "@/components/settings/useSettingsDraft";
import { SaveRow } from "@/components/settings/OperatingRules";
import { CheckboxDropdown } from "@/components/ui/CheckboxDropdown";
import { saveEditorRouting } from "@/app/settings/actions";
import { BUILT_IN_VIDEO_EDITORS } from "@/components/editing/videoEditorChoices";
import type { EditorRoutingRules } from "@/lib/settings";

const LANES = [
  { key: "standardVideo", label: "Standard reels & video", hint: "One-off standard edits — next-day promise" },
  { key: "premiumVideo", label: "Premium reels", hint: "The all-out Studio-910-style edits — 3-day internal bar" },
  { key: "personalBranding", label: "Personal branding (monthly)", hint: "Monthly content batches — 7–8h edits" },
] as const;

// Oct 30 2026: a dropdown of checkboxes per lane, not one name. Several ticked
// → each new job goes to whoever would clear it soonest (lib/editorBalance);
// nobody ticked → Needs assigning. `initial.why` is the decision as it stands.
export function RoutingRulesForm({ initial, editors = BUILT_IN_VIDEO_EDITORS }: { initial: EditorRoutingRules; editors?: { key: string; name: string }[] }) {
  const { value: form, setValue: setForm, busy, feedback, dirty, save } = useSettingsDraft({
    standardVideo: initial.pools.standardVideo,
    premiumVideo: initial.pools.premiumVideo,
    personalBranding: initial.pools.personalBranding,
  });
  const options = editors.map((e) => ({ value: e.key, label: e.name }));

  return (
    <div className="space-y-3">
      {LANES.map((lane) => (
        <div key={lane.key} className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{lane.label}</p>
              <p className="text-xs text-muted">{lane.hint}</p>
            </div>
            <CheckboxDropdown
              label={`Editors for ${lane.label}`}
              options={options}
              value={form[lane.key]}
              onChange={(next) => setForm((f) => ({ ...f, [lane.key]: next }))}
              emptyText="Nobody: Needs assigning"
              className="sm:w-72"
            />
          </div>
          {!dirty && initial.why[lane.key] && <p className="text-xs leading-relaxed text-muted">Next job: {initial.why[lane.key]}</p>}
        </div>
      ))}
      <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save routing rules" onSave={() => save(saveEditorRouting)} />
    </div>
  );
}
