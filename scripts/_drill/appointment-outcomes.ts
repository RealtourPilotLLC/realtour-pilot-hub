// Signed real appointment actions on disposable rows. Aryeo methods are explicit
// pure fakes; every external destination is fenced. No real booking or email.
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
installNextStubs();
const writes: { kind: string; id: string; body: unknown }[] = [];
let providerFails = false, activityFails = false;
let remote: Record<string, unknown> = {};
interceptModule((r) => r === "@/lib/integrations/aryeo", (loaded) => {
  const m = loaded as { Aryeo: Record<string, unknown> };
  return { ...m, Aryeo: { ...m.Aryeo,
    rescheduleAppointment: async (id: string, body: unknown) => { writes.push({ kind: "reschedule", id, body }); if (providerFails) throw new Error("isolated provider timeout"); },
    cancelAppointment: async (id: string, body: unknown) => { writes.push({ kind: "cancel", id, body }); if (providerFails) throw new Error("isolated provider timeout"); },
    appointment: async () => remote,
  } };
});
interceptModule((r) => r === "@/lib/prisma", (loaded) => {
  const m = loaded as { prisma: Record<PropertyKey, unknown> };
  const bind = (v: unknown, self: object) => typeof v === "function" ? v.bind(self) : v;
  return { ...m, prisma: new Proxy(m.prisma, { get(t, key) {
    const value = Reflect.get(t, key, t);
    if (key !== "activity") return bind(value, t);
    return new Proxy(value as Record<PropertyKey, unknown>, { get(d, method) {
      const fn = Reflect.get(d, method, d);
      if (method === "create") return async (args: unknown) => { if (activityFails) throw new Error("isolated post-provider timeline failure"); return (fn as (a: unknown) => Promise<unknown>).call(d, args); };
      return bind(fn, d);
    } });
  } }) };
});
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5975), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-appointment-result-secret" } });
  const c = makeChecker(), fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const a = await import("@/app/actions");
    const owner = await prisma.appUser.create({ data: { email: "office-appointment@example.test", name: "Fixture Office", role: "OWNER", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "editor-appointment@example.test", name: "Kim", editorKey: "kim", role: "EDITOR", status: "ACTIVE" } });
    const as = (u: typeof owner, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    await as(owner);
    const client = await prisma.client.create({ data: { name: "Appointment Outcome Fixture" } });
    const p = await prisma.project.create({ data: { clientId: client.id, title: "117 Exact Appointment Lane" } });
    const appt = await prisma.appointment.create({ data: { projectId: p.id, aryeoId: "fixture-provider-appointment", startAt: new Date("2026-10-01T15:00:00Z"), durationMin: 75, status: "SCHEDULED", canReschedule: true, canCancel: true } });
    const date = "2026-10-02T16:30:00.000Z";
    const refused = (value: { ok: boolean; outcome?: string }) => !value.ok && value.outcome === "refused";
    c.ok("missing connection is a typed pre-provider refusal for both actions", refused(await a.rescheduleAppointmentAction(appt.id, date, false)) && refused(await a.cancelAppointmentAction(appt.id, false)) && writes.length === 0);
    await saveSecret("aryeo", "isolated-fake-provider-secret");
    c.ok("missing appointment is a typed pre-provider refusal", refused(await a.rescheduleAppointmentAction("missing", date, false)) && refused(await a.cancelAppointmentAction("missing", false)) && writes.length === 0);
    await prisma.appointment.update({ where: { id: appt.id }, data: { canReschedule: false, canCancel: false } });
    c.ok("provider eligibility booleans retain their original refusal before any write", refused(await a.rescheduleAppointmentAction(appt.id, date, false)) && refused(await a.cancelAppointmentAction(appt.id, false)) && writes.length === 0);
    await prisma.appointment.update({ where: { id: appt.id }, data: { canReschedule: true, canCancel: true } });
    c.ok("invalid date remains an explicit pre-write refusal", refused(await a.rescheduleAppointmentAction(appt.id, "invalid", false)) && writes.length === 0);
    const test = await prisma.client.create({ data: { name: "TEST Protected Appointment" } });
    const tp = await prisma.project.create({ data: { clientId: test.id, title: "Protected fixture appointment" } });
    const ta = await prisma.appointment.create({ data: { projectId: tp.id, aryeoId: "fixture-protected-provider-appointment", canCancel: true, canReschedule: true } });
    c.ok("existing TEST-provider-write guard is still refused for both operations", refused(await a.rescheduleAppointmentAction(ta.id, date, false)) && refused(await a.cancelAppointmentAction(ta.id, false)) && writes.length === 0);
    providerFails = true;
    const uncertainReschedule = await a.rescheduleAppointmentAction(appt.id, date, true);
    const uncertainCancel = await a.cancelAppointmentAction(appt.id, false);
    c.ok("provider timeout is unknown, never a retry-authorizing refusal", !uncertainReschedule.ok && uncertainReschedule.outcome === "unknown" && !uncertainCancel.ok && uncertainCancel.outcome === "unknown" && writes.length === 2 && await prisma.activity.count() === 0);
    c.ok("exact provider ID/duration/notify payload remains unchanged on uncertain reschedule", writes[0].id === appt.aryeoId && JSON.stringify(writes[0].body) === JSON.stringify({ start_at: date, end_at: "2026-10-02T17:45:00.000Z", notify: true }) && JSON.stringify(writes[1].body) === JSON.stringify({ notify: false }));
    providerFails = false; remote = { start_at: date, end_at: "2026-10-02T17:45:00Z", status: "SCHEDULED", can_cancel: true, can_reschedule: true };
    const confirmed = await a.rescheduleAppointmentAction(appt.id, date, false);
    c.ok("acknowledged reschedule still refreshes exact appointment/project and logs before confirmation", confirmed.ok && confirmed.outcome === "confirmed" && (await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).startAt?.toISOString() === date && (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).shootDate?.toISOString() === date && await prisma.activity.count({ where: { projectId: p.id, type: "SYSTEM" } }) === 1);
    remote = { ...remote, status: "CANCELED" }; const canceled = await a.cancelAppointmentAction(appt.id, true);
    c.ok("acknowledged cancel keeps existing cancellation refresh/timeline and explicit notify", canceled.ok && canceled.outcome === "confirmed" && writes.at(-1)?.id === appt.aryeoId && JSON.stringify(writes.at(-1)?.body) === JSON.stringify({ notify: true }) && await prisma.activity.count({ where: { projectId: p.id, type: "FLAG" } }) === 1);
    activityFails = true; let thrown = false; try { await a.rescheduleAppointmentAction(appt.id, date, false); } catch { thrown = true; }
    c.ok("post-provider local failure still rejects rather than falsely returning known refusal", thrown && writes.length === 5); activityFails = false;
    for (const [label, u, preview] of [["editor", editor], ["owner preview", owner, editor.id]] as const) {
      await as(u, preview); let denied = 0; const before = writes.length;
      try { await a.rescheduleAppointmentAction(appt.id, date, false); } catch { denied++; }
      try { await a.cancelAppointmentAction(appt.id, false); } catch { denied++; }
      c.ok(`${label} still cannot write appointment/provider state`, denied === 2 && writes.length === before);
    }
    c.ok("isolated fake contract performs no real provider/email/booking/finance operation", fence.faked.length === 0 && fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
