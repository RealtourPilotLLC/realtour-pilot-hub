"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trophy } from "lucide-react";
import { payQuarterlyBonus } from "@/app/sales/bonusActions";

// Owner-only money button, two-tap (arm → confirm) — the ONE path from the
// bonus math to actual pay. Writes a PayoutAdjustment on the person's next
// payout; the engine itself never pays.
export function PayBonusButton({ memberId, name, amount, quarter }: {
  memberId: string; name: string; amount: number; quarter: string;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const m = `$${Math.round(amount).toLocaleString("en-US")}`;
  if (msg) return <span className="text-[11px] text-muted">{msg}</span>;
  return armed ? (
    <span className="flex items-center gap-1.5">
      <button
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await payQuarterlyBonus(memberId, quarter, amount);
            setMsg(r.message);
            router.refresh();
          })
        }
        className="inline-flex items-center gap-1 rounded-lg bg-success px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Trophy className="size-3" />} Confirm {m} to {name}
      </button>
      <button onClick={() => setArmed(false)} className="text-[11px] text-muted hover:text-foreground">Cancel</button>
    </span>
  ) : (
    <button
      onClick={() => setArmed(true)}
      className="rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/20"
    >
      Pay {m}
    </button>
  );
}
