import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { MessageCircle, Phone, User, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { OpenPhone, phoneKey, recentOpenPhoneConversations, type OpConversation } from "@/lib/integrations/openphone";
import { loadPhoneDirectory } from "@/lib/queries";
import { ClientTextsPanel } from "@/components/texts/ClientTextsPanel";
import { SendAllTexts } from "@/components/tasks/SendAllTexts";
import { getEmailThreads } from "@/components/comms/emailThreads";
import { EmailThreadList, HiddenEmailFold } from "@/components/comms/EmailThreadList";
import { TeamMessagesPanel, loadTeamChat } from "@/components/comms/TeamMessagesPanel";
import { getCurrentUser } from "@/lib/auth/user";
import { ReplyQueue } from "@/components/comms/ReplyQueue";
import { MessagesTabs, type TabCount } from "@/components/comms/MessagesTabs";
import { textUnreadKey, WaitingOnUs, waitingUnreadKey } from "@/components/comms/WaitingOnUs";
import { emailReadKey, isUnread, markRead, readMarks, textReadKey, unreadRows, waitingReadKeys } from "@/lib/messageReads";
import { messagesHref, resolveMessagesTab, TEST_SCOPED_TABS, type MessagesTab } from "@/components/comms/messagesNav";
import { replyQueue } from "@/lib/replyQueue";
import { messagesBoard, MESSAGE_BEHIND_HOURS } from "@/lib/opsHome";
import { listAssignees, viewerAssigneeKey } from "@/lib/assignees";
import { scrubMoney } from "@/lib/text";
import { formatDistanceToNow } from "date-fns";
import { deliveryNoticeFocus } from "@/lib/deliveryNoticeIncidents";
import { syntheticClientIds } from "@/lib/syntheticClients";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Messages" };

function fmtPhone(p: string) {
  const d = phoneKey(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

// ---------------------------------------------------------------------------
// MESSAGES: ONE INBOX (Oct 19 2026). Jordan approved the menu as Dashboard,
// Shoots, Photos, Videos, Messages, Schedule, and "Messages merges
// Communications and Client messages into one inbox"; the priority is
// "responding to clients quickly". Before this there were three doors to the
// same people: this page, /ops/messages (clients waiting + new leads) and the
// Tasks page's Replies tab (/tasks?tab=comms). The last two now open here.
//
// The views, in order (components/comms/messagesNav.ts):
//   Waiting on us  THE ONE QUEUE (Jordan, Oct 27 2026: "One queue"): every
//                  client waiting on a reply, texts and email together,
//                  oldest first, with Reply and Dismiss (Oct 21 2026: the
//                  one place a waiting client is cleared); texts from
//                  numbers we have not saved (Not a client, Spam); new
//                  leads; late promises; folded, the thank-yous. Its clients
//                  and leads are the same read as the Home summary box.
//   Email          client email threads from Gmail, newest first, each with
//                  a reply box that sends into the same Gmail thread (Oct 27
//                  2026: "I want to be able to respond to emails in the hub").
//                  Client communication only (Oct 27 2026 Loom, 38:23):
//                  invites, confirmations, shipping, pitches and unsaved
//                  senders fold under the list.
//   Outbox         today's drafted confirmation and delivery texts
//   All            every OpenPhone conversation (was the page's "Inbox")
// Team (internal messages by property) is off the bar since the Oct 27 Loom:
// the messages icon beside the bell opens it (?tab=team).
// UNREAD (Oct 27 2026 Loom, 37:49): every client conversation carries an
// Unread mark until this person opens it (lib/messageReads); opening a text's
// reply screen or an email thread moves their mark. "View as" never does.
// The Texts tab (every unanswered text, a second list of the same waiting
// clients) is gone from the bar. ?tab=texts&focus=<key> is now the screen a
// text's Reply opens: that one conversation with a reply ready to write.
// ?tab=texts or ?tab=replies with no focus opens Waiting on us.
// Each view's number is on its tab and nowhere else on the page. Every view
// is shareable by ?tab= and loads only its own list; the counts on the tabs
// come from the two reads below, which every view shares.
// ---------------------------------------------------------------------------

type SP = { tab?: string; t?: string; q?: string; view?: string; incident?: string; test?: string; focus?: string };

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("communications");
  const sp = await searchParams;
  const tab = resolveMessagesTab(sp);
  // Only a scalar "1" turns the test view on, and only where a view reads it.
  const includeTest = TEST_SCOPED_TABS.has(tab) && sp.test === "1";
  const me = await getCurrentUser().catch(() => null);
  const isOwner = !me || me.role === "OWNER";
  const excludeClientIds = includeTest ? [] : await syntheticClientIds();
  const roster = me ? await listAssignees().catch(() => []) : [];
  const viewer = me ? { key: viewerAssigneeKey(me, roster), role: me.role, teamMemberId: me.teamMemberId } : null;
  const now = new Date();

  // The two reads every view shares, for the tab numbers: who is waiting on
  // us (lib/opsHome.messagesBoard: waiting clients, new leads, the Outbox
  // count) and the text reply queue (the Texts list itself). Both slice ONE
  // read of the comms log, made once for this request (Oct 21 2026, audit F4:
  // it was three, phone twice): the same clock, the same client scope.
  const [board, allTexts] = await Promise.all([
    messagesBoard({ now, excludeClientIds, viewer }),
    replyQueue({ now, excludeClientIds, shared: true }),
  ]);
  // TEST RECORDS OFF THE TEXTS LIST TOO (audit F24, Oct 20 2026). Waiting,
  // Email and the Outbox hid test clients behind "Show test records"; Texts
  // listed and counted them. Same rule, applied here: a card on a test
  // client stays off the list and off the tab's number unless ?test=1.
  const hidden = new Set(excludeClientIds);
  const realOnly = (c: { clientId: string | null }) => !c.clientId || !hidden.has(c.clientId);
  const texts = hidden.size
    ? { ...allTexts, cards: allTexts.cards.filter(realOnly), handled: allTexts.handled.filter(realOnly) }
    : allTexts;
  // THE MONEY RULE ON CLIENT WORDS (audit F7): owner only, on every view,
  // the same scrub Waiting on us already ran.
  const clean = isOwner ? (t: string) => t : scrubMoney;
  // Display copies only: the send and draft actions re-read each card on the
  // server by its key, so scrubbing what the browser shows changes nothing
  // that is sent or drafted.
  const shown = (c: (typeof texts.cards)[number]) =>
    isOwner ? c : { ...c, lastInbound: clean(c.lastInbound), turns: c.turns.map((t) => ({ ...t, text: clean(t.text) })) };
  // ONE QUEUE (Jordan, Oct 21 2026, audit F5; Oct 27 2026: "One queue").
  // Waiting on us counts and clears every waiting client, text and email. The
  // texts it did not list, from numbers we have not saved, were only on the
  // Texts tab; they are on Waiting on us now, in its number, so one tab counts
  // everything waiting on us and nothing twice.
  const unsavedTexts = texts.cards.filter((c) => !c.clientId).map(shown);
  const counts: Partial<Record<MessagesTab, TabCount>> = {
    waiting: { n: board.waiting.length + board.leads.length + unsavedTexts.length, tone: board.counts.behind > 0 || unsavedTexts.some((c) => c.hoursWaiting >= MESSAGE_BEHIND_HOURS) ? "danger" : "brand" },
    outbox: { n: board.outbox },
  };
  const tabBar = (extra: Partial<Record<MessagesTab, TabCount>> = {}) => <MessagesTabs tab={tab} counts={{ ...counts, ...extra }} test={includeTest} />;
  // A repeated ?focus= arrives as an array; only a single value is a focus.
  const focus = (typeof sp.focus === "string" ? sp.focus : "").trim();

  // WAITING ON US: the first view. What /ops/messages showed, from the same
  // read, plus the promises at risk that lived on the Tasks page's Replies tab.
  if (tab === "waiting") {
    const behind = board.waiting.filter((w) => w.behind).length;
    // Our own team's texts are not client communication (Oct 27 2026 Loom,
    // 38:54): they are Team messages, on the messages icon.
    const aside = texts.handled.filter((c) => !c.isTeam).map(shown);
    const lastFromThem = (c: (typeof texts.cards)[number]) => [...c.turns].reverse().find((t) => t.role === "client")?.at ?? c.waitingSince;
    const [unreadWaiting, unreadTexts] = await Promise.all([
      unreadRows(me?.id, board.waiting, (w) => waitingReadKeys(w.family, w.group)),
      unreadRows(me?.id, [...unsavedTexts, ...aside], (c) => [{ key: textReadKey(c.key), at: lastFromThem(c) }]),
    ]);
    const unread = new Set<string>([...[...unreadWaiting].map(waitingUnreadKey), ...[...unreadTexts].map(textUnreadKey)]);
    return (
      <div>
        <PageHeader
          title="Messages"
          subtitle={`Everyone waiting on a reply: clients (texts and email, oldest first), numbers we have not saved, and new leads.${behind ? ` ${behind} ${behind === 1 ? "client has" : "clients have"} waited over ${MESSAGE_BEHIND_HOURS} hours.` : ""}`}
        />
        <div className="mx-auto max-w-3xl p-4 pb-16 sm:p-6">
          {tabBar()}
          <WaitingOnUs
            board={board}
            now={now}
            clean={clean}
            includeTest={includeTest}
            excludeClientIds={excludeClientIds}
            showFollowupsLink={!isOwner}
            texts={{ unsaved: unsavedTexts, aside }}
            unread={unread}
          />
        </div>
      </div>
    );
  }

  // A TEXT'S REPLY SCREEN (?tab=texts&focus=<key>): the Reply on a Waiting on
  // us row. That one conversation, its messages open, a draft ready to read.
  // Jordan: "a generate response engine for Kyle so he can have responses
  // generated to all inbound text messages, and then give him the ability to
  // explain what he wants to say to be able to tailor the message."
  //
  // The 30-day comms review found the two habits that cost us: messages that go
  // unanswered, and answers with no real time in them ("should be" was the most
  // used phrase). Every draft here is written under a rule that bans vague
  // timing; the queue that can't hide a message is Waiting on us (Oct 27 2026,
  // one queue: this was a second list of the same texts).
  if (tab === "texts") {
    const all = [...texts.cards, ...texts.handled];
    const match = focus ? all.find((c) => c.key === focus || c.key.slice(2) === focus) ?? null : null;
    // Opening the conversation reads it (Oct 27 2026); a "view as" preview never moves a mark.
    if (match && me && !me.impersonating) await markRead(me.id, textReadKey(match.key), now);
    return (
      <div>
        <PageHeader
          title="Messages"
          subtitle={match ? `Reply to ${match.displayName}. A draft is one press away; nothing sends until you press Send.` : "Waiting on us has everything still waiting on a reply."}
        />
        <div className="mx-auto max-w-3xl p-4 pb-16 sm:p-6">
          {tabBar()}
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{match ? `Answering ${match.displayName}.` : "That conversation is not waiting on a text reply any more."}</span>
            <Link href={messagesHref("waiting", { test: includeTest })} className="inline-flex min-h-11 items-center font-medium text-brand underline">Back to Waiting on us</Link>
          </p>
          {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
          {includeTest && <p className="mb-3 text-xs text-muted">Showing real and test records</p>}
          {match && <ReplyQueue key={`${match.key}:${includeTest ? "test" : "real"}`} cards={[shown(match)]} focusKey={match.key} />}
        </div>
      </div>
    );
  }

  // The Outbox renders without the (slow) OpenPhone conversation pull: drafts
  // come from SmartTasks; OpenPhone is only involved when a human hits Send.
  if (tab === "outbox") {
    return (
      <div>
        <PageHeader
          title="Messages"
          subtitle="Today's confirmation and delivery texts. Check each draft, then send."
        />
        <div className="p-4 sm:p-6">
          {tabBar()}
          {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients' drafts stay hidden. */}
          {includeTest && <p className="mb-3 text-xs text-muted">Showing real and test records</p>}
          {/* The batch send-all lives HERE: the Outbox is the one home for
              drafted texts (it was also a panel on /tasks + a rollup card, three
              surfaces for the same rows, audit). */}
          <div className="mb-3"><SendAllTexts key={includeTest ? "test" : "real"} count={board.outbox} includeTest={includeTest} /></div>
          <ClientTextsPanel excludeClientIds={excludeClientIds} />
        </div>
      </div>
    );
  }

  // Email: client/lead threads from the Gmail sync (CommLog rows), no
  // OpenPhone involved. Each thread's messages are newest first, a week open
  // and the rest folded, with a reply box that sends into the same Gmail
  // thread (Jordan, Oct 27 2026). ?focus= is a Reply pressed on Waiting on us:
  // that thread goes first, open, its reply box ready.
  // No number on this tab (Oct 27 2026, one queue): an email waiting on us is
  // counted once, on Waiting on us.
  if (tab === "email") {
    const read = await getEmailThreads({ excludeClientIds });
    const marks = await readMarks(me?.id, read.threads.map((t) => emailReadKey(t.key)));
    const marked = read.threads.map((t) => ({ ...t, unread: isUnread(t.lastInboundISO, marks.get(emailReadKey(t.key))) }));
    // The money rule on client email (audit F7): owner only.
    const threads = isOwner
      ? marked
      : marked.map((t) => ({
          ...t,
          subject: clean(t.subject),
          snippet: clean(t.snippet),
          messages: t.messages.map((m) => ({ ...m, body: clean(m.body) })),
        }));
    // The thread key is "<subject>::<client>". Exact first, then the same
    // subject where the client wrote last, then (a request the hub wrote down
    // with no subject on it) that client's newest thread.
    const cut = focus.lastIndexOf("::");
    const focusSubject = cut > 0 ? focus.slice(0, cut) : focus;
    const focusClient = cut > 0 ? focus.slice(cut + 2) : "";
    const exact = focus ? threads.find((t) => t.key === focus) ?? threads.find((t) => t.lastDirection === "in" && t.key.startsWith(`${focusSubject}::`)) ?? null : null;
    const ofClient = !exact && focusClient ? threads.find((t) => t.lastDirection === "in" && t.key.endsWith(`::${focusClient}`)) ?? threads.find((t) => t.key.endsWith(`::${focusClient}`)) ?? null : null;
    const found = exact ?? ofClient;
    // A Reply from Waiting on us opens the thread: that reads it (Oct 27 2026).
    if (found?.unread && me && !me.impersonating) await markRead(me.id, emailReadKey(found.key), found.lastInboundISO ? new Date(found.lastInboundISO) : now);
    const match = found ? { ...found, unread: false } : null;
    const ordered = match ? [match, ...threads.filter((t) => t.key !== match.key)] : threads;
    return (
      <div>
        <PageHeader
          title="Messages"
          subtitle="Client email from the last 60 days, grouped into threads, newest first. Open a thread to reply. Invites, confirmations, shipping notices and pitches are folded at the bottom."
          actions={<Badge soft="var(--surface-2)">Synced from Gmail</Badge>}
        />
        <div className="p-4 sm:p-6">
          {tabBar()}
          {focus && (
            <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {match ? (
                <span>{exact ? "Their thread is first and open." : "Their latest thread is first and open."} Write your reply in it, or use Open in Gmail.</span>
              ) : (
                <span>
                  That email is not in the last 60 days shown here.{" "}
                  {focusSubject && focusSubject !== "(no subject)" && (
                    <a href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(focusSubject)}`} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline">Search Gmail for it</a>
                  )}
                </span>
              )}
              <Link href={messagesHref("waiting", { test: includeTest })} className="inline-flex min-h-11 items-center font-medium text-brand underline">Back to Waiting on us</Link>
            </p>
          )}
          {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
          {includeTest && <p className="mb-3 text-xs text-muted">Showing real and test records</p>}
          <EmailThreadList key={match?.key ?? "all"} threads={ordered} focusKey={match?.key ?? null} nowMs={now.getTime()} />
          <HiddenEmailFold hidden={isOwner ? read.hidden : read.hidden.map((h) => ({ ...h, subject: clean(h.subject) }))} total={read.hiddenTotal} canUndo={!me?.impersonating} />
        </div>
      </div>
    );
  }

  // Team: internal project-message threads across every job, one stream, no
  // external providers touched. Rows deep-link to the project's composer.
  if (tab === "team") {
    // The two-pane chat by property (Kyle call, Sep 16): the office sees every
    // job that has a thread plus the active ones, the same center the Editing
    // Room opens, scoped differently. Selecting a thread stamps the read
    // watermark inside loadTeamChat; a "view as" preview reads only.
    const chat = await loadTeamChat({
      scope: { kind: "office" },
      viewer: me ? { id: me.id, teamMemberId: me.teamMemberId, impersonating: !!me.impersonating } : null,
      selectedId: sp.t,
      q: sp.q,
      view: sp.view,
    });
    return (
      <div>
        <PageHeader
          title="Messages"
          subtitle={
            chat.unreadTotal > 0
              ? `Team messages: the team channel and each job's thread. ${chat.unreadTotal} conversation${chat.unreadTotal === 1 ? " has" : "s have"} something new. This opens from the messages icon beside the bell.`
              : "Team messages: the team channel and each job's thread. Pick one to read and reply. This opens from the messages icon beside the bell."
          }
        />
        <div className="p-4 sm:p-6">
          {tabBar()}
          <TeamMessagesPanel
            data={chat}
            base={{ pathname: "/communications", params: { tab: "team" } }}
            open={{ pathname: "/projects", label: "Open the job file" }}
            readOnly={!!me?.impersonating}
          />
        </div>
      </div>
    );
  }

  // ALL: every OpenPhone conversation, newest first (was the page's "Inbox").
  // A delivery exception links here by opaque outbox id. Resolve its phone
  // server-side, never in the URL, and refuse unrelated outbox identities.
  const incident = await deliveryNoticeFocus(sp.incident);
  const incidentProject = incident?.projectId
    ? await prisma.project.findUnique({ where: { id: incident.projectId }, select: { title: true } }).catch(() => null)
    : null;
  const incidentPhone = incident ? phoneKey(incident.toRef) : null;
  const incidentCard = incident ? (
    <section className="mb-4 rounded-2xl border border-warning/40 bg-warning/5 p-4" aria-label="Delivery text check">
      <p className="text-sm font-semibold">Delivery text check · {incidentProject?.title ?? "Job"}</p>
      <p className="mt-1 text-sm text-muted">
        {incident.state === "accepted" ? "The provider later accepted this text." : incident.state === "unknown" ? "The provider outcome is unconfirmed. It may already have sent." : incident.state === "failed" ? "The send failed before provider acceptance." : "The send is still pending or in progress."}
        {" "}{incident.state === "accepted" ? "The provider accepted it; no retry is needed." : "Compare the exact text and time with the conversation below before any retry."}
      </p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Recipient</dt>
          <dd className="min-w-0 break-words font-medium">{fmtPhone(incident.toRef)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Queued</dt>
          <dd className="min-w-0 break-words">
            <time dateTime={incident.createdAt.toISOString()}>
              {incident.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })} ET
            </time>
            <span className="mt-0.5 block text-xs text-muted">{formatDistanceToNow(incident.createdAt, { addSuffix: true })}</span>
          </dd>
        </div>
      </dl>
      <blockquote className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-sm">{incident.body}</blockquote>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        <Link href={`/projects/${incident.projectId}`} className="inline-flex min-h-9 items-center font-medium text-brand underline">Open job</Link>
        <Link href={messagesHref("all")} className="inline-flex min-h-9 items-center font-medium text-muted underline">All conversations</Link>
      </div>
    </section>
  ) : sp.incident ? (
    <p role="alert" className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">That delivery text could not be identified. Open the job from Home and check its latest delivery state.</p>
  ) : null;

  const connected = await getSecret("openphone");
  if (!connected) {
    return (
      <div>
        <PageHeader title="Messages" subtitle="Calls and texts from OpenPhone" />
        <div className="p-4 sm:p-6">
          {tabBar()}
          {incidentCard}
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <Phone className="mx-auto mb-2 size-6 text-muted-2" />
            <p className="text-sm text-muted">
              Connect OpenPhone in <strong>Connections</strong> to see your calls &amp; texts here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  let conversations: OpConversation[] = [];
  let error: string | null = null;
  let ourNumbers = new Set<string>();
  // Oct 20 2026 (audits H10, F20): who is on each number is read ONCE, in
  // parallel with the OpenPhone pull rather than three table reads after it,
  // from the same directory a conversation and a client's group threads use
  // (lib/queries.loadPhoneDirectory). A number two real clients share is now
  // named by the same ranking the conversation page uses, so the list and
  // the thread it opens can't name different people.
  const [pulled, dir] = await Promise.all([
    // Page through ALL conversations and sort newest-first — OpenPhone's native
    // order is arbitrary, so fetching a single page drops active threads (incl.
    // group texts) from the inbox.
    Promise.all([recentOpenPhoneConversations(), OpenPhone.phoneNumbers()]).then(
      ([convs, phones]) => ({ convs, phones, error: null as string | null }),
      (e) => ({ convs: [] as OpConversation[], phones: [] as { number: string }[], error: e instanceof Error ? e.message : "Could not load conversations." }),
    ),
    loadPhoneDirectory(),
  ]);
  conversations = pulled.convs;
  ourNumbers = new Set(pulled.phones.map((p) => phoneKey(p.number)).filter(Boolean));
  error = pulled.error;

  // Jordan's TEST client also has Jordan's team number. A participant is the
  // person on that number (team first), not the fixture account that uses it.
  const nameFor = async (ph: string) => {
    const k = phoneKey(ph);
    return dir.teamName(k) || (await dir.client(k))?.name || dir.contact(k)?.name || fmtPhone(ph);
  };

  const DISPLAY_CAP = 150;
  const totalConversations = conversations.length;
  // Shape and cap first; only the rows that will show are named.
  const shaped = conversations
    .map((conv) => {
      const others = (conv.participants ?? []).filter((p) => !ourNumbers.has(phoneKey(p)));
      const isGroup = others.length > 1;
      const phone = others[0] ?? conv.participants?.[0] ?? "";
      return { conv, phone, others, isGroup };
    })
    .filter((r) => !incident || (incidentPhone?.length === 10 && r.others.some((p) => phoneKey(p) === incidentPhone)))
    .sort((a, b) => new Date(b.conv.lastActivityAt ?? 0).getTime() - new Date(a.conv.lastActivityAt ?? 0).getTime())
    .slice(0, DISPLAY_CAP);
  const rows = await Promise.all(
    shaped.map(async (r) => {
      const k = phoneKey(r.phone);
      const teamName = dir.teamName(k);
      const client = teamName ? undefined : await dir.client(k);
      const contact = teamName || client ? undefined : dir.contact(k);
      const groupName = r.isGroup ? (r.conv.name || (await Promise.all(r.others.map(nameFor))).join(", ")) : "";
      return { ...r, groupName, teamName, client, contact };
    }),
  );

  return (
    <div>
      <PageHeader
        title="Messages"
        subtitle={incident ? `${rows.length} matching conversation${rows.length === 1 ? "" : "s"}` : totalConversations > rows.length ? `${rows.length} most recent of ${totalConversations} conversations` : `${rows.length} conversations`}
        actions={<Badge soft="var(--surface-2)">Live from OpenPhone</Badge>}
      />
      <div className="p-4 sm:p-6">
        {tabBar()}
        {incidentCard}
        {error && <div className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        {rows.length === 0 && !error ? (
          <p className="text-sm text-muted">{incident ? "No matching OpenPhone conversation was returned. Check the provider directly before deciding whether this text needs a retry." : "No conversations found."}</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-surface">
            {rows.map(({ conv, phone, others, isGroup, groupName, teamName, client, contact }) => {
              const name = isGroup ? groupName : (teamName || client?.name || contact?.name || conv.name || fmtPhone(phone));
              const pParam = isGroup ? others.join(",") : phone;
              const href = `/communications/thread?pn=${encodeURIComponent(conv.phoneNumberId ?? "")}&p=${encodeURIComponent(pParam)}&name=${encodeURIComponent(name)}`;
              return (
                <Link key={conv.id} href={href} className="flex min-h-11 items-center gap-3 border-b px-4 py-3 last:border-0 hover:bg-surface-2 sm:px-5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    {isGroup ? <Users className="size-4" /> : <MessageCircle className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{name}</span>
                      {isGroup ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-brand-soft px-1.5 text-[10px] font-medium text-brand">
                          <Users className="size-2.5" /> group · {others.length}
                        </span>
                      ) : teamName ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-brand-soft px-1.5 text-[10px] font-medium text-brand">
                          <User className="size-2.5" /> team
                        </span>
                      ) : client ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-success-soft px-1.5 text-[10px] font-medium text-success">
                          <User className="size-2.5" /> client
                        </span>
                      ) : contact ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1.5 text-[10px] font-medium text-muted">
                          <User className="size-2.5" /> contact
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {isGroup ? `${others.length} people` : fmtPhone(phone)}
                      {!isGroup && contact?.company ? ` · ${contact.company}` : ""}
                    </div>
                  </div>
                  {conv.lastActivityAt && (
                    <span className="shrink-0 text-xs text-muted-2">
                      {formatDistanceToNow(new Date(conv.lastActivityAt), { addSuffix: true })}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
