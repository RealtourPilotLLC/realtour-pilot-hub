// Read-only: can Arielle book a session now (September late month, October)?
import { sessionGatesFor } from "@/lib/portal";
import { sessionSlotsFor } from "@/lib/sessionTravel";
(async () => {
  const E = "cmt7msany000c9kg1ospdeoza";
  for (const [k, m] of [["2026-09", "cmti54uo2004xic049w57b8ek"], ["2026-10", "cmup0bq4600qgjg04fi7j19t5"]] as const) {
    const g = await sessionGatesFor(E, m);
    console.log(k, "locked", g.next.locked, "|", g.next.reason, "| earliest", g.next.earliest);
    const s = await sessionSlotsFor({ enrollmentId: E, monthId: m, sessionIndex: 1, package: "Starter" });
    console.log("   slots ok", s.ok, s.needsAddress ? "needsAddress" : "", s.message ?? "", "days", s.days.length, s.days.slice(0, 3).map((d) => d.date).join(","));
  }
})();
