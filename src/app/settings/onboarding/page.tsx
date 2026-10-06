import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { requirePageAccess, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { ClientOnboardingPanel } from "@/components/settings/ClientOnboardingPanel";
import type { OnboardingDetail } from "@/lib/clientOnboarding";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SETTINGS → CLIENT ONBOARDING (Oct 5 2026). Jordan: "give me a control panel
// … I'll do each client one by one … a step by step process in a nice settings
// page … and I can customize what gets sent or not sent." And: "Don't even
// send anything. I will send it."
//
// One client at a time: the list on the left (every client with an active or
// paused program, TEST clients last and marked), the seven steps on the right.
// Loading this page writes nothing and sends nothing — the messages are
// composed for reading and editing, and leave only when the owner presses
// Send now. Owner edits and sends; an admin (Kyle) sees it read-only, with
// addresses masked and the client's private portal link hidden; the owner
// previewing as someone else sees what they would see.
// ---------------------------------------------------------------------------

/** What a non-owner sees: no private portal link, addresses masked. */
async function readOnlyView(d: OnboardingDetail): Promise<OnboardingDetail> {
  const { maskToRef } = await import("@/lib/outbox");
  const hideLink = (s: string) => s.replace(/https?:\/\/\S+\/portal\/(?!login\b)[A-Za-z0-9_-]{20,}/g, "[their portal link]");
  // Every address this view could print, masked wherever it appears in a line.
  const known = [...new Set([...d.messages.flatMap((m) => m.recipients.map((r) => `${r.channel}\u0000${r.toRef}`)), ...d.seats.map((x) => `email\u0000${x.email}`)])]
    .map((k) => k.split("\u0000") as [string, string]).filter(([, v]) => !!v);
  const scrub = (line: string) => known.reduce((acc, [ch, v]) => acc.split(v).join(maskToRef(ch, v)), line);
  return {
    ...d,
    steps: d.steps.map((x) => ({ ...x, line: scrub(x.line) })),
    seats: d.seats.map((s) => ({ ...s, email: maskToRef("email", s.email) })),
    heldWelcome: d.heldWelcome ? { ...d.heldWelcome, email: maskToRef("email", d.heldWelcome.email) } : null,
    messages: d.messages.map((m) => ({
      ...m,
      recipients: m.recipients.map((r) => ({ ...r, toRef: maskToRef(r.channel, r.toRef) })),
      body: { email: hideLink(m.body.email), sms: hideLink(m.body.sms) },
      last: m.last ? { ...m.last, to: m.last.to ? maskToRef(m.last.channel ?? "email", m.last.to) : undefined } : null,
    })),
    record: { ...d.record, log: d.record.log.map((e) => ({ ...e, to: e.to ? maskToRef(e.channel ?? (e.to.includes("@") ? "email" : "sms"), e.to) : undefined })) },
  };
}

export default async function ClientOnboardingPage({ searchParams }: { searchParams: Promise<{ client?: string | string[] }> }) {
  await requirePageAccess("settings");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/settings/onboarding");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/");
  // Only the owner, signed in as himself, may change or send (the actions
  // re-check with requireOwner; this only decides what the page offers).
  const canAct = me ? me.role === "OWNER" && me.realRole === "OWNER" && !me.impersonating : !authEnforced();
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  const previewing = !!me?.impersonating;

  const sp = await searchParams;
  const want = typeof sp.client === "string" ? sp.client : null;
  const { listOnboardingClients, loadOnboardingDetail } = await import("@/lib/clientOnboarding");
  let list: Awaited<ReturnType<typeof listOnboardingClients>> = [];
  let readError: string | null = null;
  try {
    list = await listOnboardingClients();
  } catch (e) {
    readError = `The program clients could not be read just now (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). Nothing has changed.`;
  }
  const selectedId = want && list.some((r) => r.clientId === want) ? want : null;
  let detail: OnboardingDetail | null = null;
  if (selectedId) {
    try {
      detail = await loadOnboardingDetail(selectedId);
      if (detail && !ownerEyes) detail = await readOnlyView(detail);
    } catch (e) {
      readError = `This client's onboarding could not be read just now (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). Nothing has changed.`;
    }
  }

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/settings#program" label="Settings" />
      </div>
      <PageHeader
        title="Client onboarding"
        subtitle="One client at a time: what they get, their portal account, and the messages you send them. Nothing is sent unless you press Send now."
        sticky={false}
      />
      <div className="mx-auto min-w-0 max-w-5xl p-4 pb-16 [overflow-wrap:anywhere] sm:p-6">
        {readError && <p role="alert" className="mb-3 rounded-lg border border-warning/50 px-3 py-2 text-sm text-warning">{readError}</p>}
        {!canAct && (
          <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
            {previewing ? "You're previewing as someone else, so this page is read-only. Exit the preview to make changes or send." : "Read-only: only Jordan can change what a client gets or send them anything from here."}
          </p>
        )}
        <ClientOnboardingPanel list={list} detail={detail} selectedId={selectedId} canAct={canAct} />
      </div>
    </div>
  );
}
