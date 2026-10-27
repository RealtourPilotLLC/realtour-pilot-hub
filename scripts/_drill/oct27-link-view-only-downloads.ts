// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the shared link goes view-only, the billing line texts Kyle, and the
// "Downloaded" status (Oct 27 2026).
//
//   DRILL_PORT=5631 node scripts/_drill/run-all.cjs scripts/_drill/oct27-link-view-only-downloads.ts
//
// Jordan, Oct 27 2026:
//   #11 "Off once every client has a sign-in; link-only programs need it until
//       then." Per program: once someone holds a live seat AND email sign-in
//       really works for that client, the shared token link only looks. No
//       comments, change requests or suggestions; it says "Sign in to leave
//       comments or ask for changes." with a sign-in link. A program nobody can
//       sign in to keeps the link exactly as it was.
//   #13 The billing line texts Kyle: his office number, tappable (sms:).
//   #14 "add a status that shows it was downloaded so they know which ones
//       they have downloaded": read from the PortalVisit rows the download
//       door already writes, the client's own rows only.
//
//   1  the world: a real-named client, rollout ALL, a shared link, no seat
//   2  no seat: the link keeps every right it had (comment, change requests,
//      suggestions, messages, booking), no view-only banner
//   3  a seat, but the sign-in email switch off: still full (they could not sign in)
//   4  switch on: view-only. can() refuses, the refusal and the banner say the
//      one line with a sign-in link, a real server action refuses, and the
//      signed-in person and staff keep their rights
//   5  the seat's person disabled, then the seat revoked: the link is full again
//   6  the Terms page: the billing line texts Kyle on a tappable sms: link
//   7  Downloaded: newest client row wins, staff rows never count, the list row
//      and the Library page show it, a video never downloaded shows nothing
//
// ISOLATION: PGlite via the shared harness; nothing outbound.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalViewer } from "@/lib/portal";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6927);
installNextStubs();
const fence = fenceFetch();

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, name: string) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }); return out; };
/* eslint-enable @typescript-eslint/no-explicit-any */
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/<!-- -->/g, "");
const DASHES = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-link-view-only", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const portal = await import("@/lib/portal");
    const pa = await import("@/lib/portalAccess");
    const words = await import("@/lib/portalWords");
    const { PROGRAM_ROLLOUT_SETTING_KEY } = await import("@/lib/programRolloutCore");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const { clientDownloadsFor, portalVideoList } = await import("@/lib/contentVideos");
    const { PortalPage } = await import("@/components/portal/PortalPage");
    const { TermsCard } = await import("@/components/portal/tabs/MoreTab");
    const actions = await import("@/app/portal/actions");
    const now = new Date();
    const monthKey = etMonthKey();
    const setSwitch = (key: string, enabled: boolean) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: enabled ? now : null }, update: { enabled } });

    c.head("1 · The world: a real-named client on rollout ALL, a shared link, nobody seated");
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: JSON.stringify({ mode: "ALL", modeSince: now.toISOString(), pilot: null }) } });
    await setSwitch("portal_sign_in", true);
    await setSwitch("portal_login_email", false);
    const client = await prisma.client.create({ data: { name: "Harper Lane Realty", email: "harper@lane.example", socialClient: true, socialPlan: "Accelerator" }, select: { id: true } });
    const token = "oct27LinkViewOnlyToken_abcdefghijklmnop";
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-08-01T04:00:00Z"), portalToken: token, portalTokenIssuedAt: now }, select: { id: true } });
    const month = await prisma.contentMonth.create({ data: { enrollmentId: e.id, clientId: client.id, monthKey, videosOwed: 4, status: "OPEN" }, select: { id: true } });
    const mkVideo = (title: string) => prisma.contentVideo.create({ data: { enrollmentId: e.id, clientId: client.id, monthId: month.id, monthKey, title, status: "DELIVERED", deliveredAt: now }, select: { id: true } });
    const [vA, vB, vC] = [await mkVideo("Kitchen reveal cut"), await mkVideo("Market update cut"), await mkVideo("Staging on a budget cut")];
    const asLink = async (): Promise<PortalViewer> => {
      const r = await portal.resolvePortalViewer({ token });
      if (!r.ok) throw new Error(`the link did not resolve: ${r.reason}`);
      return r.viewer;
    };
    c.ok("the world is built", !!e.id && !!vA.id);

    const WRITES = ["comment", "requestChanges", "suggest", "message", "requestSession"] as const;
    const page = async (v: PortalViewer, tab: string) => PortalPage({ viewer: v, path: "/portal/[token]", query: { tab } });
    const notices = (tree: unknown) => (isEl(tree) && typeName(tree.type) === "PortalShell" ? (tree.props.notices as Record<string, unknown>) : null);
    const full = async (label: string) => {
      const v = await asLink();
      c.ok(`${label}: the link is not view-only`, v.actor.kind === "TOKEN" && !v.actor.viewOnly && !(await pa.sharedLinkViewOnly(e.id, client.id)));
      c.ok(`${label}: the link may comment, ask for changes, suggest, message and book`, WRITES.every((p) => pa.can(v, p)), WRITES.filter((p) => !pa.can(v, p)).join(","));
      return v;
    };

    c.head("2 · Nobody seated: the shared link keeps every right it had");
    const v0 = await full("no seat");
    const home0 = await page(v0, "home");
    c.ok("no view-only banner on Home", notices(home0)?.linkViewOnly === false && !decode(renderToStaticMarkup(home0 as never)).includes("This shared link is view-only"));
    const passed = await actions.portalAddComment({ token }, "no-such-cut-xyz", null, "Love the opening");
    c.ok("a comment from the link passes the permission gate (fails later, on the unknown cut)", !passed.ok && !/view-only|sign in/i.test(passed.message), passed.message);

    c.head("3 · A seat, but the sign-in email is switched off: still full (they could not sign in)");
    const person = await prisma.clientUser.create({ data: { email: "harper@lane.example", name: "Harper Lane", status: "INVITED" } });
    const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: e.id, clientId: client.id, role: "OWNER" } });
    await full("seat, switch off");

    c.head("4 · Sign-in email on: the shared link goes view-only");
    await setSwitch("portal_login_email", true);
    const v1 = await asLink();
    c.ok("the link resolves as view-only", v1.actor.kind === "TOKEN" && v1.actor.viewOnly === true && (await pa.sharedLinkViewOnly(e.id, client.id)));
    c.ok("can() refuses every write: comment, change requests, suggestions, messages, booking, brand, approve", [...WRITES, "editBrandProfile", "approveEdits", "manageTeam"].every((p) => !pa.can(v1, p as never)));
    const refusal = pa.refusalMessage(v1, "comment");
    c.ok("the refusal says the one line, word for word", refusal === `This shared link is view-only. ${words.LINK_VIEW_ONLY_LINE}` && words.LINK_VIEW_ONLY_LINE === "Sign in to leave comments or ask for changes.", refusal);
    c.ok("…and every write gets the same words", WRITES.every((p) => pa.refusalMessage(v1, p) === refusal));
    c.ok("no dashes in the client words", !DASHES.test(refusal));
    const refused = await actions.portalAddComment({ token }, "no-such-cut-xyz", null, "Love the opening");
    c.ok("a real comment from the link is refused with those words (the server action, not just the button)", !refused.ok && refused.message === refusal, refused.message);
    const home1 = await page(v1, "home");
    const html1 = decode(renderToStaticMarkup(home1 as never));
    c.ok("Home carries the view-only notice", notices(home1)?.linkViewOnly === true);
    c.ok("…and shows the line with a sign-in link", html1.includes(`This shared link is view-only. ${words.LINK_VIEW_ONLY_LINE}`) && /data-link-view-only[^]*?href="\/portal\/login"[^>]*>Sign in with email</.test(html1));
    c.ok("…instead of the old 'This link keeps working too' sign-in offer", !html1.includes("This link keeps working too"));
    const paused: PortalViewer = { ...v1, access: "READ_ONLY", enrollment: { ...v1.enrollment, status: "PAUSED" } };
    c.ok("a paused program still says it is paused (that refusal comes first)", /paused/.test(pa.refusalMessage(paused, "comment")));
    const signedIn: PortalViewer = { ...v1, actor: { kind: "CLIENT", clientUserId: person.id, email: "harper@lane.example", name: "Harper Lane", membershipId: seat.id, membershipRole: "OWNER" }, via: "LOGIN" };
    c.ok("the signed-in person keeps every right", WRITES.every((p) => pa.can(signedIn, p)));
    const staff: PortalViewer = { ...v1, actor: { kind: "STAFF", staffUserId: "staff-drill-1", staffName: "Kyle Drill", staffRole: "ADMIN" }, via: "STAFF" };
    c.ok("staff on their behalf keep every right", WRITES.every((p) => pa.can(staff, p)));
    c.ok("a signed-in visit never shows the link banner", notices(await page(signedIn, "home"))?.linkViewOnly === false);

    c.head("5 · The person disabled, then the seat revoked: the link is full again");
    await prisma.clientUser.update({ where: { id: person.id }, data: { status: "DISABLED" } });
    await full("person disabled");
    await prisma.clientUser.update({ where: { id: person.id }, data: { status: "ACTIVE" } });
    c.ok("re-enabled: view-only again", (await asLink()).actor.kind === "TOKEN" && (await pa.sharedLinkViewOnly(e.id, client.id)));
    await prisma.clientMembership.update({ where: { id: seat.id }, data: { revokedAt: new Date() } });
    await full("seat revoked");
    const other = await prisma.client.create({ data: { name: "Other Program Realty" }, select: { id: true } });
    const otherE = await prisma.contentEnrollment.create({ data: { clientId: other.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 }, select: { id: true } });
    await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: otherE.id, clientId: other.id, role: "OWNER" } });
    await full("a seat on ANOTHER program only (per program, not per person)");
    await prisma.clientMembership.update({ where: { id: seat.id }, data: { revokedAt: null } });

    c.head("6 · Terms: the billing line texts Kyle on a tappable link");
    const terms = await page(await asLink(), "terms");
    const cards = find(terms, "TermsCard");
    c.ok("the Terms page hands the card Kyle's office line", cards.length === 1 && (cards[0].props.phones as { e164: string }[]).some((p) => p.e164 === words.OFFICE_LINE.e164) && words.OFFICE_LINE.e164 === "+12156454889");
    const termsHtml = decode(renderToStaticMarkup(terms as never));
    c.ok("the billing line reads 'Questions about billing? Text Kyle at (215) 645-4889.'", termsHtml.includes("Questions about billing? Text Kyle at ") && termsHtml.includes(">(215) 645-4889</a>."));
    c.ok("…and the number is a tap-to-text link", termsHtml.includes('href="sms:+12156454889"'));
    const plain = decode(renderToStaticMarkup(createElement(TermsCard, { blocks: ["Call us any time."], phones: [words.OFFICE_LINE] })));
    c.ok("a block without the number is left as plain words", plain.includes("Call us any time.") && !plain.includes("sms:"));
    const noPhones = decode(renderToStaticMarkup(createElement(TermsCard, { blocks: [`Questions about billing? ${words.TEXT_KYLE_START}.`] })));
    c.ok("with no phones handed in, nothing is linked (no number is invented)", !noPhones.includes("sms:"));

    c.head("7 · Downloaded: the client's own rows, newest wins, staff never counts");
    const visit = (videoId: string, via: string, at: Date, extra: { clientUserId?: string; staffUserId?: string; suffix?: string } = {}) =>
      prisma.portalVisit.create({ data: { enrollmentId: e.id, via, path: `/portal/download/${videoId}${extra.suffix ?? ""}`, clientUserId: extra.clientUserId ?? null, staffUserId: extra.staffUserId ?? null, createdAt: at } });
    const t1 = new Date(now.getTime() - 3 * 86_400_000);
    const t2 = new Date(now.getTime() - 1 * 86_400_000);
    await visit(vA.id, "TOKEN", t1, { suffix: "?cut=sub-a-1" });
    await visit(vA.id, "LOGIN", t2, { clientUserId: person.id, suffix: "?cut=sub-a-1&done=1" });
    await visit(vB.id, "STAFF", t2, { staffUserId: "staff-drill-1", suffix: "?cut=sub-b-1" });
    await prisma.portalVisit.create({ data: { enrollmentId: e.id, via: "TOKEN", path: "/portal/me?tab=library" } });
    const got = await clientDownloadsFor(e.id, [vA.id, vB.id, vC.id]);
    c.ok("video A: the newest client row wins (the finished download)", got.get(vA.id)?.getTime() === t2.getTime(), String(got.get(vA.id)?.toISOString()));
    c.ok("video B: a staff download on their behalf is not theirs", !got.has(vB.id));
    c.ok("video C: never downloaded, nothing", !got.has(vC.id) && got.size === 1);
    c.ok("another program's downloads are never read", (await clientDownloadsFor(otherE.id, [vA.id])).size === 0);
    const list = await portalVideoList({ id: e.id, clientId: client.id });
    const rowOf = (id: string) => list.rows.find((r) => r.id === id);
    c.ok("the list row for A carries its date", rowOf(vA.id)?.downloadedAtISO === t2.toISOString());
    c.ok("…and B and C carry none", !rowOf(vB.id)?.downloadedAtISO && !rowOf(vC.id)?.downloadedAtISO);
    const libHtml = decode(renderToStaticMarkup((await page(await asLink(), "library")) as never));
    const chips = libHtml.match(/data-downloaded[^>]*>[^]*?<\/span>/g) ?? [];
    c.ok("the Library shows exactly one 'Downloaded' status, on A", chips.length === 1 && /Downloaded /.test(chips[0]), chips.join(" | "));
    c.ok("…in client words without dashes", chips.every((s) => !DASHES.test(s.replace(/<[^>]+>/g, ""))));
    const door = fs.readFileSync(path.resolve(__dirname, "../../src/app/api/portal/download/[videoId]/route.ts"), "utf8");
    c.ok("a view-only link can still download: the door checks the media pass, never can()", /verifyMediaToken\(/.test(door) && !/\bcan\(/.test(door));

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
