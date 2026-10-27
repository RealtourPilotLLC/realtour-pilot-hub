// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// The job page's shoot brief, read into fields (Jordan, Oct 27 2026: "Shoot
// Briefs should be expanded and visible - and the info should be parsed and
// added to their own fields"). Pure parser + the view's markup. No database,
// no Aryeo, no network.
import { renderToStaticMarkup } from "react-dom/server";
import { makeChecker } from "./_harness";

// Mike Flatley's 658 W Ridge Pike appointment, as Aryeo writes it.
const FLATLEY = `Customer:
Name: Mike Flatley
Email: mike@garymercerteam.com
Phone: (484) 744-9700
Notes: n/a

Order Items Serviced By This Appointment:
 - (1x) Social Influencer: 0-1,999 Sq. Ft.
 - (1x) Zillow Showcase 3D Tour Add-on: 0 - 1,999 Sq. Ft.

Order Notes:
n/a

Order Questions:
 - Will you or the seller be present at the appointment?: Agent
 - Lock Box / Door Code:
 - Additional information to access the property:
 - Special Instructions for the photographer (for this property only):
 - Is the time of the appointment flexible on the requested day?: Not Flexible - keep appointment for the scheduled time
 - Waitlist: No - I am happy with the current date/time
 - Square Footage: 1300

Or View Full Order Details:
https://app.aryeo.com/admin/orders/01a0e472-5ac0-73cd-94a7-cbeaaa85f0b7/edit

Capture Zillow 3D Home Tour:
https://www.zillow.com/3dtour/capture_order?includeFloorPlan=true&includeUfo=false&isLms=false&makePublic=true&listingId=01a0e476-8640-71dd-aa90-70369354c12a&source=a34b1908-d279-475e-8ec3-a7d8b9a459aa&address=658%20W%20Ridge%20Pike%2C%20Royersford%2C%20PA%2019468`;

async function main() {
  const c = makeChecker();
  const { parseAppointmentBrief } = await import("@/lib/appointmentBrief");
  const { ShootBriefView } = await import("@/components/project/AppointmentManager");

  c.head("1 · the parser");
  const b = parseAppointmentBrief(FLATLEY)!;
  c.ok("customer: name, email, phone; Aryeo's n/a note dropped",
    b.customer.name === "Mike Flatley" && b.customer.email === "mike@garymercerteam.com" && b.customer.phone === "(484) 744-9700" && b.customer.notes === null, JSON.stringify(b.customer));
  c.ok("this visit's services, one per line", b.services.join(" | ") === "Social Influencer (0-1,999 Sq. Ft.) | Zillow Showcase 3D Tour Add-on (0 - 1,999 Sq. Ft.)", b.services.join(" | "));
  c.ok("who will be there, flexibility, square footage; blank answers and a 'No' waitlist dropped",
    b.presence === "Agent" && b.flexible === "Not Flexible - keep appointment for the scheduled time" && b.squareFeet === "1,300 sq ft" && b.waitlist === null && b.lockbox === null && b.access === null && b.special === null && b.orderNotes === null && b.other.length === 0,
    JSON.stringify({ p: b.presence, f: b.flexible, s: b.squareFeet, w: b.waitlist, o: b.other }));
  c.ok("the order and Zillow links become buttons", b.links.map((l) => l.label).join(" | ") === "Open the order in Aryeo | Capture the Zillow 3D tour" && b.links[1].href.endsWith("PA%2019468"), JSON.stringify(b.links.map((l) => l.label)));

  const filled = parseAppointmentBrief(FLATLEY
    .replace("Lock Box / Door Code:", "Lock Box / Door Code: 1923")
    .replace("(for this property only):", "(for this property only): Shoot the pool first,\nthen the yard")
    .replace("Order Notes:\nn/a", "Order Notes:\nhub-session:abc:1 · booked by the hub\nSeller has a dog"))!;
  c.ok("filled answers land in their fields; a wrapped answer is folded in; the hub's booking line is not an order note",
    filled.lockbox === "1923" && filled.special === "Shoot the pool first, then the yard" && filled.orderNotes === "Seller has a dog", JSON.stringify({ l: filled.lockbox, s: filled.special, n: filled.orderNotes }));
  c.ok("an unknown header keeps its text under its own label", parseAppointmentBrief(`${FLATLEY}\n\nParking:\nUse the side street`)!.other.some((o) => o.label === "Parking" && o.value === "Use the side street"));
  c.ok("free text with no Aryeo headers does not parse (the card shows it as written)", parseAppointmentBrief("Content session, bring the gimbal") === null && parseAppointmentBrief(null) === null);
  c.ok("HTML descriptions parse too", parseAppointmentBrief(FLATLEY.replace(/\n/g, "<br>"))?.customer.name === "Mike Flatley");

  c.head("2 · the view");
  const el = ShootBriefView({ description: FLATLEY });
  const html = renderToStaticMarkup(el);
  c.ok("open by default: the fields are on the card, not inside a closed fold", html.includes('data-brief="fields"') && html.indexOf("Mike Flatley") < html.indexOf("<details"));
  c.ok("grouped: This visit, Customer, Getting in", ["This visit", "Customer", "Getting in", "1,300 sq ft", "Who will be there"].every((t) => html.includes(t)));
  c.ok("phone and email are tap-to-call and mailto", html.includes('href="tel:4847449700"') && html.includes('href="mailto:mike@garymercerteam.com"'));
  c.ok("the long Zillow URL is a button, not text", html.includes("Capture the Zillow 3D tour") && !/>https:\/\/www\.zillow/.test(html.split("<details")[0]));
  c.ok("the original text is one tap away", html.includes("Original text from Aryeo"));
  const raw = renderToStaticMarkup(ShootBriefView({ description: "Content session, bring the gimbal" }));
  c.ok("an unparsed description is shown as written, still open", raw.includes("Content session, bring the gimbal") && !raw.includes("<details"));
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
