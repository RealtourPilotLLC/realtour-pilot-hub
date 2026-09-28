import { Mail, CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// MAILBOXES — connected, reading and sending, as three separate lines (§9,
// Sep 26 2026). The Gmail card's "Connected" hid a mailbox whose token Google
// had stopped honouring: the scan skipped it with no record, the cron stayed
// green, and the only symptom was email that never showed up. hello@ is where
// every email lead arrives, so a healthy info@ proves nothing about it.
//
//   Connected — the mailbox is in the saved Google map at all.
//   Reading   — the last scan that read its inbox (every five minutes), or the
//               reason the open reconnect task gives.
//   Sending   — the live send-scope probe this page already runs.
// Server component; the page hands it plain data and it never calls Google.
// ---------------------------------------------------------------------------

export type MailboxRow = {
  email: string;
  connected: boolean;
  /** "12m ago" — worded by the page at request time; null = never on record */
  lastReadAgo: string | null;
  problem: string | null;
  reading: boolean;
  /** null = could not check (or not connected) */
  canSend: boolean | null;
};

function Line({ state, label, detail }: { state: "ok" | "bad" | "unknown"; label: string; detail: string }) {
  const Icon = state === "ok" ? CheckCircle2 : state === "bad" ? AlertCircle : MinusCircle;
  const tone = state === "ok" ? "text-success" : state === "bad" ? "text-warning" : "text-muted-2";
  return (
    <p className="flex items-start gap-1.5 text-[12px]">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${tone}`} />
      <span className="min-w-[64px] font-medium text-foreground">{label}</span>
      <span className="text-muted">{detail}</span>
    </p>
  );
}

export function MailboxHealth({ rows }: { rows: MailboxRow[] }) {
  if (rows.length === 0) return null;
  const down = rows.filter((r) => !r.reading).length;
  return (
    <section className="rounded-2xl border bg-surface p-4" data-mailbox-health>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Mail className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">Mailboxes</h2>
        <span className="text-xs text-muted">
          {down === 0 ? "every mailbox is being read" : `${down} of ${rows.length} not being read`}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.email} className="rounded-lg bg-surface-2/50 px-3 py-2">
            <p className="mb-1 truncate text-sm font-medium">{r.email}</p>
            <Line state={r.connected ? "ok" : "bad"} label="Connected" detail={r.connected ? "yes" : "no — this inbox is not in the hub at all"} />
            <Line
              state={r.reading ? "ok" : r.connected || r.problem ? "bad" : "unknown"}
              label="Reading"
              detail={
                r.reading
                  ? `last read ${r.lastReadAgo ?? "recently"}`
                  : r.problem
                    ? `${r.problem}${r.lastReadAgo ? ` · last good read ${r.lastReadAgo}` : ""}`
                    : r.lastReadAgo
                      ? `not since ${r.lastReadAgo}`
                      : "no successful read on record yet"
              }
            />
            <Line
              state={r.canSend === true ? "ok" : r.canSend === false ? "bad" : "unknown"}
              label="Sending"
              detail={r.canSend === true ? "can send" : r.canSend === false ? "cannot send — reconnect and grant sending" : "not checked"}
            />
          </div>
        ))}
      </div>
      {rows.some((r) => r.email.startsWith("hello@") && !r.reading) && (
        <p className="mt-2 text-[12px] text-warning">
          hello@ is where email leads arrive — while it is not read, a new lead by email reaches nobody.
        </p>
      )}
    </section>
  );
}
