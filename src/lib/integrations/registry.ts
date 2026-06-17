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
    keyLabel: "Stripe secret key",
    keyHelp: "Stripe Dashboard → Developers → API keys → Secret key (use a test key first: sk_test_…).",
    docsUrl: "https://stripe.com/docs/api",
    capabilities: ["Track payments & invoices", "Run contractor payouts", "Reconcile revenue"],
    ready: false,
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    blurb: "Accounting, invoices & bookkeeping",
    segment: "Finance",
    authType: "oauth",
    icon: "Calculator",
    color: "#2ca01c",
    capabilities: ["Sync invoices & payments", "Push revenue to the books", "Expense tracking"],
    ready: false,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    blurb: "Project folders & deliverable files",
    segment: "Files",
    authType: "oauth",
    icon: "Folder",
    color: "#0061ff",
    capabilities: ["Auto-create project folders", "Push uploads from the portal", "Link delivered media"],
    ready: false,
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Client email — read & send from the hub",
    segment: "Communication",
    authType: "oauth",
    icon: "Mail",
    color: "#ea4335",
    capabilities: ["Log client emails to projects", "Send from the hub", "Power smart client notes"],
    ready: false,
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
    keyHelp: "OpenPhone → Settings → API → create a key.",
    docsUrl: "https://www.openphone.com/docs",
    capabilities: ["Log calls & texts to clients", "Trigger reminders", "Feed comms history"],
    ready: false,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Team notifications & alerts",
    segment: "Communication",
    authType: "oauth",
    icon: "MessageSquare",
    color: "#4a154b",
    capabilities: ["Notify the right people automatically", "Post pipeline updates", "Flag issues"],
    ready: false,
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
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export const SEGMENTS: Segment[] = ["Operations", "Communication", "Finance", "Files", "Marketing"];
