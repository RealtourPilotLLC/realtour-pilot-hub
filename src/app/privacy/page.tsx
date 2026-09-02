import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata = {
  title: "Privacy Policy — RealTour Pilot Operations Hub",
  description: "How the RealTour Pilot Operations Hub handles data, including data accessed from connected services.",
};

// Public page. Required by Intuit (and Google/Adobe/Dropbox) to issue production
// OAuth credentials, and genuinely useful: it states plainly what the Hub reads,
// why, and what it never does.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="July 21, 2026">
      <LegalSection title="Who we are">
        <p>
          The RealTour Pilot Operations Hub (&ldquo;the Hub&rdquo;) is a private, internal business
          application operated by <strong>RealTour Pilot LLC</strong>, a real estate media agency. It is
          used solely by RealTour Pilot staff to run the company&rsquo;s own operations. It is not a
          consumer product, it is not sold or licensed to third parties, and it is not available for
          public sign-up.
        </p>
        <p>
          Questions about this policy: <a href="mailto:info@realtourpilot.com">info@realtourpilot.com</a>
        </p>
      </LegalSection>

      <LegalSection title="What the Hub accesses">
        <p>The Hub connects to services that RealTour Pilot already uses, using each provider&rsquo;s official API and only with an authorized account owner&rsquo;s consent:</p>
        <ul>
          <li><strong>QuickBooks Online (Intuit).</strong> Read-only access to accounting data for the company&rsquo;s own books: invoices, payments, purchases, the chart of accounts, and profit-and-loss reporting. Used for internal financial reporting, bookkeeping categorization, and reconciliation against other systems.</li>
          <li><strong>Aryeo.</strong> Orders, listings, appointments, and media for jobs the company delivers.</li>
          <li><strong>Stripe.</strong> Read-only payment and fee data for revenue reporting.</li>
          <li><strong>Google / Gmail.</strong> Company mailboxes, to turn client email into internal tasks.</li>
          <li><strong>Dropbox, OpenPhone, Slack.</strong> Files, calls and messages tied to jobs.</li>
        </ul>
        <p>
          The Hub also stores business records created inside it: projects, schedules, tasks, internal notes,
          team pay records, and client contact details needed to deliver work.
        </p>
      </LegalSection>

      <LegalSection title="How the data is used">
        <p>
          Data is used only to operate RealTour Pilot: scheduling shoots, tracking delivery, quality review,
          invoicing and collections, financial reporting, and paying the team. It is used for no other purpose.
        </p>
        <p><strong>We do not sell, rent, or share data with third parties for advertising or marketing.</strong> We do not use accounting data for any purpose beyond RealTour Pilot&rsquo;s own reporting and bookkeeping.</p>
      </LegalSection>

      <LegalSection title="Accounting data specifically">
        <p>
          QuickBooks access is <strong>read-only</strong>. The Hub does not create, modify, or delete
          transactions, journal entries, invoices, or any other record in QuickBooks. Accounting data is
          pulled into the Hub so the owner can see an accurate picture of revenue, costs, and profit
          alongside operational data.
        </p>
        <p>
          Financial figures are restricted inside the Hub to the owner and authorized administrators.
          Photographers, editors, and other staff never see company financials, client pricing, or other
          people&rsquo;s pay.
        </p>
      </LegalSection>

      <LegalSection title="How it is stored and protected">
        <ul>
          <li>Data is held in a private, access-controlled database hosted in the United States.</li>
          <li>Access tokens and API keys are <strong>encrypted at rest</strong> (AES-256-GCM) and are never exposed to the browser.</li>
          <li>The application requires authenticated sign-in; access is limited to an explicit allowlist of RealTour Pilot personnel, with role-based permissions.</li>
          <li>All traffic is encrypted in transit over HTTPS.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Retention and deletion">
        <p>
          Business records are retained while they are needed to operate the company and to meet tax and
          accounting obligations. A connected service can be disconnected at any time from the Hub&rsquo;s
          Connections page, which immediately revokes and deletes the stored credentials for that service.
        </p>
        <p>
          To request deletion of data associated with a connected account, email{" "}
          <a href="mailto:info@realtourpilot.com">info@realtourpilot.com</a>.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          If this policy changes materially, the updated date above will change. Continued use of the Hub
          after an update constitutes acceptance of the revised policy.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
