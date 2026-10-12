"use client";

import { useState } from "react";
import { Inbox, CheckCircle2, Rocket, Archive, MessageSquarePlus } from "lucide-react";
import { decidePlatformFeedback, type FeedbackDecision } from "@/app/feedback/actions";
import { PlatformFeedbackItem, type FeedbackRow } from "./PlatformFeedbackItem";

const GROUPS = [
  { key: "NEW", label: "Needs review", icon: Inbox },
  { key: "APPROVED", label: "Approved — building", icon: Rocket },
  { key: "DONE", label: "Shipped", icon: CheckCircle2 },
  { key: "DECLINED", label: "Declined", icon: Archive },
] as const;

// The board owns each card's status so a decision moves the card to its new
// section the moment it is pressed (Oct 12: Approve used to spin until a page
// refresh that never came). The server's answer confirms it; a refusal puts the
// card back where it was, with the reason on it.
export function FeedbackBoard({ rows: initial, canModerate, pingTargets }: {
  rows: FeedbackRow[];
  canModerate: boolean;
  pingTargets: { id: string; name: string }[];
}) {
  const [rows, setRows] = useState(initial);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const setStatus = (id: string, status: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

  const decide = (id: string, next: FeedbackDecision) => {
    if (saving[id]) return;
    const prev = rows.find((r) => r.id === id)?.status;
    if (!prev) return;
    setStatus(id, next);
    setErrors((e) => ({ ...e, [id]: null }));
    setSaving((s) => ({ ...s, [id]: true }));
    decidePlatformFeedback(id, next)
      .then(
        (r) => {
          if (r.ok) return;
          setStatus(id, prev);
          setErrors((e) => ({ ...e, [id]: r.message }));
        },
        () => {
          setStatus(id, prev);
          setErrors((e) => ({ ...e, [id]: "Couldn't confirm that saved. Reload the board to check." }));
        },
      )
      .finally(() => setSaving((s) => ({ ...s, [id]: false })));
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted">
        <MessageSquarePlus className="mx-auto mb-2 size-6 text-muted-2" />
        No requests yet. Be the first — what would make the hub better?
      </div>
    );
  }

  return (
    <>
      {GROUPS.map((g) => {
        const inGroup = rows.filter((r) => r.status === g.key);
        if (inGroup.length === 0) return null;
        return (
          <section key={g.key}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <g.icon className="size-4 text-muted" /> {g.label}
              <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{inGroup.length}</span>
            </h2>
            <div className="space-y-2">
              {inGroup.map((r) => (
                <PlatformFeedbackItem
                  key={r.id}
                  row={r}
                  canModerate={canModerate}
                  pingTargets={pingTargets}
                  onDecide={(s) => decide(r.id, s)}
                  saving={!!saving[r.id]}
                  error={errors[r.id] ?? null}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
