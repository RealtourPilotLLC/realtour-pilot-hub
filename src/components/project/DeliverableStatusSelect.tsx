"use client";

import { useTransition } from "react";
import { setDeliverableStatus } from "@/app/actions";
import { DELIVERABLE_STATUS_META } from "@/lib/pipeline";
import { ink } from "@/components/ui/Badge";
import { DeliverableStatus } from "@prisma/client";

export function DeliverableStatusSelect({
  id,
  status,
}: {
  id: string;
  status: DeliverableStatus;
}) {
  const [isPending, startTransition] = useTransition();
  const meta = DELIVERABLE_STATUS_META[status];

  return (
    <select
      value={status}
      disabled={isPending}
      onChange={(e) =>
        startTransition(async () => {
          await setDeliverableStatus(id, e.target.value as DeliverableStatus);
        })
      }
      className="cursor-pointer appearance-none rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
      style={{ color: ink(meta.color), backgroundColor: meta.soft }}
    >
      {Object.values(DeliverableStatus).map((s) => (
        <option key={s} value={s} style={{ color: "#0f172a" }}>
          {DELIVERABLE_STATUS_META[s].label}
        </option>
      ))}
    </select>
  );
}
