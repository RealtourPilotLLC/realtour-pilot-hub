"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { ink } from "@/components/ui/Badge";
import { toggleChecklistItem } from "@/app/actions";
import { ROLE_META } from "@/lib/pipeline";
import { cn } from "@/lib/utils";
import type { Role } from "@prisma/client";

type Item = {
  id: string;
  label: string;
  done: boolean;
  forRole: Role | null;
  assignee: { name: string; avatarColor: string } | null;
};

export function Checklist({ items }: { items: Item[] }) {
  const [local, setLocal] = useState(items);
  const [, startTransition] = useTransition();

  function toggle(id: string, done: boolean) {
    setLocal((prev) => prev.map((i) => (i.id === id ? { ...i, done } : i)));
    startTransition(async () => {
      await toggleChecklistItem(id, done);
    });
  }

  if (local.length === 0) {
    return <p className="text-sm text-muted">No checklist items yet.</p>;
  }

  const doneCount = local.filter((i) => i.done).length;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-success transition-all"
            style={{ width: `${(doneCount / local.length) * 100}%` }}
          />
        </div>
        <span className="text-xs font-medium text-muted">
          {doneCount}/{local.length}
        </span>
      </div>
      <ul className="space-y-1">
        {local.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => toggle(item.id, !item.done)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                  item.done ? "border-success bg-success text-white" : "border-border-strong",
                )}
              >
                {item.done && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <span
                className={cn(
                  "flex-1 text-sm",
                  item.done && "text-muted line-through",
                )}
              >
                {item.label}
              </span>
              {item.assignee ? (
                <Avatar name={item.assignee.name} color={item.assignee.avatarColor} size={20} />
              ) : item.forRole ? (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ color: ink(ROLE_META[item.forRole].color), backgroundColor: "var(--surface-2)" }}
                >
                  {ROLE_META[item.forRole].label}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
