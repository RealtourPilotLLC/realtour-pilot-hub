// Read-only: the Accelerator product's providers, and Oct 29 slots all-together vs one person at a time.
import { productProvidersFor, AryeoBooking } from "@/lib/integrations/aryeo";
import { aryeoProductFor } from "@/lib/contentProgram";
(async () => {
  const product = aryeoProductFor("Accelerator")!;
  const prov = await productProvidersFor(product.productId);
  console.log("product", product.productId, product.durationMinutes, "providers:", prov.map((p) => `${p.name}:${p.teamMemberId}:${p.bookable ? "bookable" : "no"}`).join(" | "));
  const ids = prov.filter((p) => p.bookable).map((p) => p.teamMemberId);
  const name = new Map(prov.map((p) => [p.teamMemberId, p.name]));
  const t = (s: string) => new Date(s).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  for (const date of ["2026-10-29", "2026-10-30", "2026-11-02"]) {
    const all = await AryeoBooking.timeslotsFor({ date, durationMin: product.durationMinutes, teamMemberIds: ids });
    console.log(date, "ALL:", all.slice(0, 6).map((s) => `${t(s.startAt)}[${(s.userIds ?? []).map((u) => name.get(u) ?? "?" + u.slice(0, 6)).join(",")}]`).join(" "), all.length > 6 ? `…(${all.length})` : "");
    for (const id of ids) {
      const one = await AryeoBooking.timeslotsFor({ date, durationMin: product.durationMinutes, teamMemberIds: [id] });
      console.log("   ", name.get(id), one.length, one.slice(0, 4).map((s) => t(s.startAt)).join(" "));
    }
  }
})();
