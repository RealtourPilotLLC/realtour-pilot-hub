import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Settings → AutoHDR balance is retired (audit C14, Oct 20 2026). Nothing
// linked here any more, and its manual reading form asked Kyle to type a
// dollar balance (Kyle never sees dollars). The live credit monitor on the
// Photo Delivery Credits page reads the balance through the AutoHDR API and
// carries the alert levels, so an old bookmark lands there.
export default function AutohdrSettingsPage() {
  redirect("/ops/photo-delivery/credits");
}
