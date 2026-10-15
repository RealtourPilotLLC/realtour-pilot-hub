// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the questions panel under a chosen topic, rendered (Oct 15 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-topic-questions-render.ts
//
// A topic on a month planned on a call: "Questions for the call", the six
// read-only, nothing to write; the team sees "Answer this one in writing
// instead", the client does not. A topic asked in writing: a box under each
// question with what was saved, "Send my answers", and the team's "Back to the
// call (undo)". Sent answers read back, no boxes. No em dashes anywhere.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { PortalTopic } from "@/lib/portal";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/portal/x";
  nav.useSearchParams = () => new URLSearchParams();
}
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5829) });
  const c = makeChecker();
  try {
    const { TopicQuestions } = await import("@/components/portal/TopicQuestions");
    const items = [
      { key: "audienceProblem", text: "For “Why Malvern”, what do buyers usually get wrong?", answer: null, skipped: false },
      { key: "pointOfView", text: "What's your honest take on that?", answer: "Malvern has the best downtown for the money.", skipped: false },
      { key: "talkingPoints", text: "Walk me through it.", answer: null, skipped: false },
      { key: "evidence", text: "Is there a real example?", answer: null, skipped: true },
      { key: "story", text: "Anything we could show on camera?", answer: null, skipped: false },
      { key: "nextAction", text: "After watching, what should someone do next?", answer: null, skipped: false },
    ];
    const topic = (route: "CALL" | "WRITTEN", status: string | null = null): PortalTopic => ({
      id: "t1", title: "Why Malvern", state: "SELECTED", script: null, selection: { monthId: "m1", monthKey: "2026-10", status: "SELECTED", overflow: false, removable: true },
      questions: { route, callMonth: true, interviewId: route === "WRITTEN" ? "iv1" : null, status, items },
    } as unknown as PortalTopic);
    const render = (t: PortalTopic, staff: boolean, canAct = true) => html(createElement(TopicQuestions, { t, canAct, readOnly: false, staff, tabHref: "/portal/x?tab=plan" }));

    c.head("on the call");
    const callClient = render(topic("CALL"), false);
    c.ok("the client sees 'Questions for the call', the six numbered, nothing to write", /Questions for the call/.test(text(callClient)) && (callClient.match(/<li>/g) ?? []).length === 6 && !/<textarea/.test(callClient) && /Nothing to write/.test(text(callClient)));
    c.ok("…and no team switch", !/in writing instead/.test(text(callClient)));
    const callStaff = render(topic("CALL"), true);
    c.ok("the team (Jordan on the call) can ask for this one in writing", /Answer this one in writing instead/.test(text(callStaff)));
    c.ok("the questions are open under the topic (not folded away)", /<details open=""/.test(callClient));

    c.head("in writing");
    const written = render(topic("WRITTEN", "IN_PROGRESS"), false);
    c.ok("a box under each question, with what she saved", (written.match(/<textarea/g) ?? []).length === 6 && /Malvern has the best downtown for the money\./.test(written) && /Your questions · 1 of 6 answered/.test(text(written)), text(written).slice(0, 160));
    c.ok("…and Send my answers", /Send my answers/.test(text(written)));
    const writtenStaff = render(topic("WRITTEN", "IN_PROGRESS"), true);
    c.ok("the team can undo it: Back to the call (undo)", /Back to the call \(undo\)/.test(text(writtenStaff)));
    const sent = render(topic("WRITTEN", "SUBMITTED"), false);
    c.ok("sent answers read back, no boxes, no Send", !/<textarea/.test(sent) && /Your answers \(sent\)/.test(text(sent)) && /Left blank/.test(text(sent)) && !/Send my answers/.test(text(sent)));
    const viewOnly = render(topic("WRITTEN", "IN_PROGRESS"), false, false);
    c.ok("a view-only seat reads the questions and answers, no boxes", !/<textarea/.test(viewOnly) && /Malvern has the best downtown/.test(viewOnly));
    c.ok("no em dashes in what the client reads", [callClient, written, sent].every((h) => !text(h).includes("—")));

    c.head("isolation");
    c.ok("no outbound call escaped", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
