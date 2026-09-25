import { CalendarCheck2, MapPin } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Section } from "@/components/ui/Section";
import { sessionPanelAction } from "@/app/content/[id]/workspaceActions";
import { formatAddressLine } from "@/lib/sessionAddress";
import { sessionRequestLabel } from "@/lib/sessionRequests";

// ---------------------------------------------------------------------------
// SESSIONS PANEL (CP-04 / CP-05, Sep 24 2026) — the staff view of every
// session REQUEST for the month and every exact ADDRESS a session was given.
//
// What was missing: confirm / decline / approve-extra had no caller at all, so
// a request the reconcile marked AMBIGUOUS could never be settled ("open the
// request and confirm which one" pointed at no screen). And the booking
// adapter's states — the marker written into the Aryeo order, what Aryeo
// answered, why it stopped — lived only in the database.
//
// A server component of plain forms: every button posts to sessionPanelAction
// (workspaceActions.ts), which writes the ledger and never calls Aryeo.
// Requested and confirmed are never shown alike: the status chip says which.
// ---------------------------------------------------------------------------

const fmt = (d: Date | null) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "no time");

const chip = (tone: "ok" | "warn" | "bad" | "muted") =>
  `shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${tone === "ok" ? "bg-success/15 text-success" : tone === "warn" ? "bg-warning/15 text-warning" : tone === "bad" ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted"}`;

const STUCK = new Set(["RECONCILE", "REJECTED", "MISMATCH", "CONFLICT", "UNKNOWN", "FAILED"]);

export async function SessionsPanel({ enrollmentId, monthId }: { enrollmentId: string; monthId: string }) {
  const [requests, addresses] = await Promise.all([
    prisma.programSessionRequest.findMany({ where: { enrollmentId, monthId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.programSessionAddress.findMany({ where: { enrollmentId, monthId }, orderBy: { shootStartAt: "asc" }, take: 20 }),
  ]);
  if (requests.length === 0 && addresses.length === 0) return null;
  const attempts = requests.length
    ? await prisma.programBookingAttempt.findMany({ where: { requestId: { in: requests.map((r) => r.id) } }, orderBy: [{ requestId: "asc" }, { createdAt: "asc" }] })
    : [];
  const ambiguousCandidates = (json: string | null): { appointmentId: string; startAt: string | null }[] => {
    try { return ((JSON.parse(json ?? "{}") as { candidates?: { appointmentId: string; startAt: string | null }[] }).candidates ?? []); } catch { return []; }
  };
  const btn = "rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2";
  const input = "rounded-lg border border-border bg-surface px-2 py-1 text-xs";
  const hidden = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);

  return (
    <div className="mt-4 space-y-4">
      {requests.length > 0 && (
        <Section icon={CalendarCheck2} title="Session requests" count={requests.length} flush>
          <div className="divide-y divide-border">
            {requests.map((r) => {
              const tone = r.status === "CONFIRMED" ? "ok" : STUCK.has(r.bookingState) || r.status === "CANCEL_REQUESTED" ? "bad" : r.status === "REQUESTED" ? "warn" : "muted";
              const mine = attempts.filter((a) => a.requestId === r.id);
              const unknownOrder = mine.some((a) => a.id === r.currentAttemptId && (a.state === "ORDER_UNKNOWN" || a.state === "ORDER_SENT"));
              return (
                <div key={r.id} className="px-5 py-3.5 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{fmt(r.slotStart)}</span>
                    {r.creativeName && <span className="text-muted">· {r.creativeName}</span>}
                    {r.locationText && <span className="text-muted">· {r.locationText}</span>}
                    {r.kind === "EXTRA_SESSION" && <span className={chip(r.extraApprovedBy ? "ok" : "warn")}>extra{r.extraApprovedBy ? " approved" : ""}</span>}
                    <span className="ml-auto" />
                    <span className={chip(tone)}>{r.status}{r.bookingState !== "NONE" ? ` · ${r.bookingState}` : ""}</span>
                  </div>
                  <div className="mt-0.5 text-muted">
                    Client sees: “{sessionRequestLabel(r.status, r.bookingState)}”
                    {r.bookingState === "NONE" ? " · desk-assisted" : ""}
                    {r.matchState ? ` · matched by ${r.matchState}` : ""}
                    {r.aryeoOrderId ? ` · order ${r.aryeoOrderId}` : ""}
                    {r.aryeoAppointmentId ? ` · appointment ${r.aryeoAppointmentId}` : ""}
                  </div>
                  {r.lastError && <div className="mt-0.5 text-warning">{r.lastError}</div>}
                  {mine.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-2">
                      {mine.map((a) => (
                        <li key={a.id}>
                          {a.kind} #{a.attemptNo} · <code>{a.marker}</code> · {a.state}{a.aryeoOrderId ? ` · order ${a.aryeoOrderId}` : ""}{a.recoveryScans ? ` · ${a.recoveryScans} scan${a.recoveryScans === 1 ? "" : "s"}` : ""}{a.lastError ? ` · ${a.lastError}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <form action={sessionPanelAction} className="flex items-center gap-1.5">
                        {hidden({ op: "confirm", enrollmentId, requestId: r.id })}
                        {r.matchState === "AMBIGUOUS" ? (
                          <select name="appointmentId" className={input} required>
                            {ambiguousCandidates(r.matchEvidenceJson).map((c) => <option key={c.appointmentId} value={c.appointmentId}>{c.startAt ? fmt(new Date(c.startAt)) : "no time"} · {c.appointmentId}</option>)}
                          </select>
                        ) : (
                          <input name="appointmentId" placeholder="Aryeo appointment id" defaultValue={r.aryeoAppointmentId ?? ""} className={input} />
                        )}
                        <button className={btn}>Confirm</button>
                      </form>
                      <form action={sessionPanelAction} className="flex items-center gap-1.5">
                        {hidden({ op: "decline", enrollmentId, requestId: r.id })}
                        <input name="reason" placeholder="Why (the client sees 'Not available')" className={input} />
                        <button className={btn}>Decline</button>
                      </form>
                      {r.kind === "EXTRA_SESSION" && !r.extraApprovedBy && (
                        <form action={sessionPanelAction}>{hidden({ op: "approveExtra", enrollmentId, requestId: r.id })}<button className={btn}>Approve extra</button></form>
                      )}
                      {STUCK.has(r.bookingState) && r.bookingState !== "MISMATCH" && (
                        <form action={sessionPanelAction} className="flex items-center gap-1.5">
                          {hidden({ op: "retry", enrollmentId, requestId: r.id })}
                          {unknownOrder && (
                            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirmedNoOrder" required /> I searched Aryeo for the note and no order carries it</label>
                          )}
                          <button className={btn}>Retry booking</button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {addresses.length > 0 && (
        <Section icon={MapPin} title="Filming addresses" count={addresses.length} flush>
          <div className="divide-y divide-border">
            {addresses.map((a) => {
              const line = a.submittedAt ? formatAddressLine({ streetNumber: a.streetNumber, streetName: a.streetName, unit: a.unitNumber, city: a.city, stateCode: a.stateCode, postalCode: a.postalCode }) : null;
              const tone = a.syncState === "SYNCED" ? "ok" : a.syncState === "FAILED" || a.syncState === "CONFLICT" ? "bad" : a.submittedAt ? "warn" : "muted";
              return (
                <div key={a.id} className="px-5 py-3.5 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{fmt(a.shootStartAt)}</span>
                    <span className="text-muted">· {line ?? `area only: ${a.areaText ?? "none"}`}</span>
                    <span className="ml-auto" />
                    <span className={chip(tone)}>{a.submittedAt ? a.syncState : "WAITING FOR CLIENT"}{a.version > 1 ? ` · v${a.version}` : ""}</span>
                  </div>
                  <div className="mt-0.5 text-muted">
                    Session {a.sessionKey}{a.aryeoOrderId ? ` · order ${a.aryeoOrderId}` : ""}{a.submittedBy ? ` · from ${a.submittedBy}` : ""}{a.taskId ? " · Kyle has a task" : ""}
                  </div>
                  {a.lastError && <div className="mt-0.5 text-warning">{a.lastError}</div>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {a.submittedAt && a.syncState !== "SYNCED" && (
                      <form action={sessionPanelAction}>{hidden({ op: "addressRecheck", enrollmentId, rowId: a.id })}<button className={btn}>Recheck now</button></form>
                    )}
                    <form action={sessionPanelAction} className="flex flex-wrap items-center gap-1.5">
                      {hidden({ op: "addressSet", enrollmentId, sessionKey: a.sessionKey })}
                      <input name="street" placeholder="Street" required className={input} />
                      <input name="unit" placeholder="Unit" className={`${input} w-16`} />
                      <input name="city" placeholder="City" required className={`${input} w-28`} />
                      <input name="state" placeholder="ST" maxLength={2} required className={`${input} w-12`} />
                      <input name="zip" placeholder="ZIP" required className={`${input} w-20`} />
                      <button className={btn}>Set exact address</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}
