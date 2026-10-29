import { MapPin, Phone } from "lucide-react";
import { BrandWordmark } from "@/components/Brand";
import { sessionAddressByToken, addressClientNote, formatAddressLine } from "@/lib/sessionAddress";
import { portalContact } from "@/lib/programMessages";
import type { PortalContact } from "@/components/portal/ContactTeam";
import { submitSessionAddressByToken } from "../actions";

export const dynamic = "force-dynamic";

// A page anyone holding the link can open, so it names nothing it does not have
// to: the session's date and time, the area on file, the form. noindex, like
// the portal itself.
export const metadata = {
  title: "Your filming address | Realtour Pilot",
  robots: { index: false, follow: false },
};

// ---------------------------------------------------------------------------
// /portal/address/<token> — ONE session's exact-address form (CP-05).
//
// The Friday-before-Monday reminder links here, not to the portal: the portal
// link in a reminder is a 15-minute sign-in link that lands on /portal/me, dead
// long before the email is opened. This token is bound to one session, stored
// only as a hash, and closes when the session starts. A save says "Saved" —
// never "confirmed" — until Aryeo reads the new address back.
// ---------------------------------------------------------------------------

// The office line: the owner-editable `portal-contact` (audit E12), never a literal.
function Shell({ contact, children }: { contact: PortalContact; children: React.ReactNode }) {
  return (
    <div className="portal-light fixed inset-0 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 flex justify-center"><BrandWordmark variant="onLight" className="h-5" /></div>
        {children}
        <p className="mt-6 flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted">
          <Phone className="size-3.5" /> Anything changing within 24 hours? Call or text {contact.name} at
          <a href={`tel:${contact.e164}`} className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline">{contact.display}</a>
        </p>
      </div>
    </div>
  );
}

export default async function SessionAddressPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ r?: string; m?: string }>;
}) {
  const { token } = await params;
  const q = await searchParams;
  const [t, contact] = await Promise.all([sessionAddressByToken(token), portalContact()]);
  if (!t.ok) {
    return (
      <Shell contact={contact}>
        <h1 className="text-center text-xl font-semibold tracking-tight">{t.reason === "expired" ? "This link has closed" : "This link isn't active"}</h1>
        <p className="mt-2 text-center text-sm text-muted">
          {t.reason === "expired" ? "The session it was for has started or passed." : "It may have been replaced by a newer email from us."} Call or text {contact.name} at {contact.display} and we&rsquo;ll sort out the address with you.
        </p>
      </Shell>
    );
  }
  const row = t.row;
  const when = row.shootStartAt
    ? `${row.shootStartAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`
    : "your upcoming session";
  const saved = row.submittedAt
    ? formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode })
    : null;
  // text-base: a phone browser zooms into anything smaller on focus (audit E11).
  const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-base outline-none focus:border-brand sm:text-sm";
  return (
    <Shell contact={contact}>
      <h1 className="text-xl font-semibold tracking-tight">Where are we filming?</h1>
      <p className="mt-1 text-sm text-muted">Your filming session is {when}.</p>
      <div className="mt-4 rounded-2xl border border-border bg-surface p-4 text-sm">
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 size-4 shrink-0 text-brand" />
          <div>
            {saved ? (
              <>
                <div className="font-semibold">{saved}</div>
                <div className="text-xs text-muted">{addressClientNote(row.syncState)}</div>
              </>
            ) : (
              <>
                <div className="font-semibold">{row.areaText || "A general area"}</div>
                <div className="text-xs text-muted">That is all we have so far. Add the exact address below so your videographer knows exactly where to go.</div>
              </>
            )}
          </div>
        </div>
      </div>
      {q.m && (
        <p role="status" className={`mt-3 text-sm ${q.r === "ok" ? "text-success" : "text-danger"}`}>{q.m.slice(0, 300)}</p>
      )}
      <form action={submitSessionAddressByToken} className="mt-4 space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block text-xs font-semibold uppercase tracking-widest text-muted-2">Street address
          <input name="street" required autoComplete="address-line1" placeholder="117 Kyle Lane" className={input} />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-widest text-muted-2">Unit (optional)
          <input name="unit" autoComplete="address-line2" placeholder="Unit 2" className={input} />
        </label>
        {/* Phone layout (Jordan, Oct 28 2026): City takes its own row on a phone, so the
            State box is wide enough to show "PA" (it was about 15px of room). */}
        <div className="grid grid-cols-6 gap-3">
          <label className="col-span-6 block text-xs font-semibold uppercase tracking-widest text-muted-2 sm:col-span-3">City
            <input name="city" required autoComplete="address-level2" className={input} />
          </label>
          <label className="col-span-2 block text-xs font-semibold uppercase tracking-widest text-muted-2 sm:col-span-1">State
            <input name="state" required maxLength={2} autoComplete="address-level1" placeholder="PA" className={input} />
          </label>
          <label className="col-span-4 block text-xs font-semibold uppercase tracking-widest text-muted-2 sm:col-span-2">ZIP
            <input name="zip" required inputMode="numeric" maxLength={10} autoComplete="postal-code" className={input} />
          </label>
        </div>
        <p className="text-xs text-muted">A good spot has plenty of natural light, room to move around, and says something about the market you work in.</p>
        <button type="submit" className="min-h-11 w-full rounded-xl bg-brand-action px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90">
          {saved ? "Change the address" : "Save the address"}
        </button>
      </form>
    </Shell>
  );
}
