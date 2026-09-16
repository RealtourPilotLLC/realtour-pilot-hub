// The catalogue of every external service the hub connects to. Drives the
// Connections page. `authType` tells the UI how to collect credentials:
//   - "apikey": a single secret the user pastes
//   - "oauth":  a redirect/authorize flow (needs the app deployed at a public URL)

export type AuthType = "apikey" | "oauth";
export type Segment = "Operations" | "Communication" | "Finance" | "Files" | "Marketing";

export type ProviderDef = {
  id: string;
  name: string;
  blurb: string;
  segment: Segment;
  authType: AuthType;
  icon: string; // lucide icon name
  color: string;
  // For apikey providers: label + help for the field the user pastes.
  keyLabel?: string;
  keyHelp?: string;
  docsUrl?: string;
  // What this integration unlocks, shown in the UI.
  capabilities: string[];
  // Whether we've actually built the integration yet (vs. planned).
  ready: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "aryeo",
    name: "Aryeo",
    blurb: "Orders, listings, appointments & media delivery",
    segment: "Operations",
    authType: "apikey",
    icon: "Camera",
    color: "#111827",
    keyLabel: "Aryeo API key",
    keyHelp:
      "In Aryeo: Group Settings → Developers → API Keys → Generate. Paste the key (starts with a long token).",
    docsUrl: "https://docs.aryeo.com/",
    capabilities: [
      "Auto-import orders → pipeline projects & clients",
      "Service catalog from products (price tiers)",
      "Live delivered media galleries on each project",
      "Appointments, tasks, order forms, tags, customers",
      "Real-time webhooks (fulfilled, media delivered, paid)",
    ],
    ready: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    blurb: "Payments, invoices & contractor payouts",
    segment: "Finance",
    authType: "apikey",
    icon: "CreditCard",
    color: "#635bff",
    keyLabel: "Stripe restricted key (read-only)",
    keyHelp: "Stripe → Developers → API keys → Create restricted key. Give it READ on Balance, Balance transactions, Charges & Payment intents. Paste the rk_live_… key — it's stored encrypted. (Test first with an rk_test_… key.)",
    docsUrl: "https://dashboard.stripe.com/apikeys/create",
    capabilities: ["Real collected revenue (net of fees)", "Card fees as an expense line", "Reconcile against Aryeo invoices"],
    ready: true,
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    blurb: "Accounting, invoices & bookkeeping",
    segment: "Finance",
    authType: "oauth",
    icon: "Calculator",
    color: "#2ca01c",
    capabilities: ["Real P&L (incl. non-Stripe revenue)", "Invoices, payments & expenses", "Auto-categorized books with a review queue"],
    ready: true,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    blurb: "Project folders & deliverable files",
    segment: "Files",
    authType: "oauth",
    icon: "Folder",
    color: "#0061ff",
    docsUrl: "https://www.dropbox.com/developers/documentation/http/overview",
    capabilities: ["Auto-create project folders", "Push uploads from the portal", "Link delivered media"],
    ready: true,
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Client & lead email — read into tasks",
    segment: "Communication",
    authType: "oauth",
    icon: "Mail",
    color: "#ea4335",
    docsUrl: "https://developers.google.com/gmail/api",
    capabilities: [
      "Reads hello@ + info@ (connect both mailboxes)",
      "Client & lead emails only — skips marketing, invoices, automated",
      "Matches to projects + feeds the morning brief",
    ],
    ready: true,
  },
  {
    id: "openphone",
    name: "OpenPhone (Quo)",
    blurb: "Calls & texts with clients",
    segment: "Communication",
    authType: "apikey",
    icon: "Phone",
    color: "#6d28d9",
    keyLabel: "OpenPhone API key",
    keyHelp: "OpenPhone → Settings → API → create a key. Paste it here (it's encrypted).",
    docsUrl: "https://www.openphone.com/docs",
    capabilities: ["Unified call & text history", "Match conversations to clients", "Comms timeline per project"],
    ready: true,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Team notifications & alerts",
    segment: "Communication",
    authType: "apikey",
    icon: "MessageSquare",
    color: "#4a154b",
    keyLabel: "Slack bot token (xoxb-…)",
    keyHelp: "Slack app → OAuth & Permissions → Bot Token Scopes: chat:write, users:read, users:read.email → Install (or Reinstall) to Workspace → copy the Bot User OAuth Token (xoxb-…). users:read + users:read.email are what People's “Find on Slack” needs (Sep 15).",
    docsUrl: "https://api.slack.com/web",
    capabilities: ["Notify the right people automatically", "Post pipeline updates", "Flag issues"],
    ready: true,
  },
  {
    id: "slack_user",
    name: "Slack (read history)",
    blurb: "Read team channels + your DMs into the brain",
    segment: "Communication",
    authType: "apikey",
    icon: "MessageSquare",
    color: "#4a154b",
    keyLabel: "Slack User OAuth Token (xoxp-…)",
    keyHelp:
      "Slack app → Install App → Reinstall to Workspace → Allow → copy the User OAuth Token (starts with xoxp-). This reads your channels + DMs so Ask the Hub can recall what was said. It's encrypted; only Jordan can see DM content in the assistant.",
    docsUrl: "https://api.slack.com/apps/A0BBB7RET9U/install-on-team",
    capabilities: [
      "Reads #video-editing + #rp-project-tracker history",
      "Reads your DMs with Kyle, Kim & Remar (owner-only)",
      "Feeds Ask the Hub's comms memory",
    ],
    ready: true,
  },
  {
    // Licensed music for the video editors (Jordan, Sep 15: "add API access to
    // epidemic sound so the editor can browse and download songs … in the
    // editing room"). Partner Content API key, pasted by the owner; the
    // editors search, preview, pick and download from the brief's Music card
    // and never see the key.
    id: "epidemic_sound",
    name: "Epidemic Sound",
    blurb: "Licensed music for the editors, from the brief",
    segment: "Files",
    authType: "apikey",
    icon: "Music",
    color: "#111827",
    keyLabel: "API key (starts with epidemic_live_)",
    keyHelp:
      "Partner Content API key from the Epidemic Sound partner account — pasted here by the owner, stored encrypted; editors never see it. The partner agreement decides the reach (curated collections vs the full catalogue) — Test & connect says which.",
    docsUrl: "https://developers.epidemicsound.com/docs/",
    capabilities: [
      "Editors search, preview and pick a track from the job brief",
      "Download the MP3 straight into the job's Dropbox folder",
      "Every download reported to Epidemic Sound under the agreement",
    ],
    ready: true,
  },
  {
    // The 1080p pass on every approved cut (Jordan, Sep 16: "Once the video cut
    // is approved, it runs through the Topaz Video AI API, applies a preset,
    // and exports it at 1080p to the Dropbox folder"). The key is pasted here
    // by the owner and stored encrypted; nobody else ever sees it, and "Test &
    // connect" only reads the credit balance — it never starts a render.
    id: "topaz",
    name: "Topaz Video AI",
    blurb: "Cleans up every approved cut and exports it at 1080p",
    segment: "Files",
    authType: "apikey",
    icon: "Film",
    color: "#1b1b1f",
    keyLabel: "Topaz API key",
    keyHelp:
      "developer.topazlabs.com → API keys → create a key, and paste it here. It is stored encrypted and is never shown again. Test & connect only reads your credit balance; it does not spend anything.",
    docsUrl: "https://developer.topazlabs.com/",
    capabilities: [
      "Every approved cut runs through your Proteus preset automatically",
      "The 1080p file lands in the job's Final Video folder (the editor's original is kept)",
      "Kyle gets a card with the file, the folder and the Aryeo link",
      "Spend limits per video, per day and per month — you set them",
    ],
    ready: true,
  },
  {
    id: "hubspot",
    name: "HubSpot",
    blurb: "CRM sync (migrate off, or run alongside)",
    segment: "Operations",
    authType: "oauth",
    icon: "Users",
    color: "#ff7a59",
    capabilities: ["Sync contacts & deals", "Import existing CRM data", "Two-way contact sync"],
    ready: false,
  },
  {
    id: "messenger",
    name: "Facebook Messenger",
    blurb: "Client messages from your Page",
    segment: "Communication",
    authType: "oauth",
    icon: "MessageCircle",
    color: "#0084ff",
    capabilities: ["Log Page messages to clients", "Unified inbox", "Feed comms history"],
    ready: false,
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    blurb: "Transactional & marketing email",
    segment: "Marketing",
    authType: "apikey",
    icon: "Send",
    color: "#1a82e2",
    keyLabel: "SendGrid API key",
    keyHelp: "SendGrid → Settings → API Keys → Create API Key (Full Access or Mail Send).",
    docsUrl: "https://docs.sendgrid.com/",
    capabilities: ["Send delivery & feedback emails", "Campaign sends", "Email templates"],
    ready: false,
  },
  {
    id: "ai",
    name: "AI Assistant (Claude)",
    blurb: "Drafts replies in your voice + smart to-dos",
    segment: "Operations",
    authType: "apikey",
    icon: "Sparkles",
    color: "#e96320",
    keyLabel: "Anthropic API key",
    keyHelp: "console.anthropic.com → Settings → API Keys → Create Key. Paste it here (starts with sk-ant-). It's encrypted.",
    docsUrl: "https://console.anthropic.com/settings/keys",
    capabilities: [
      "Draft client replies in Jordan's voice (you send)",
      "Turn texts/emails/Slack into specific to-dos",
      "Summarize call transcripts into action items",
    ],
    ready: true,
  },
  {
    id: "calendly",
    name: "Calendly",
    blurb: "Strategy-call bookings for the Content Program",
    segment: "Operations",
    authType: "apikey",
    icon: "CalendarClock",
    color: "#006bff",
    keyLabel: "Personal access token",
    keyHelp:
      "In Calendly: Integrations \u2192 API & webhooks \u2192 Personal access tokens \u2192 Generate. Paste the token.",
    docsUrl: "https://developer.calendly.com/",
    capabilities: [
      "Reads content-program strategy-call bookings",
      "Stamps each client's month as Scheduled automatically",
      "Matches the booked Meet to its Drive transcript",
    ],
    ready: true,
  },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export const SEGMENTS: Segment[] = ["Operations", "Communication", "Finance", "Files", "Marketing"];

