// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Real Team Slack actions against a pure in-memory Prisma contract double and
// pure provider exports. No database, token, Slack lookup, sync or DM is used.
import { createRequire } from "node:module";
import { fenceFetch, makeChecker } from "./_harness";
type Row = { id: string; name: string; email: string; slackId: string | null; active: boolean };
type Query = { where?: { id?: string; slackId?: string | null | { not: null }; NOT?: { id: string }; active?: boolean; OR?: { slackId: string | null }[] }; data?: { slackId?: string | null } };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function until(fn: () => boolean) { for (let n = 0; n < 100 && !fn(); n++) await new Promise((r) => setTimeout(r, 5)); if (!fn()) throw new Error("fake action stage did not arrive"); }
async function main() {
  const req = createRequire(__filename), c = makeChecker(), fence = fenceFetch();
  const stub = (file: string, exports: unknown) => { const f = req.resolve(file); req.cache[f] = { id: f, filename: f, loaded: true, exports } as NodeModule; };
  let denied = false, refreshFails = false, failAfter = 0;
  let rows: Row[] = [{ id: "exact-row", name: "Kim Exact", email: "kim@example.test", slackId: null, active: true }];
  const writes: { kind: string; query: Query }[] = [], lookups: string[] = [], dms: { id: string; text: string }[] = [];
  let beforeCas: (() => Promise<void>) | null = null;
  const members = {
    findUnique: async (q: Query) => { const r = rows.find((r) => r.id === q.where?.id); return r ? { ...r } : null; },
    findFirst: async (q: Query) => { const r = rows.find((r) => r.slackId === q.where?.slackId && r.id !== q.where?.NOT?.id); return r ? { ...r } : null; },
    findMany: async (q: Query) => rows.filter((r) => q.where?.active === true ? r.active : typeof q.where?.slackId === "object" ? r.slackId !== null : true).map((r) => ({ ...r })),
    update: async (q: Query) => { writes.push({ kind: "manual", query: q }); const r = rows.find((r) => r.id === q.where?.id)!; r.slackId = q.data?.slackId ?? null; return { ...r }; },
    updateMany: async (q: Query) => {
      if (beforeCas) { const fn = beforeCas; beforeCas = null; await fn(); }
      const r = rows.find((r) => r.id === q.where?.id);
      const match = r && (q.where?.OR ? q.where.OR.some((x) => x.slackId === r.slackId) : r.slackId === q.where?.slackId);
      writes.push({ kind: "cas", query: q });
      if (failAfter && writes.filter((w) => w.kind === "cas").length >= failAfter) throw new Error("isolated partial-write failure");
      if (!match) return { count: 0 };
      r.slackId = q.data?.slackId ?? null; return { count: 1 };
    },
  };
  stub("../../src/lib/prisma.ts", { prisma: { teamMember: members } });
  stub("../../src/lib/auth/guards.ts", { requireAdmin: async () => { if (denied) throw new Error("Admin access required."); }, requireOwner: async () => { throw new Error("financial action not invoked"); } });
  stub("next/cache", { revalidatePath: () => { if (refreshFails) throw new Error("isolated post-write refresh lost"); } });
  let lookup = deferred<{ ok: true; id: string } | { ok: false; error: string }>();
  let directory: { ok: true; users: { id: string; name: string; displayName: string; email?: string }[] } | { ok: false; error: string } = { ok: false, error: "user_token_not_connected" };
  let dm: { ok: true; outcome?: "confirmed" } | { ok: false; error: string; outcome?: "refused" | "unknown" } = { ok: true, outcome: "confirmed" };
  const fakeSlack = { __esModule: true,
    slackLookupByEmail: async (email: string) => { lookups.push(email); return lookup.promise; },
    slackWorkspaceUsers: async () => directory,
    slackDmUserDetailed: async (id: string, text: string) => { dms.push({ id, text }); return dm; },
  };
  stub("../../src/lib/integrations/slack.ts", fakeSlack);
  stub("../../src/lib/auth/user.ts", { getCurrentUser: async () => ({ teamMemberId: "exact-row", email: "kim@example.test" }) });
  try {
    const provider = await import("@/lib/integrations/slack");
    if (provider.slackLookupByEmail !== fakeSlack.slackLookupByEmail || provider.slackWorkspaceUsers !== fakeSlack.slackWorkspaceUsers || provider.slackDmUserDetailed !== fakeSlack.slackDmUserDetailed) throw new Error(`Provider seam is not fully fake: ${Object.keys(provider).join()}`);
    const a = await import("@/app/team/actions");
    denied = true; const guards = await Promise.all([a.saveSlackId("exact-row", "UVALID001"), a.findSlackIdOnSlack("exact-row"), a.sendTestSlackDm("exact-row"), a.syncSlackIdsFromWorkspace()]);
    c.ok("all Slack admin guards remain typed prewrite/provider refusals", guards.every((r) => !r.ok && r.outcome === "refused") && !writes.length && !lookups.length && !dms.length); denied = false;
    const invalid = await a.saveSlackId("exact-row", "bad"), missing = await a.saveSlackId("missing", "UVALID001"), noDm = await a.sendTestSlackDm("exact-row");
    c.ok("existing ID regex/missing-row/no-recipient refusals remain before write or provider", [invalid, missing, noDm].every((r) => !r.ok && r.outcome === "refused") && !writes.length && !dms.length);
    rows.push({ id: "other-row", name: "Other Person", email: "other@example.test", slackId: "UTAKEN001", active: false });
    const taken = await a.saveSlackId("exact-row", "UTAKEN001");
    c.ok("existing one-person-per-ID precheck still includes other inactive rows", !taken.ok && taken.outcome === "refused" && taken.message.includes("Other Person") && !writes.length);
    const saved = await a.saveSlackId("exact-row", "  uvalid001  ");
    c.ok("ordinary manual save retains normalization/null semantics and exact row update", saved.ok && saved.outcome === "confirmed" && rows[0].slackId === "UVALID001" && JSON.stringify(writes[0].query) === JSON.stringify({ where: { id: "exact-row" }, data: { slackId: "UVALID001" } }));
    await a.saveSlackId("exact-row", null); lookup = deferred();
    const finding = a.findSlackIdOnSlack("exact-row"); await until(() => lookups.length === 1);
    await a.saveSlackId("exact-row", "UMANUAL01"); lookup.resolve({ ok: true, id: "UFIND0001" }); const conflict = await finding;
    const findCas = writes.find((w) => w.kind === "cas")!;
    c.ok("delayed lookup cannot overwrite a manual ID saved after its initial row read", !conflict.ok && conflict.outcome === "refused" && conflict.message.includes("changed") && rows[0].slackId === "UMANUAL01" && JSON.stringify(findCas.query.where) === JSON.stringify({ id: "exact-row", slackId: null }) && lookups[0] === "kim@example.test");
    lookup = deferred(); lookup.resolve({ ok: true, id: "UFIND0001" }); const found = await a.findSlackIdOnSlack("exact-row");
    c.ok("unchanged lookup still saves exact provider ID and reports confirmed success", found.ok && found.outcome === "confirmed" && found.slackId === "UFIND0001" && rows[0].slackId === "UFIND0001");
    lookup = deferred(); lookup.resolve({ ok: false, error: "unreachable" }); const readFailed = await a.findSlackIdOnSlack("exact-row");
    c.ok("failed read-only lookup proves no ID write and permits safe correction", !readFailed.ok && readFailed.outcome === "refused" && rows[0].slackId === "UFIND0001");
    refreshFails = true; let thrown = false; try { await a.saveSlackId("exact-row", "ULATE0001"); } catch { thrown = true; } refreshFails = false;
    c.ok("post-save local failure still rejects with saved ID intact, never typed no-write", thrown && rows[0].slackId === "ULATE0001");
    const wsRefused = await a.syncSlackIdsFromWorkspace();
    c.ok("directory-read failure remains known prewrite sync refusal with empty report", !wsRefused.ok && wsRefused.outcome === "refused" && !wsRefused.set.length && !wsRefused.skipped.length);
    rows = [
      { id: "sync-manual", name: "Kim Exact", email: "kim@example.test", slackId: null, active: true },
      { id: "sync-name", name: "James Creative", email: "unknown@example.test", slackId: "", active: true },
      { id: "sync-existing", name: "Existing Person", email: "existing@example.test", slackId: "UEXIST001", active: true },
      { id: "sync-ambiguous", name: "Sam Ambiguous", email: "sam@example.test", slackId: null, active: true },
      { id: "sync-taken", name: "Taken Match", email: "taken@example.test", slackId: null, active: true },
      { id: "inactive-holder", name: "Inactive Holder", email: "holder@example.test", slackId: "UTAKEN001", active: false },
    ];
    directory = { ok: true, users: [
      { id: "UFIND0001", name: "Kim Exact", displayName: "Kim", email: " KIM@example.test " },
      { id: "UNAME0001", name: "James Creative", displayName: "James" },
      { id: "USAM00001", name: "Sam One", displayName: "Sam", email: "sam@example.test" },
      { id: "USAM00002", name: "Sam Two", displayName: "Sam", email: "sam@example.test" },
      { id: "UTAKEN001", name: "Taken Match", displayName: "Taken", email: "taken@example.test" },
    ] };
    beforeCas = () => a.saveSlackId("sync-manual", "UMANUAL01").then(() => {});
    const sync = await a.syncSlackIdsFromWorkspace();
    c.ok("fill-empty CAS preserves a manual ID entered between sync snapshot and writer", rows[0].slackId === "UMANUAL01" && sync.ok && sync.outcome === "confirmed" && sync.skipped.some((s) => s.name === "Kim Exact" && s.reason.includes("changed")) && !sync.set.some((s) => s.name === "Kim Exact") && writes.filter((w) => w.kind === "cas").some((w) => JSON.stringify(w.query.where) === JSON.stringify({ id: "sync-manual", OR: [{ slackId: null }, { slackId: "" }] })));
    c.ok("existing exact email/unique-name matching and ambiguity/taken/previous-ID rules remain", rows[1].slackId === "UNAME0001" && rows[2].slackId === "UEXIST001" && sync.set.length === 1 && sync.set[0].by === "name" && sync.skipped.some((s) => s.name === "Sam Ambiguous" && s.reason.includes("2 Slack accounts")) && sync.skipped.some((s) => s.name === "Taken Match" && s.reason.includes("Inactive Holder")));
    rows = [{ id: "partial-one", name: "One Person", email: "one@example.test", slackId: null, active: true }, { id: "partial-two", name: "Two Person", email: "two@example.test", slackId: null, active: true }];
    directory = { ok: true, users: [{ id: "UONE00001", name: "One", displayName: "One", email: "one@example.test" }, { id: "UTWO00001", name: "Two", displayName: "Two", email: "two@example.test" }] };
    failAfter = writes.filter((w) => w.kind === "cas").length + 2; thrown = false; try { await a.syncSlackIdsFromWorkspace(); } catch { thrown = true; } failAfter = 0;
    c.ok("partial sync still throws honestly after first persisted row rather than returning no-write", thrown && rows[0].slackId === "UONE00001" && rows[1].slackId === null);
    rows = [{ id: "exact-row", name: "Kim Exact", email: "kim@example.test", slackId: "URECEIVE1", active: true }];
    const sent = await a.sendTestSlackDm("exact-row");
    c.ok("test DM preserves current exact recipient and fixed existing sentence with confirmed return", sent.ok && sent.outcome === "confirmed" && dms[0].id === "URECEIVE1" && dms[0].text === "⚙️ Test from the Ops Hub — you'll get pings here for tags and messages on your jobs.");
    dm = { ok: false, error: "chat.postMessage → channel_not_found; conversations.open → missing_scope", outcome: "refused" }; const negative = await a.sendTestSlackDm("exact-row");
    dm = { ok: false, error: "chat.postMessage → transport lost", outcome: "unknown" }; const unknown = await a.sendTestSlackDm("exact-row");
    dm = { ok: false, error: "legacy unavailable" }; const legacy = await a.sendTestSlackDm("exact-row");
    c.ok("test action distinguishes typed known negative from unknown/legacy without error-string inference", !negative.ok && negative.outcome === "refused" && negative.message.includes("If the bot") && !unknown.ok && unknown.outcome === "unknown" && unknown.message.includes("did not confirm") && legacy.outcome === "unknown");
    c.ok("Team action contract fixture performs no database/provider/financial/text send", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
