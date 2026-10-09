// ---------------------------------------------------------------------------
// DRILL: OCT 9 2026 — THE CRON'S ARYEO LIST READS STOP TIMING OUT.
//
// "Aryeo timed out — please try again." from cron:sync/appointments and
// cron:reconcile/appointmentsSlice, 7× each in two days. Every failed step took
// ~39 s: three 12 s attempts at one GET /appointments page (100 rows with
// users + order embedded, ~11.7 s on average — right at the timeout). This
// drives the shipped aryeo.ts against a fenced fake:
//
//   1  A background list read waits 25 s, not 12 s, and retries ONCE (not
//      twice); an interactive GET keeps 12 s × 3. Proved with the fake holding
//      every request until the client gives up, and counting the attempts.
//   2  A slow page that answers inside the new window (here, after 13 s of the
//      fake's clock — what used to be a timeout) is read the first time.
//   3  The appointments list is read 50 a page; the reconcile slice's saved
//      cursor (page 5 of 100, written before today) resumes at page 9 of 50 —
//      the same row — and the cursor it writes back names its page size.
//
// ISOLATION: PGlite on 127.0.0.1:6872; every non-loopback call is fenced; the
// Aryeo key is a fake.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();

// Timers are compressed: setTimeout(fn, ms) fires after ms / SPEED, and the
// fake's "now" advances by the same scaled amount, so a 25 s timeout is 25 ms.
const SPEED = 1000;
const realSetTimeout = globalThis.setTimeout;
let fakeElapsed = 0;
const fastTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(() => { fakeElapsed += ms ?? 0; fn(...rest); }, Math.max(0, (ms ?? 0) / SPEED))) as typeof setTimeout;
/** Compressed time only around the reads under test — the database keeps real timers. */
async function fast<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.setTimeout = fastTimeout;
  try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; }
}

type Hit = { url: string; at: number };
const hits: Hit[] = [];
let respondAfterMs: number | null = null; // null = never answer (hang until aborted)
let pageRows: (url: URL) => unknown[] = () => [];
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://api.aryeo.com/")) return null;
  hits.push({ url, at: fakeElapsed });
  const signal = init?.signal;
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort);
    if (respondAfterMs !== null) {
      realSetTimeout(() => {
        if (signal?.aborted) return;
        const u = new URL(url);
        resolve(new Response(JSON.stringify({ data: pageRows(u), meta: { last_page: 40 } }), { status: 200, headers: { "content-type": "application/json" } }));
      }, respondAfterMs / SPEED);
    }
  });
});

async function main() {
  const drill = await bootDrillDb({ port: 6872 });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const KEY = ["drill", "key", "not", "real"].join("-");
  await saveSecret("aryeo", KEY);
  const aryeo = await import("@/lib/integrations/aryeo");

  c.head("1 · HOW LONG A READ WAITS, AND HOW OFTEN IT TRIES");
  {
    respondAfterMs = null;
    hits.length = 0;
    const t0 = fakeElapsed;
    const bg = await fast(() => aryeo.aryeoRequest("/appointments", { query: { page: 1 }, ...aryeo.BACKGROUND_LIST_READ, key: KEY }).then(() => "ok", (e: Error) => e.message));
    const bgHits = hits.length;
    c.ok("a background list read that never answers: 2 attempts, then 'Aryeo timed out'", bgHits === 2 && /timed out/.test(bg), `${bgHits} attempts · ${bg}`);
    c.ok("…25 s each, 3 s apart (≈ 53 s worst case, inside the steps' budgets)", fakeElapsed - t0 >= 53_000 && fakeElapsed - t0 < 60_000, `${fakeElapsed - t0} ms of fake time`);
    hits.length = 0;
    const t1 = fakeElapsed;
    const fg = await fast(() => aryeo.aryeoRequest("/orders/x", { key: KEY }).then(() => "ok", (e: Error) => e.message));
    c.ok("an interactive GET keeps the short default: 3 attempts of 12 s", hits.length === 3 && /timed out/.test(fg) && fakeElapsed - t1 >= 36_000 && fakeElapsed - t1 < 40_000, `${hits.length} attempts · ${fakeElapsed - t1} ms`);
  }

  c.head("2 · A SLOW PAGE IS READ THE FIRST TIME");
  {
    respondAfterMs = 13_000; // past the old 12 s timeout
    hits.length = 0;
    const r = await fast(() => aryeo.aryeoRequest<{ data: unknown[] }>("/appointments", { query: { page: 1 }, ...aryeo.BACKGROUND_LIST_READ, key: KEY }).catch(() => null));
    c.ok("a 13 s page answers on the first attempt", !!r && hits.length === 1, `${hits.length} attempt(s)`);
  }

  c.head("3 · 50 A PAGE, AND THE SAVED CURSOR RESUMES AT THE SAME ROW");
  {
    c.ok("apptPageAt: page 5 of 100 → page 9 of 50; page 1 → 1; same size → same page", aryeo.apptPageAt({ page: 5, perPage: 100 }, 50) === 9 && aryeo.apptPageAt({ page: 1, perPage: 100 }, 50) === 1 && aryeo.apptPageAt({ page: 7, perPage: 50 }, 50) === 7);
    c.ok("…a bigger new size rounds down (rows read twice, none skipped)", aryeo.apptPageAt({ page: 4, perPage: 50 }, 100) === 2);
    await prisma.appSetting.create({ data: { key: aryeo.APPT_CURSOR_KEY, value: JSON.stringify({ page: 5, startedAt: "2026-10-09T09:30:00.000Z", lastCompletedAt: null }) } });
    respondAfterMs = 0;
    pageRows = () => []; // past the end: an empty page
    hits.length = 0;
    const res = await aryeo.syncAryeoAppointments({ maxPages: 8, budgetMs: 60_000 });
    const first = hits.find((h) => h.url.includes("/appointments?"));
    const q = first ? new URL(first.url).searchParams : null;
    c.ok("the reconcile slice reads per_page=50 from page 9", q?.get("per_page") === "50" && q?.get("page") === "9", first?.url.replace(/^https:\/\/api\.aryeo\.com\/v1/, ""));
    const saved = JSON.parse((await prisma.appSetting.findUnique({ where: { key: aryeo.APPT_CURSOR_KEY } }))?.value ?? "{}") as { page?: number; perPage?: number };
    c.ok("…an empty page is the end of history: the cursor goes back to page 1, and names its page size", res.complete === true && saved.page === 1 && saved.perPage === 50, JSON.stringify(saved));
    hits.length = 0;
    await aryeo.syncAryeoAppointments({ recentOnlyDays: 21 });
    const hourly = hits.find((h) => h.url.includes("/appointments?"));
    c.ok("the hourly window read is 50 a page too, newest first", !!hourly && new URL(hourly.url).searchParams.get("per_page") === "50" && new URL(hourly.url).searchParams.get("sort") === "-start_at", hourly?.url.replace(/^https:\/\/api\.aryeo\.com\/v1/, ""));
  }

  c.ok("nothing left the machine but the fake", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
