// Store Jordan's real service agreement as the portal Terms tab content
// (AppSetting "portal-terms" — the page's DEFAULT_TERMS fallback stays for
// safety). Formatting only + the new chargeback section; his language is
// verbatim. Run: npx tsx scripts/set-portal-terms.ts
import { prisma } from "../src/lib/prisma";

const TERMS = `## The short version
- Your package includes up to a set number of edited videos and filming hours each month — schedule your session in the first week of the month, because monthly sessions are use-it-or-lose-it.
- Each video includes two rounds of revisions — ask within 7 days of delivery, right from this portal.
- Once everything's paid, the finished videos are yours to post and run ads with. Raw footage stays with us.
- Billing follows the package you chose at checkout. Payments are non-refundable once a billing cycle starts.
- Questions or disputes? Email info@realtourpilot.com first — we fix things fast.
The full agreement below is what governs.

## 1. Acceptance and Appointment
This General Monthly Video Content Creation Service Agreement ("Agreement") applies to monthly video content creation services provided by Realtour Pilot, LLC ("Realtour Pilot," "Company," "we," "us," or "our") to the client, purchaser, subscriber, business, or authorized representative receiving services ("Client," "you," or "your").

By accepting a quote, selecting a package, submitting payment, signing an order form, booking a content session, or using the services, Client appoints Realtour Pilot to provide monthly video content production services under the package, quote, order form, checkout selection, invoice, subscription record, or project scope accepted by Client.

If there is a conflict between this Agreement and a separately signed written agreement, the separately signed written agreement controls only as to the conflicting term.

## 2. Package Selection, Monthly Video Deliverable Amount, and Shoot Windows
The monthly edited video deliverable amount and monthly shoot window are based on the package selected by Client:

- Video Starter — up to two (2) edited videos per month · up to two (2) hours of filming per month
- Video Accelerator — up to four (4) edited videos per month · up to four (4) hours of filming per month
- Video Pro — up to eight (8) edited videos per month · two (2) sessions of up to four (4) hours each per month

The selected package will be identified in Client's accepted package selection, quote, checkout selection, order form, invoice, subscription record, or written project scope.

For purposes of this Agreement, "Monthly Video Deliverable Amount" means the maximum number of edited videos included in the selected monthly package. "Monthly Shoot Window" means the maximum filming time included in the selected monthly package. For Video Pro, the included monthly shoot window is split into two (2) separate four-hour sessions, unless otherwise agreed in writing.

The selected package is a scope limit, not a guarantee that every monthly session will result in the maximum number of videos.

## 3. Services Provided
Unless otherwise stated in writing, the selected monthly content creation package includes:

- Up to the Monthly Video Deliverable Amount of edited videos per month
- The applicable Monthly Shoot Window or Video Pro sessions listed in the selected package
- Creative direction
- Done-for-you scripting
- Editing and post-production of final video deliverables
- One (1) monthly strategy call per month
- Content strategy creation

Photography, staging, set styling, photo deliverables, paid advertising management, social media posting, or other services not expressly listed are not included unless separately quoted and agreed to in writing. Client-requested work outside the selected package may be quoted and invoiced separately.

## 4. Client Responsibilities
Client agrees to:

- Timely schedule content sessions and strategy calls
- Arrive prepared with required approvals, access, locations, people, products, props, listings, and other materials
- Provide accurate business, brand, licensing, property, media, and usage information
- Secure required permissions, releases, filming approvals, location access, and rights for all Client-provided materials
- Review drafts and provide consolidated revision feedback in a timely manner

Delays, lack of preparedness, missing approvals, unavailable locations, or incomplete information may reduce the amount of content that can be captured or completed during the applicable month.

## 5. Monthly Scheduling Policy
Content sessions are scheduled on a monthly basis. Realtour Pilot may send a scheduling prompt or booking request at or near the beginning of each month.

Client is expected to schedule that month's content session or sessions within the first seven (7) days of the month unless otherwise agreed in writing. For Video Pro, both included monthly sessions must be scheduled and completed within the applicable month unless otherwise agreed in writing.

If Client does not schedule, attend, or complete a monthly content session within the applicable month, that session is forfeited. Monthly content sessions are use it or lose it. For Video Pro, each included monthly session is use it or lose it independently. Unused monthly content sessions do not carry over to future months and are not refundable or creditable unless otherwise agreed in writing.

## 6. Shoot Window and Deliverable Limitations
Each monthly content session includes the shoot window listed in the selected package or otherwise stated in the selected package, quote, order form, checkout selection, subscription terms, or project scope. Video Starter includes up to two (2) hours per month. Video Accelerator includes up to four (4) hours per month. Video Pro includes two (2) separate sessions of up to four (4) hours each per month.

All content must be filmed within the allotted shoot window or session window. Realtour Pilot will make reasonable creative efforts to capture the planned content within that time. However, the selected package includes up to the Monthly Video Deliverable Amount, not a guarantee that the maximum number of videos will be completed in every monthly session.

If fewer than the Monthly Video Deliverable Amount of videos are captured or completed within the allotted shoot window or session window due to time constraints, Client availability, location limitations, delays, lack of preparedness, scripting changes, interruptions, weather, access restrictions, compliance issues, or other production conditions, Realtour Pilot is only responsible for delivering the content reasonably captured and completed within that shoot window or session window.

Additional filming time, combining or splitting shoot windows beyond the selected package, reshoots, make-up sessions, rush services, additional deliverables, or add-on services may be quoted and invoiced separately.

## 7. Payment, Billing, and Refund Terms
The fees, billing frequency, billing start date, subscription length, renewal terms, cancellation deadline, minimum commitment, taxes, and other financial terms are governed by the selected package, quote, order form, checkout selection, invoice, subscription terms, or written project scope accepted by Client.

Client agrees to pay all amounts when due. If recurring billing or auto-pay applies, Client agrees to keep a valid payment method on file and authorizes Realtour Pilot or its payment processor to charge that payment method according to the accepted billing terms.

All payments are non-refundable except as required by law or expressly agreed in writing by Realtour Pilot.

The pay-in-full annual option is non-refundable. If Client selects a pay-in-full annual option, Client will not be entitled to any refund, credit, or prorated refund for unused months, unused sessions, cancellation, nonuse, missed scheduling, or forfeited sessions.

No refunds are issued after a billing cycle has started.

Unused monthly content sessions, missed scheduling windows, late cancellations, or forfeited sessions are not eligible for refunds, credits, make-up sessions, or rollover unless otherwise agreed in writing.

Any additional work outside the selected package, including extra edits, reshoots, additional filming time, weekend sessions, travel, rush work, add-on deliverables, or other expanded services, may be quoted and invoiced separately. Unless a separate invoice states another due date, invoices outside recurring subscription charges are due within seven (7) days.

## 8. Chargebacks and Payment Disputes
By submitting payment, Client acknowledges that the services, deliverables, scheduling policies, and refund terms described in this Agreement were disclosed and accepted before payment.

Before initiating any chargeback, payment dispute, or payment reversal with a bank, card issuer, or payment processor, Client agrees to first contact Realtour Pilot in writing at info@realtourpilot.com and allow ten (10) business days for a good-faith resolution. Most concerns are resolved quickly.

Initiating a chargeback or payment dispute for services that were delivered, made available, scheduled, or forfeited under the terms of this Agreement — including use-it-or-lose-it sessions and non-refundable payments Client agreed to at checkout — is a breach of this Agreement.

Client agrees that Realtour Pilot may present this Agreement, the checkout and package selection records, invoices, subscription records, delivery records, portal access and download logs, communications, and scheduling history as evidence in any chargeback or dispute proceeding.

If a chargeback or payment reversal is resolved in Realtour Pilot's favor, or is initiated on amounts validly owed under this Agreement, Client remains responsible for the disputed amount, and agrees to reimburse Realtour Pilot for associated chargeback fees, processing fees, and reasonable costs of responding to the dispute. Realtour Pilot may suspend services, portal access, and pending deliveries while a payment dispute is open, and may require an alternative payment method before resuming services.

Nothing in this section waives any right Client has under applicable law to dispute genuinely unauthorized charges.

## 9. Term, Renewal, Cancellation, and Termination
The term, renewal period, notice to cancel, and any minimum commitment are governed by the selected package, quote, order form, checkout selection, subscription terms, or written project scope accepted by Client.

Month-to-month services require a minimum three (3) month commitment unless a longer commitment is accepted in writing. Client may not cancel month-to-month services before Client has completed and paid for the first three (3) months.

Yearly commitment services are a twelve (12) month commitment unless otherwise stated in writing. If Client cancels a yearly commitment before the end of the applicable twelve-month term, Client must pay a cancellation fee equal to fifty percent (50%) of the remaining monthly fees for the remaining months within that year. The cancellation fee is due immediately upon cancellation and may be charged to Client's payment method on file unless prohibited by law.

The pay-in-full annual option is paid upfront and non-refundable. Cancellation, nonuse, missed scheduling, or forfeited sessions during the twelve-month term do not entitle Client to any refund, credit, or prorated amount.

After any applicable minimum commitment is satisfied, and unless the selected package, quote, order form, checkout selection, invoice, subscription terms, or written project scope states otherwise, Client may cancel future services with at least fourteen (14) days' written notice before the next billing date.

Cancellations must be sent in writing in accordance with the Notices section of this Agreement.

Cancellation does not relieve Client of amounts already due, amounts incurred before the effective cancellation date, minimum commitment amounts, pay-in-full amounts, or applicable early cancellation fees.

Realtour Pilot may suspend or terminate services if Client fails to pay amounts when due, repeatedly misses scheduling deadlines, fails to provide required access or information, materially breaches this Agreement or any accepted scope, or engages in conduct that makes performance unsafe, impractical, unlawful, or commercially unreasonable.

## 10. Revision Policy
Unless otherwise stated in writing, each edited video includes two (2) rounds of revisions.

Revisions must be requested within the review period stated in the applicable project communication or delivery message. If no review period is stated, revision requests must be submitted within seven (7) days after delivery of the draft.

Revision requests should be consolidated, specific, and consistent with the approved creative direction and scope.

Additional revision rounds, major concept changes, changes to previously approved scripts, reshoots, edits caused by Client-provided errors, or changes requested after approval may be quoted and invoiced separately.

Once music is selected and approved, it cannot be changed unless otherwise agreed in writing. Client may submit music choices ahead of production, subject to availability, licensing, and platform restrictions.

## 11. Rescheduling and Shoot Policy
Client should provide as much notice as possible for rescheduling requests.

Shoots rescheduled with less than twenty-four (24) hours' notice, rescheduled due to location unpreparedness, access issues, missing approvals, or Client-caused delays, may result in a rescheduling fee, logistics fee, forfeiture of the session, or a separately quoted make-up session.

Except where multiple sessions are expressly included in the selected package, shorter shoots that require multiple sessions, split locations, additional setup, or unusual logistics may be subject to additional fees.

Weekend shoots, rush scheduling, travel-heavy shoots, or shoots outside standard availability may be available by request and may require an additional premium or separate quote.

## 12. Travel and Location Requirements
Travel included in the selected package, if any, is governed by the selected package, quote, order form, checkout selection, invoice, subscription terms, or written project scope.

Travel beyond the included service area or outside the Creative Specialist's home base may be billed separately unless otherwise agreed in writing.

Travel time, parking, tolls, permits, location fees, access fees, lodging, and other production-related costs may be billed separately when applicable.

Travel must occur within the allotted shoot window or session window unless otherwise agreed in writing.

## 13. Ownership and Usage
Upon full payment of all amounts due for the applicable deliverables, Client owns the final approved content delivered by Realtour Pilot, subject to any third-party licenses, platform terms, music licensing restrictions, stock asset restrictions, talent releases, location restrictions, or other rights limitations.

Realtour Pilot retains ownership of raw footage, project files, working files, templates, workflows, creative methods, internal documents, unused concepts, and pre-existing materials unless otherwise agreed in writing.

Realtour Pilot retains the right to use final content in portfolios, social media, websites, proposals, case studies, award submissions, and promotional materials unless Client opts out in writing and Realtour Pilot confirms the opt-out in writing.

Client represents that Client has all required rights, permissions, approvals, releases, and licenses for materials, locations, people, trademarks, properties, music selections, branding, claims, and other content provided or requested by Client. Client agrees to indemnify and hold Realtour Pilot harmless from third-party claims arising from Client-provided materials, instructions, approvals, or lack of required permissions.

## 14. Confidentiality
Realtour Pilot will use reasonable care to keep Client's confidential business information secure, including non-public branding documents, project files, private media, and materials not intended for public release.

Client assets will not be sold or reused for other clients.

Confidentiality does not apply to information that is publicly available, independently developed, already known without restriction, lawfully obtained from another source, or required to be disclosed by law, subpoena, court order, platform requirement, or governmental authority.

A mutual non-disclosure agreement may be signed upon request.

## 15. Non-Solicitation
During the term of services and for three (3) years after termination, Client agrees not to directly or indirectly solicit, recruit, hire, contract with, or engage any Realtour Pilot employee, contractor, Creative Specialist, editor, strategist, or staff member introduced to Client through the services, except through Realtour Pilot, without Realtour Pilot's prior written consent.

A violation may cause substantial harm that is difficult to measure. Client agrees that Realtour Pilot may seek injunctive relief and any liquidated damages, fees, or remedies stated in a separately accepted written agreement, quote, order form, or invoice.

## 16. Force Majeure
Neither party is liable for delays or failures caused by events beyond reasonable control, including severe weather, natural disasters, illness, emergencies, acts of war, terrorism, labor disruptions, power or internet failures, equipment failure not caused by negligence, government action, property access restrictions, platform outages, or other uncontrollable events. Realtour Pilot may reschedule affected services as reasonably available.

## 17. Changes to Services or Agreement
Realtour Pilot may update this Agreement, website terms, service procedures, or package details from time to time. For active recurring clients, material changes will be provided by written notice or posted update at least fourteen (14) days before taking effect when commercially reasonable.

Continued use of services after the effective date of an update constitutes acceptance of the updated terms, unless a separately signed written agreement provides otherwise.

## 18. Independent Contractor
Realtour Pilot provides services as an independent contractor. Nothing in this Agreement creates an employment, partnership, joint venture, franchise, agency, or fiduciary relationship between the parties.

## 19. Limitation of Liability
To the fullest extent permitted by law, Realtour Pilot will not be liable for indirect, incidental, consequential, special, exemplary, punitive, lost profit, lost revenue, lost opportunity, platform performance, algorithmic, reputational, or business interruption damages.

To the fullest extent permitted by law, Realtour Pilot's total liability for claims arising out of or relating to a particular month of services will not exceed the amount Client paid to Realtour Pilot for that month of services, unless otherwise required by law.

Realtour Pilot does not guarantee specific business results, social media performance, leads, sales, engagement, platform reach, listing activity, or revenue.

## 20. Governing Law
This Agreement is governed by the laws of the Commonwealth of Pennsylvania without regard to conflict of law rules.

## 21. Arbitration, Class Action Waiver, and Dispute Resolution
Before initiating arbitration, the parties agree to make a good faith effort to resolve disputes directly through written notice.

Any unresolved dispute, claim, or controversy arising out of or relating to this Agreement or the services will be resolved by binding arbitration in Lancaster, Pennsylvania, under Pennsylvania law, unless prohibited by applicable law.

To the fullest extent permitted by law, the parties waive the right to a jury trial and agree that claims will be brought only on an individual basis, not as a class action, collective action, private attorney general action, or other representative proceeding.

The arbitrator may award remedies available under applicable law, but may not consolidate claims or preside over any class or representative proceeding unless both parties agree in writing.

## 22. Waiver and Severability
A failure to enforce any provision does not waive future enforcement. Any waiver must be in writing. If any provision is found unenforceable, the remaining provisions remain in effect and the unenforceable provision will be modified to the minimum extent necessary to make it enforceable.

## 23. Notices
All notices must be sent in writing by email to info@realtourpilot.com or by postal mail to the billing address listed on Client's invoice or account record. This includes cancellations, legal concerns, formal communications, and dispute notices.

Client is responsible for keeping current contact and billing information on file.

## 24. Entire Agreement
This Agreement, together with the selected package, quote, order form, checkout selection, invoice, subscription terms, project scope, and any separately signed written agreement, forms the entire agreement between the parties for the services. It supersedes prior discussions or proposals on the same subject. Any change must be in writing or accepted through an updated package, checkout, quote, order form, or subscription process.

## 25. Acceptance
By selecting a package, accepting a quote, placing an order, submitting payment, signing an order form, booking a session, or using the services, Client acknowledges that Client has read, understood, and agreed to this Agreement.`;

(async () => {
  await prisma.appSetting.upsert({
    where: { key: "portal-terms" },
    update: { value: TERMS },
    create: { key: "portal-terms", value: TERMS },
  });
  console.log("portal-terms set:", TERMS.length, "chars");
})().finally(() => prisma.$disconnect());
