import { CheckCircle2, Circle, Clock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Aryeo } from "@/lib/integrations/aryeo";
import { getSecret } from "@/lib/integrations/connections";
import { formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

type AryeoTask = {
  id?: string;
  name?: string;
  description?: string;
  due_at?: string | null;
  is_completed?: boolean;
  completed_at?: string | null;
  pay_run_item_amount?: number | null;
  quantity?: number;
};

export default async function TasksPage() {
  const connected = await getSecret("aryeo");
  let tasks: AryeoTask[] = [];
  let error: string | null = null;

  if (connected) {
    try {
      const res = await Aryeo.request<{ data: AryeoTask[] }>("/tasks", { query: { per_page: 50 } });
      tasks = res?.data ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load tasks.";
    }
  }

  const open = tasks.filter((t) => !t.is_completed);
  const done = tasks.filter((t) => t.is_completed);

  const Row = ({ t }: { t: AryeoTask }) => (
    <div className="flex items-center gap-3 border-b px-5 py-3 last:border-0">
      {t.is_completed ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" />
      ) : (
        <Circle className="size-4 shrink-0 text-muted-2" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{t.name || "Task"}</div>
        {t.due_at && (
          <div className="inline-flex items-center gap-1 text-xs text-muted">
            <Clock className="size-3" /> due {new Date(t.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        )}
      </div>
      {t.quantity && t.quantity > 1 && <span className="text-xs text-muted-2">×{t.quantity}</span>}
      {typeof t.pay_run_item_amount === "number" && t.pay_run_item_amount > 0 && (
        <span className="text-sm font-semibold">{formatMoney(t.pay_run_item_amount / 100)}</span>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Production & payroll tasks from Aryeo"
        actions={<Badge soft="var(--surface-2)">Live · most recent 50</Badge>}
      />
      <div className="space-y-6 p-6">
        {!connected && <p className="text-sm text-muted">Connect Aryeo to see tasks.</p>}
        {error && <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

        {open.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold">Open ({open.length})</h2>
            <div className="overflow-hidden rounded-2xl border bg-surface">
              {open.map((t, i) => (
                <Row key={t.id ?? i} t={t} />
              ))}
            </div>
          </section>
        )}

        {done.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted">Completed ({done.length})</h2>
            <div className="overflow-hidden rounded-2xl border bg-surface opacity-80">
              {done.map((t, i) => (
                <Row key={t.id ?? i} t={t} />
              ))}
            </div>
          </section>
        )}

        {connected && !error && tasks.length === 0 && (
          <p className="text-sm text-muted">No tasks found.</p>
        )}
      </div>
    </div>
  );
}
