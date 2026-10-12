// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the Feedback & requests board answers at once (Oct 12 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-feedback-board.ts
//
// Jordan, Oct 12: "the approve button on the feedback and requests page … just
// spins endlessly. And the images don't open when I click them." Production
// showed both of Kyle's bug rows APPROVED (decidedAt 18:43:07 / 18:43:13 UTC)
// while the cards kept spinning: the decision awaited Slack, revalidated
// /feedback (every sidebar page re-rendered, ~20 per click in the logs) and
// the button's transition waited on that refresh. Thumbnails linked to stored
// data: URLs, which browsers refuse to open in a new tab.
//
//   §1 decide: an ADMIN gets a plain refusal (no throw), the owner's decision
//      saves and ANSWERS before any Slack line is attempted — the alert runs
//      after the response; un-approve sends nothing; bad id / bad status are
//      plain refusals.
//   §2 submit: the record is written and answered before email/Slack/bell;
//      a non-image "screenshot" is dropped.
//   §3 the screenshot route: owner gets the image bytes (private cache);
//      signed out 401; a photographer (no board access) 403; no screenshot
//      or a malformed id 404.
//   §4 the page: rows carry the route, never a data: URL; the board groups
//      the cards; a card's thumbnail is a button that opens a viewer (not a
//      link to data:), and nothing spins until something is pressed.
//   §5 no path revalidation left in the board's actions; nothing left the box.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Slack/email/bell are captured
// at @/lib/notify and @/lib/integrations/google; next/server's after() is
// captured so "answered before notifying" is observable.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");

const queued: (() => unknown)[] = [];
const sent = { ops: [] as string[], bells: [] as string[], emails: [] as string[] };
interceptModule((r) => r === "next/server", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "after" ? (fn: () => unknown) => { queued.push(fn); } : t[k]),
}));
interceptModule((r) => r === "@/lib/notify" || /[\\/]src[\\/]lib[\\/]notify(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(t, k) {
    if (k === "opsAlert") return async (text: string) => { sent.ops.push(text); return true; };
    if (k === "notifyInApp") return async (o: { title: string }) => { sent.bells.push(o.title); };
    return t[k];
  },
}));
interceptModule((r) => r === "@/lib/integrations/google" || /[\\/]src[\\/]lib[\\/]integrations[\\/]google(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "notifyOwnerEmail" ? async (subject: string) => { sent.emails.push(subject); return false; } : t[k]),
}));

function elementsNamed(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elementsNamed(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string; displayName?: string };
  const found = typeof type !== "string" && (type.displayName ?? type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elementsNamed(part, name))];
}

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6041), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct12-feedback-isolated-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { decidePlatformFeedback, submitPlatformFeedback } = await import("@/app/feedback/actions");
    const { GET } = await import("@/app/api/feedback/[id]/screenshot/route");
    const { default: FeedbackPage } = await import("@/app/feedback/page");
    const { PlatformFeedbackItem } = await import("@/components/feedback/PlatformFeedbackItem");
    const { FeedbackBoard } = await import("@/components/feedback/FeedbackBoard");
    const { parseScreenshotDataUrl } = await import("@/lib/feedbackScreenshot");

    const owner = await prisma.appUser.create({ data: { email: "owner-oct12fb@example.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle-oct12fb@example.test", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE" } });
    const james = await prisma.appUser.create({ data: { email: "james-oct12fb@example.test", name: "James", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const flush = async () => { while (queued.length) await queued.shift()!(); };

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const shot = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    const before = await prisma.platformFeedback.create({ data: { kind: "bug", title: "Trying to submit a revision", body: "Submitting a revision but it's giving me an error", submittedBy: "Kyle Smith", page: "/edit/fixture", screenshot: shot } });
    const after = await prisma.platformFeedback.create({ data: { kind: "bug", title: "The after for previous bug", submittedBy: "Kyle Smith", page: "/edit/fixture", screenshot: shot } });
    const idea = await prisma.platformFeedback.create({ data: { kind: "feature", title: "Video count x/4", submittedBy: "Kyle Smith", status: "DONE" } });

    c.head("§1 decide answers at once, in words");
    await signIn(kyle);
    let threw = false;
    const refused = await decidePlatformFeedback(before.id, "APPROVED").catch(() => { threw = true; return null; });
    c.ok("an ADMIN's Approve is a plain refusal, not a thrown error", !threw && refused?.ok === false && !!refused.message, JSON.stringify(refused));
    c.ok("…and the row is unchanged", (await prisma.platformFeedback.findUnique({ where: { id: before.id } }))?.status === "NEW");
    await signIn(owner);
    const approved = await decidePlatformFeedback(before.id, "APPROVED");
    const row = await prisma.platformFeedback.findUnique({ where: { id: before.id } });
    c.ok("the owner's Approve saves and answers ok with the new status", approved.ok && approved.status === "APPROVED" && row?.status === "APPROVED" && !!row.decidedAt, JSON.stringify(approved));
    c.ok("the answer came back BEFORE any Slack line was attempted (queued after the response)", sent.ops.length === 0 && queued.length === 1);
    await flush();
    c.ok("…then the ops line goes out after the answer", sent.ops.length === 1 && /approved/.test(sent.ops[0]) && /Trying to submit a revision/.test(sent.ops[0]) && /\/feedback$/.test(sent.ops[0]), sent.ops[0]);
    const second = await decidePlatformFeedback(after.id, "APPROVED");
    c.ok("a second Approve right after the first answers on its own (no waiting on the first)", second.ok && queued.length === 1);
    await flush();
    const undo = await decidePlatformFeedback(before.id, "NEW");
    c.ok("Un-approve puts it back in review, clears the decision time and sends nothing", undo.ok && queued.length === 0 && (await prisma.platformFeedback.findUnique({ where: { id: before.id } }))?.decidedAt === null);
    const ghost = await decidePlatformFeedback("cmzzzzzzzzzzzzzzzzzzzzzzz", "APPROVED").catch(() => null);
    c.ok("an item that no longer exists is a plain refusal", ghost?.ok === false && /Reload/.test(ghost.message), JSON.stringify(ghost));
    const bogus = await decidePlatformFeedback(after.id, "SHIPPED" as never).catch(() => null);
    c.ok("an unknown decision is refused without touching the row", bogus?.ok === false && (await prisma.platformFeedback.findUnique({ where: { id: after.id } }))?.status === "APPROVED");

    c.head("§2 submit answers before notifying");
    await signIn(james);
    const opsBefore = sent.ops.length;
    const filed = await submitPlatformFeedback({ kind: "bug", title: "Upload stalls at 99%", body: "On my phone", page: "/upload/x", screenshot: shot });
    const filedRow = await prisma.platformFeedback.findFirst({ where: { title: "Upload stalls at 99%" } });
    c.ok("the report is saved, stamped with the signed-in name, and answered", filed.ok && filedRow?.submittedBy === "James" && filedRow.screenshot === shot);
    c.ok("…before the email, Slack line or bell", sent.ops.length === opsBefore && sent.emails.length === 0 && sent.bells.length === 0 && queued.length === 1);
    await flush();
    c.ok("…which all go after the answer", sent.emails.length === 1 && sent.ops.length === opsBefore + 1 && /Gmail send not connected/.test(sent.ops.at(-1) ?? "") && sent.bells.length === 1);
    await submitPlatformFeedback({ kind: "bug", title: "Sneaky", screenshot: "data:text/html;base64,PHNjcmlwdD4=" });
    await flush();
    c.ok("a non-image 'screenshot' is dropped, the report still saved", (await prisma.platformFeedback.findFirst({ where: { title: "Sneaky" } }))?.screenshot === null);

    c.head("§3 the screenshot opens through an authorised route");
    const fetchShot = (id: string) => GET(new Request(`http://drill.local/api/feedback/${id}/screenshot`), { params: Promise.resolve({ id }) });
    await signIn(owner);
    const img = await fetchShot(after.id);
    const bytes = Buffer.from(await img.arrayBuffer());
    c.ok("the owner gets the image itself", img.status === 200 && img.headers.get("content-type") === "image/jpeg" && bytes.equals(jpeg), `${img.status} ${img.headers.get("content-type")}`);
    c.ok("…inline, privately cached only", /^inline/.test(img.headers.get("content-disposition") ?? "") && /^private/.test(img.headers.get("cache-control") ?? ""));
    c.ok("a row with no screenshot is 404", (await fetchShot(idea.id)).status === 404);
    c.ok("a malformed id is 404 without a lookup", (await fetchShot("../../etc")).status === 404);
    await signIn(kyle);
    c.ok("Kyle (admin, on the board) can open it too", (await fetchShot(after.id)).status === 200);
    await signIn(james);
    c.ok("a photographer without board access is refused", (await fetchShot(after.id)).status === 403);
    await clearSession();
    c.ok("signed out is 401", (await fetchShot(after.id)).status === 401);
    c.ok("the parser refuses anything but png/jpeg data URLs", parseScreenshotDataUrl("data:image/svg+xml;base64,PHN2Zz4=") === null && parseScreenshotDataUrl(null) === null && parseScreenshotDataUrl(shot)?.type === "image/jpeg");

    c.head("§4 the page and the cards");
    await signIn(owner);
    const tree = await FeedbackPage();
    const board = elementsNamed(tree, "FeedbackBoard")[0] as { rows?: { id: string; screenshot: string | null; status: string }[]; canModerate?: boolean } | undefined;
    const rows = board?.rows ?? [];
    c.ok("the board gets every hub row, owner can moderate", rows.length === 5 && board?.canModerate === true, String(rows.length));
    c.ok("screenshots are the route, never the stored data: URL", rows.find((r) => r.id === after.id)?.screenshot === `/api/feedback/${after.id}/screenshot` && rows.find((r) => r.id === idea.id)?.screenshot === null && !JSON.stringify(rows).includes("data:"));
    const card = renderToStaticMarkup(createElement(PlatformFeedbackItem, { row: { id: after.id, kind: "bug", title: "The after for previous bug", body: null, submittedBy: "Kyle Smith", status: "NEW", createdAt: new Date().toISOString(), screenshot: `/api/feedback/${after.id}/screenshot`, page: null }, canModerate: true }));
    c.ok("the thumbnail is a button showing the route image (opens the viewer), not a link to data:", /<button[^>]*title="Open the screenshot full size"[^>]*><img[^>]*src="\/api\/feedback\/[^"]+\/screenshot"/.test(card) && !card.includes("data:image") && !/<a [^>]*href="data:/.test(card));
    c.ok("nothing spins until something is pressed", !card.includes('aria-label="Saving"') && card.includes("Approve"));
    const saving = renderToStaticMarkup(createElement(PlatformFeedbackItem, { row: { id: after.id, kind: "bug", title: "x", body: null, submittedBy: null, status: "APPROVED", createdAt: new Date().toISOString(), screenshot: null, page: null }, canModerate: true, onDecide: () => {}, saving: true, error: "Only Jordan can decide feedback." }));
    c.ok("while saving it spins and shows the reason when refused", saving.includes('aria-label="Saving"') && saving.includes("Only Jordan can decide feedback.") && saving.includes("Approved — queued for build"));
    const boardHtml = renderToStaticMarkup(createElement(FeedbackBoard, { rows: rows as never, canModerate: true, pingTargets: [] }));
    c.ok("the board groups cards by decision", boardHtml.includes("Needs review") && boardHtml.includes("Approved — building") && boardHtml.includes("Shipped"));

    c.head("§5 no refresh storm, nothing left the box");
    const actionsSrc = fs.readFileSync(path.join(REPO, "src/app/feedback/actions.ts"), "utf8").replace(/\/\/.*$/gm, "");
    c.ok("the board's actions revalidate no path (the page is force-dynamic)", !/revalidatePath\(/.test(actionsSrc));
    const itemSrc = fs.readFileSync(path.join(REPO, "src/components/feedback/PlatformFeedbackItem.tsx"), "utf8");
    c.ok("decisions are not wrapped in a transition that waits for a refresh", !/start\(async \(\) => \{\s*setErr/.test(itemSrc) && !/useTransition\(\);\s*const \[err/.test(itemSrc));
    c.ok("no provider request escaped the fence", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    console.log(await drill.evidence());
    c.summary();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
