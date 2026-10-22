// Read-only (writes only the slot cache): the times Erica's October session offers now, and whose they are.
import { sessionSlotsFor } from "@/lib/sessionTravel";
(async () => {
  const r = await sessionSlotsFor({ enrollmentId: "cmt7h6b0300059kcj990r34x7", monthId: "cmucv446y0046lc043pq9mitr", sessionIndex: 1, package: "Accelerator" });
  const t = (s: string) => new Date(s).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  console.log("ok", r.ok, r.message ?? "");
  for (const d of r.days.slice(0, 6)) {
    const s0 = d.slots[0];
    console.log(d.date, d.slots.length, "starts; first", t(s0), "with", JSON.stringify((d.slotCreatives?.[s0] ?? []).map((c: { name?: string | null }) => c.name)));
  }
})();
