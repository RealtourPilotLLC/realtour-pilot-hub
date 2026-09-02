import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata = {
  title: "Terms of Service — RealTour Pilot Operations Hub",
  description: "End-user license agreement and terms of service for the RealTour Pilot Operations Hub.",
};

// Public page. Serves as the end-user license agreement (EULA) that Intuit and
// other OAuth providers require before issuing production credentials.
export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service &amp; End-User License Agreement" updated="July 21, 2026">
      <LegalSection title="1. Agreement">
        <p>
          These terms govern use of the RealTour Pilot Operations Hub (&ldquo;the Hub&rdquo;), software
          operated by <strong>RealTour Pilot LLC</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By accessing
          the Hub you agree to these terms. If you do not agree, do not use it.
        </p>
      </LegalSection>

      <LegalSection title="2. Who may use it">
        <p>
          The Hub is <strong>private, internal business software</strong>. Access is limited to RealTour
          Pilot LLC personnel and contractors who have been explicitly authorized by the company owner. It
          is not offered to the public, not sold or sublicensed, and there is no public sign-up. Accounts
          are granted, and may be revoked, at the company&rsquo;s discretion.
        </p>
      </LegalSection>

      <LegalSection title="3. License">
        <p>
          Authorized users receive a limited, non-exclusive, non-transferable, revocable license to use the
          Hub solely to perform work for RealTour Pilot LLC. You may not copy, redistribute, reverse
          engineer, or use the Hub or its data for any purpose outside that work.
        </p>
      </LegalSection>

      <LegalSection title="4. Connected services">
        <p>
          The Hub connects to third-party services, including QuickBooks Online, Aryeo, Stripe, Google,
          Dropbox, OpenPhone, and Slack, using each provider&rsquo;s official API and only after an
          authorized account owner grants consent.
        </p>
        <ul>
          <li>Only an authorized account owner may connect or disconnect a service.</li>
          <li>Accounting data access is <strong>read-only</strong>; the Hub does not write to QuickBooks.</li>
          <li>Connections may be revoked at any time from the Hub&rsquo;s Connections page or from the provider&rsquo;s own settings.</li>
          <li>Your use of each connected service remains governed by that provider&rsquo;s own terms.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Acceptable use">
        <p>You agree not to use the Hub to:</p>
        <ul>
          <li>Access data you are not authorized to see, including company financials, client pricing, or other people&rsquo;s pay.</li>
          <li>Export, share, or disclose client information, business records, or financial data outside the company.</li>
          <li>Interfere with, disrupt, or attempt to gain unauthorized access to the Hub or connected services.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Confidentiality">
        <p>
          The Hub contains confidential business information: client records, pricing, financial data, and
          personnel compensation. Authorized users must keep it confidential and use it only to do their job.
          This obligation continues after access ends.
        </p>
      </LegalSection>

      <LegalSection title="7. Data and privacy">
        <p>
          Our handling of data is described in the{" "}
          <a href="/privacy">Privacy Policy</a>, which forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection title="8. No warranty">
        <p>
          The Hub is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranties of any
          kind, express or implied, including merchantability, fitness for a particular purpose, and
          non-infringement. Figures shown in the Hub are operational estimates drawn from connected systems
          and are <strong>not a substitute for professional accounting, tax, or legal advice</strong>.
        </p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, RealTour Pilot LLC is not liable for any indirect,
          incidental, special, consequential, or punitive damages, or for lost profits, revenue, or data,
          arising from use of the Hub.
        </p>
      </LegalSection>

      <LegalSection title="10. Termination">
        <p>
          We may suspend or terminate access at any time, with or without notice. On termination your license
          ends immediately and you must stop using the Hub.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes">
        <p>
          We may update these terms. The updated date above will change, and continued use after an update
          constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact">
        <p>
          RealTour Pilot LLC ·{" "}
          <a href="mailto:info@realtourpilot.com">info@realtourpilot.com</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
