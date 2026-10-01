import { Button, ActionLink } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { Badge } from "@/components/ui/Badge";

/** Fixed fictional comparison data. No domain readers, mutations or providers. */
export function ControlStates({ prefix = "fixture" }: { prefix?: string }) {
  return <div className="space-y-5 rounded-2xl border border-border bg-surface p-4 text-foreground sm:p-6">
    <div className="flex flex-wrap gap-2">
      <Button>Save example</Button>
      <Button variant="secondary">Review example</Button>
      <Button variant="quiet">More information</Button>
      <Button variant="danger">Remove example</Button>
      <Button busy busyLabel="Saving example…">Save example</Button>
      <Button disabled title="The example rollout is off">Unavailable example</Button>
      <ActionLink href={`#${prefix}-filtered`}>Jump to filtered state</ActionLink>
    </div>
    <p className="text-sm text-muted">These are inert examples. Unavailable actions retain their explanation; no record is changed.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField id={`${prefix}-loaded`} label="Loaded field" defaultValue="Example saved value" readOnly hint="This field shows the loaded value." />
      <TextField id={`${prefix}-failed`} label="Failed save" defaultValue="Example retained input" readOnly error="The save could not be confirmed. This input is still here." />
    </div>
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <SaveStatus state="loaded" />
      <SaveStatus state="dirty" />
      <SaveStatus state="saving" />
      <SaveStatus state="saved" message="The submitted example was confirmed." />
      <SaveStatus state="error" message="Try the same example again." />
      <SaveStatus state="partial" message="One example file is confirmed; the other still needs checking." />
    </div>
    <div className="flex flex-wrap gap-2">
      <Badge color="var(--success)" soft="var(--success-soft)">Confirmed</Badge>
      <Badge color="var(--warning)" soft="var(--warning-soft)">Needs attention</Badge>
      <Badge color="var(--danger)" soft="var(--danger-soft)">Failed</Badge>
      <Badge>Not recorded</Badge>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border p-4"><p className="font-medium">Nothing waiting</p><p className="mt-1 text-sm text-muted">The example queue was checked and is empty.</p></div>
      <div id={`${prefix}-filtered`} className="scroll-mt-24 rounded-xl border border-border p-4"><p className="font-medium">No matches</p><p className="mt-1 text-sm text-muted">The example queue has work; none matches the selected filters.</p></div>
    </div>
  </div>;
}
