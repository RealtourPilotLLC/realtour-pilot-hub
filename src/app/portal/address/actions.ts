"use server";

import { redirect } from "next/navigation";

// ---------------------------------------------------------------------------
// The one write the emailed address link can make (CP-05): save the exact
// filming address for THE session its token is bound to. Nothing else — the
// token is not a portal login and opens no other page or action. The page is
// a plain HTML form, so it works on any phone without JavaScript; the answer
// comes back as a short status on the same page (never the address itself in
// the URL — only the token already there and a client-safe sentence).
// ---------------------------------------------------------------------------

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "").slice(0, 200);

export async function submitSessionAddressByToken(formData: FormData): Promise<void> {
  const token = field(formData, "token");
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) redirect("/portal/login");
  const { submitSessionAddress } = await import("@/lib/sessionAddress");
  const r = await submitSessionAddress(
    { kind: "TOKEN", token },
    { street: field(formData, "street"), unit: field(formData, "unit"), city: field(formData, "city"), state: field(formData, "state"), zip: field(formData, "zip") },
  ).catch(async () => {
    // The owner-editable office line (audit E12), never a typed-out number.
    const c = await import("@/lib/programMessages").then((m) => m.portalContact()).catch(() => null);
    return { ok: false, message: c ? `That didn't save. Try again, or call or text ${c.name} at ${c.display}.` : "That didn't save. Try again." };
  });
  const q = new URLSearchParams({ r: r.ok ? "ok" : "err", m: r.message.slice(0, 300) });
  redirect(`/portal/address/${token}?${q.toString()}`);
}
