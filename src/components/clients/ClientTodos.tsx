"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarDays, CheckCircle2, Loader2, ListTodo, ArrowRight } from "lucide-react";
import { setSmartTaskStatus } from "@/app/actions";
import { etDateTime } from "@/lib/datetime";

export type ClientTodo = {
  id: string;
  title: string;
  taskType: string;
  dueAt: string | null;
  projectId: string | null;
};

// Open to-dos on the client page. Each is completable inline (so reply/instruction
// tasks that aren't tied to a project — e.g. an assistant's text — can still be
// cleared). Project-tied tasks link to the project; the rest rely on the chat
// that's already on this page.
export function ClientTodos({ todos }: { todos: ClientTodo[] }) {
  const [items, setItems] = useState(todos);
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  if (items.length === 0) return null;

  const complete = (id: string) => {
    setPendingId(id);
    start(async () => {
      await setSmartTaskStatus(id, "COMPLETED");
      setItems((cur) => cur.filter((t) => t.id !== id));
      setPendingId(null);
      router.refresh();
    });
  };

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ListTodo className="size-4 text-muted" /> Open to-dos
      </h2>
      <div className="space-y-2">
        {items.map((t) => (
          <div key={t.id} className="rounded-xl border bg-surface p-3">
            <div className="flex items-start gap-2">
              <button
                onClick={() => complete(t.id)}
                disabled={pendingId === t.id}
                title="Mark complete"
                className="mt-0.5 shrink-0 text-muted transition-colors hover:text-success disabled:opacity-50"
              >
                {pendingId === t.id ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  {t.dueAt && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="size-3" /> due {etDateTime(t.dueAt)}
                    </span>
                  )}
                  {t.projectId && (
                    <Link href={`/projects/${t.projectId}`} className="inline-flex items-center gap-0.5 text-brand hover:underline">
                      Open project <ArrowRight className="size-3" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
