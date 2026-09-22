// ---------------------------------------------------------------------------
// DRILL: R1 + R2 — the client's script decision (follow-up audit, Sep 22 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r1-r2-script-decisions.ts
//
// R1. The browser sent a script id and the server took whatever sharedVersionId
// was current. A client with v1 open, after v2 was released, pressed "I'll film
// this" and approved words they had never read. And three surfaces answered
// "did the client approve this" with two different rules: the portal and the
// staff panel read the newest ledger row, the PHOTOGRAPHER'S FILMING BRIEF read
// a pointer that a change request never cleared.
//
// R2. The ledger row, the staff work item and the script stamp were three
// unrelated writes, and the duplicate guard only looked at the ledger — so a
// failed ScriptSuggestion insert plus a retry told the client "it's with the
// writer" over an empty queue.
//
// ISOLATION. PGlite in-process Postgres on its own DATABASE_URL, pinned before
// any app module loads. Production Neon is never opened. Every outbound HTTP
// call is fenced to loopback and counted.
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5491;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;
delete process.env.SLACK_ALERT_CHANNEL;

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return realFetch(input as string, init as RequestInit);
  outbound.push(url);
  throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
}) as typeof fetch;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { clientApproveScript, clientRequestScriptChanges, scriptDecisionsFor, currentScriptDecision, repairScriptChangeRequests } = await import("@/lib/scriptDecisions");
  const { topicsForSession } = await import("@/lib/filmedTopics");

  // ---- the fixture: a content month with one topic and one shared script ---
  const client = await prisma.client.create({ data: { name: "Ada Vance TEST" }, select: { id: true } });
  const enrollment = await prisma.contentEnrollment.create({
    data: { clientId: client.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 },
    select: { id: true },
  });
  const month = await prisma.contentMonth.create({
    data: { enrollmentId: enrollment.id, clientId: client.id, monthKey: "2026-10", videosOwed: 2 },
    select: { id: true },
  });
  const project = await prisma.project.create({ data: { clientId: client.id, title: "Oct content", status: "SCHEDULED", contentMonthId: month.id }, select: { id: true } });
  const topic = await prisma.contentTopic.create({
    data: { enrollmentId: enrollment.id, clientId: client.id, monthId: month.id, title: "Why the first weekend decides your price", status: "SCRIPTED" },
    select: { id: true },
  });
  await prisma.contentTopicSelection.create({
    data: { topicId: topic.id, monthId: month.id, enrollmentId: enrollment.id, clientId: client.id, status: "SELECTED", source: "staff" },
  });

  const script = await prisma.contentScript.create({
    data: { enrollmentId: enrollment.id, clientId: client.id, monthId: month.id, topicId: topic.id, title: "First weekend", body: "v1 body", status: "APPROVED", releaseState: "released" },
    select: { id: true },
  });
  const mkVersion = async (n: number) =>
    prisma.contentScriptVersion.create({
      data: {
        scriptId: script.id, enrollmentId: enrollment.id, clientId: client.id, versionNo: n,
        title: "First weekend", hook: `hook v${n}`, pointsJson: "[]", close: `close v${n}`, body: `v${n} body`, source: "AI", status: "SHARED",
      },
      select: { id: true, versionNo: true },
    });
  const v1 = await mkVersion(1);
  await prisma.contentScript.update({ where: { id: script.id }, data: { sharedVersionId: v1.id, approvedVersionId: v1.id, sharedAt: new Date() } });

  // A viewer, as the portal builds one.
  const clientUser = await prisma.clientUser.create({ data: { email: "ada@example.com", name: "Ada Vance" }, select: { id: true } });
  const viewer = {
    enrollment: { id: enrollment.id, clientId: client.id, clientName: "Ada Vance TEST" },
    actor: { kind: "CLIENT" as const, clientUserId: clientUser.id, membershipRole: "OWNER" },
    access: "FULL" as const,
    via: "TOKEN" as const,
  } as unknown as Parameters<typeof clientApproveScript>[0];

  // =========================================================================
  console.log("\n=== R1: the decision is about the words they read ===\n");
  // =========================================================================

  // The honest case still works.
  {
    const r = await clientApproveScript(viewer, script.id, v1.id);
    ok("approving the version the page showed works", r.ok === true, r.message);
    const d = await scriptDecisionsFor(enrollment.id, [script.id]);
    ok("  …and reads back as APPROVED", d.get(script.id)?.decision === "APPROVED");
  }

  // THE AUDIT'S REPRODUCTION. v2 is released while a tab still shows v1.
  const v2 = await mkVersion(2);
  await prisma.contentScriptVersion.update({ where: { id: v1.id }, data: { status: "SUPERSEDED" } });
  await prisma.contentScript.update({ where: { id: script.id }, data: { sharedVersionId: v2.id, approvedVersionId: v2.id } });

  {
    const d = await scriptDecisionsFor(enrollment.id, [script.id]);
    ok("a new release drops the old approval from 'decided'", d.get(script.id)?.decision === null, String(d.get(script.id)?.decision));
    ok("  …and says so as a stale approval", d.get(script.id)?.staleApproval === true);

    // The stale tab presses the button. It is still sending v1.
    const stale = await clientApproveScript(viewer, script.id, v1.id);
    ok("BEFORE: this used to approve v2, which they never read. Now it is refused", stale.ok === false, stale.message);
    ok("  …as a REFRESH, not an error", stale.ok === false && stale.stale === true);

    const after = await scriptDecisionsFor(enrollment.id, [script.id]);
    ok("  …and v2 is still undecided", after.get(script.id)?.decision === null);

    const staleNote = await clientRequestScriptChanges(viewer, script.id, "make the hook punchier", v1.id);
    ok("a change request from the same stale tab is refused too", staleNote.ok === false && staleNote.stale === true);
    ok("  …and no work item was filed against v2", (await prisma.scriptSuggestion.count()) === 0);
  }

  // A fresh read of v2 decides normally.
  {
    const r = await clientApproveScript(viewer, script.id, v2.id);
    ok("reading v2 and approving it works", r.ok === true, r.message);
  }

  // =========================================================================
  console.log("\n=== R1(b): every surface gives the same answer ===\n");
  // =========================================================================
  {
    // Link the topic's video row so the filming brief has something to show.
    const changed = await clientRequestScriptChanges(viewer, script.id, "cut the second point entirely", v2.id);
    ok("after an approval, a change request on the same version is accepted", changed.ok === true, changed.message);

    const d = await scriptDecisionsFor(enrollment.id, [script.id]);
    ok("portal + staff panel say CHANGES_REQUESTED", d.get(script.id)?.decision === "CHANGES_REQUESTED", String(d.get(script.id)?.decision));

    const brief = await topicsForSession(project.id);
    const line = brief?.topics.find((t) => t.topicId === topic.id);
    // THE DEFECT: this used to read clientApprovedVersionId === sharedVersionId,
    // which a change request never cleared.
    ok("BEFORE: the photographer's brief said approved. Now it agrees", line?.clientApproved === false, `clientApproved=${line?.clientApproved}`);

    const row = await prisma.contentScript.findUnique({ where: { id: script.id }, select: { clientApprovedVersionId: true, clientChangesAt: true } });
    ok("  …because the approval pointer was cleared, not just shadowed", row?.clientApprovedVersionId === null);
    ok("  …and the ledger kept both decisions as history", (await prisma.contentScriptRelease.count({ where: { scriptId: script.id, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } } })) === 3);
  }

  // Changing their mind back is allowed, and is not silent.
  {
    const back = await clientApproveScript(viewer, script.id, v2.id);
    ok("approving after their own change request is allowed", back.ok === true);
    ok("  …and the message tells them the team was told", back.ok === true && /asked for a change/i.test(back.message), back.ok ? back.message : "");
    const brief = await topicsForSession(project.id);
    ok("  …and every surface flips back together", brief?.topics.find((t) => t.topicId === topic.id)?.clientApproved === true);
  }

  // The pure rule, on its own.
  {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const t1 = new Date("2026-10-01T11:00:00Z");
    const rows = [
      { id: "b", action: "CLIENT_CHANGES", scriptVersionId: "vB", createdAt: t1, actorEmail: null },
      { id: "a", action: "CLIENT_APPROVED", scriptVersionId: "vA", createdAt: t0, actorEmail: null },
    ];
    ok("a newer decision on ANOTHER version never answers for this one", currentScriptDecision("vA", rows).decision === "APPROVED");
    ok("  …and the shared version's own newest row wins", currentScriptDecision("vB", rows).decision === "CHANGES_REQUESTED");
    ok("nothing shared means nothing decided", currentScriptDecision(null, rows).decision === null);
    // Same millisecond: the id breaks the tie deterministically, both ways round.
    const same = [
      { id: "aaa", action: "CLIENT_APPROVED", scriptVersionId: "vC", createdAt: t0, actorEmail: null },
      { id: "zzz", action: "CLIENT_CHANGES", scriptVersionId: "vC", createdAt: t0, actorEmail: null },
    ];
    ok("two rows in the same millisecond resolve deterministically", currentScriptDecision("vC", same).decision === currentScriptDecision("vC", [...same].reverse()).decision);
  }

  // =========================================================================
  console.log("\n=== R2: a change request always leaves a work item ===\n");
  // =========================================================================
  const v3 = await mkVersion(3);
  await prisma.contentScript.update({ where: { id: script.id }, data: { sharedVersionId: v3.id, approvedVersionId: v3.id } });

  {
    // THE INJECTED FAILURE: the work item write fails after the ledger row.
    // With the transaction, NEITHER should land.
    //
    // It has to be injected INSIDE the transaction. Stubbing
    // prisma.scriptSuggestion.create does nothing here: an interactive
    // transaction hands the callback its own client, so the stub is never
    // reached and the drill silently tests nothing. (It did, on the first run.)
    // So $transaction itself is wrapped and the callback is given a proxied tx.
    const realTx = prisma.$transaction.bind(prisma);
    const injected = { fired: false };
    let throwOnce = true;
    (prisma as unknown as { $transaction: unknown }).$transaction = ((fn: unknown, ...rest: unknown[]) => {
      if (typeof fn !== "function") return (realTx as unknown as (...a: unknown[]) => unknown)(fn, ...rest);
      return (realTx as unknown as (cb: (tx: unknown) => unknown) => unknown)((tx: unknown) => {
        const proxied = new Proxy(tx as object, {
          get(target, prop, recv) {
            if (prop === "scriptSuggestion") {
              const real = Reflect.get(target, prop, recv) as { create: (...a: unknown[]) => unknown };
              return new Proxy(real, {
                get(t2, p2, r2) {
                  if (p2 === "create") {
                    return async (...args: unknown[]) => {
                      if (throwOnce) { throwOnce = false; injected.fired = true; throw new Error("disk full"); }
                      return (Reflect.get(t2, p2, r2) as (...a: unknown[]) => unknown)(...args);
                    };
                  }
                  return Reflect.get(t2, p2, r2);
                },
              });
            }
            return Reflect.get(target, prop, recv);
          },
        });
        return (fn as (tx: unknown) => unknown)(proxied);
      });
    }) as typeof prisma.$transaction;

    const before = await prisma.contentScriptRelease.count({ where: { scriptId: script.id, scriptVersionId: v3.id, action: "CLIENT_CHANGES" } });
    let threw = false;
    try {
      await clientRequestScriptChanges(viewer, script.id, "swap the opening line for the stat", v3.id);
    } catch { threw = true; }
    (prisma as unknown as { $transaction: unknown }).$transaction = realTx;
    ok("the injection actually fired (a drill that tests nothing must say so)", injected.fired);

    const after = await prisma.contentScriptRelease.count({ where: { scriptId: script.id, scriptVersionId: v3.id, action: "CLIENT_CHANGES" } });
    ok("a failed work-item write rolls the ledger row back too", after === before, `ledger rows ${before} -> ${after}${threw ? " (threw)" : ""}`);
    ok("  …so the client is never told it is with the writer over an empty queue", (await prisma.scriptSuggestion.count({ where: { scriptVersionId: v3.id } })) === 0);

    // The retry now works cleanly.
    const retry = await clientRequestScriptChanges(viewer, script.id, "swap the opening line for the stat", v3.id);
    ok("the retry lands the whole request", retry.ok === true, retry.message);
    ok("  …exactly once on the ledger", (await prisma.contentScriptRelease.count({ where: { scriptId: script.id, scriptVersionId: v3.id, action: "CLIENT_CHANGES" } })) === 1);
    ok("  …and exactly once in the queue", (await prisma.scriptSuggestion.count({ where: { scriptVersionId: v3.id } })) === 1);
  }

  // The OTHER half of R2: a ledger row that exists with no work item (a row
  // written before this fix). The retry must REPAIR, not congratulate itself.
  {
    await prisma.scriptSuggestion.deleteMany({ where: { scriptVersionId: v3.id } });
    const r = await clientRequestScriptChanges(viewer, script.id, "swap the opening line for the stat", v3.id);
    ok("BEFORE: the retry said 'with the writer' and did nothing. Now it repairs", r.ok === true && (r as { repaired?: boolean }).repaired === true, r.message);
    ok("  …and the queue has it", (await prisma.scriptSuggestion.count({ where: { scriptVersionId: v3.id } })) === 1);
    ok("  …without a second ledger row", (await prisma.contentScriptRelease.count({ where: { scriptId: script.id, scriptVersionId: v3.id, action: "CLIENT_CHANGES" } })) === 1);
  }

  // Exact identity, not "ends the same way".
  {
    const a = "The hook is wrong. Please rewrite it and make it punchier.";
    const b = "The close is wrong. Please rewrite it and make it punchier.";
    await clientRequestScriptChanges(viewer, script.id, a, v3.id);
    await clientRequestScriptChanges(viewer, script.id, b, v3.id);
    const rows = await prisma.scriptSuggestion.findMany({ where: { scriptVersionId: v3.id }, select: { body: true } });
    ok("BEFORE: two notes ending the same way collided. Now both survive", rows.some((r) => r.body === a) && rows.some((r) => r.body === b), `${rows.length} item(s)`);
    // And the same words twice inside the window is still one request.
    const dup = await clientRequestScriptChanges(viewer, script.id, a, v3.id);
    ok("the same words twice is still one request", dup.ok === true && dup.duplicate === true && rows.filter((r) => r.body === a).length === 1);
  }

  // The sweep, for rows nobody retries.
  {
    await prisma.scriptSuggestion.deleteMany({});
    const r = await repairScriptChangeRequests({ sinceDays: 90, max: 300 });
    const ledgerAsks = await prisma.contentScriptRelease.count({ where: { action: "CLIENT_CHANGES" } });
    ok("the sweep re-files every orphaned request", r.repaired > 0 && r.failed === 0, `repaired ${r.repaired} of ${ledgerAsks} ledger ask(s)`);
    const distinct = await prisma.contentScriptRelease.findMany({ where: { action: "CLIENT_CHANGES" }, select: { scriptId: true, scriptVersionId: true, note: true } });
    const uniq = new Set(distinct.map((d) => `${d.scriptId}|${d.scriptVersionId}|${d.note}`));
    ok("  …one per distinct ask, not one per ledger row", (await prisma.scriptSuggestion.count()) === uniq.size, `${await prisma.scriptSuggestion.count()} vs ${uniq.size}`);
    const again = await repairScriptChangeRequests({ sinceDays: 90, max: 300 });
    ok("  …and running it twice repairs nothing the second time", again.repaired === 0);
  }

  ok("nothing reached the network", outbound.length === 0, outbound.join(", "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await server.stop();
  await db.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
