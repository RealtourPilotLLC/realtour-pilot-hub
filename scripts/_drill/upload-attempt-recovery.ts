// @drill-run: engine=postgres needs=tools/realpg
// Exact core receipts and unfinished-request holds. Real signed actions and
// disposable PostgreSQL; provider destinations are fenced, never contacted.
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { randomUUID } from "node:crypto";
import { uploadAttemptFingerprint, uploadAttemptRowId, parseUploadCommitReceipt } from "../../src/lib/uploadReceipt";
function door() { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { wait, open }; }
let park: { projectId: string; arrived: ReturnType<typeof door>; release: ReturnType<typeof door> } | null = null;
let sizePark: { projectId: string; arrived: ReturnType<typeof door>; release: ReturnType<typeof door> } | null = null;
let lateFail: string | null = null;
let terminalFail: string | null = null;
let barrier: { rowId: string; count: number; release: ReturnType<typeof door> } | null = null;
installNextStubs();
interceptModule((r) => r === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(r), (loaded) => {
  const m = loaded as { prisma: Record<PropertyKey, unknown> };
  const bind = (value: unknown, self: object) => typeof value === "function" ? value.bind(self) : value;
  return { ...m, prisma: new Proxy(m.prisma, { get(target, key) {
    const delegate = Reflect.get(target, key, target);
    if (!["uploadDraft", "activity", "auditLog", "project"].includes(String(key))) return bind(delegate, target);
    return new Proxy(delegate as Record<PropertyKey, unknown>, { get(d, method) {
      const fn = Reflect.get(d, method, d);
      if (key === "project" && method === "findUnique") return async (args: { where: { id: string }; select?: { squareFeet?: boolean } }) => {
        const result = await (fn as (args: unknown) => Promise<unknown>).call(d, args);
        if (sizePark && sizePark.projectId === args.where.id && args.select?.squareFeet && Object.keys(args.select).length === 1) { const p = sizePark; p.arrived.open(); await p.release.wait; }
        return result;
      };
      if (key === "uploadDraft" && method === "updateMany") return async (args: { where?: { projectId?: string } }) => {
        if (park && park.projectId === args.where?.projectId) { const p = park; p.arrived.open(); await p.release.wait; }
        return (fn as (args: unknown) => Promise<unknown>).call(d, args);
      };
      if (key === "activity" && method === "create") return async (args: { data: { projectId: string; body: string } }) => {
        if (lateFail === args.data.projectId && args.data.body === "Photographer completed upload. Editor brief is ready for the editors.") { lateFail = null; throw new Error("isolated post-core failure"); }
        return (fn as (args: unknown) => Promise<unknown>).call(d, args);
      };
      if (key === "auditLog" && method === "findUnique") return async (args: { where: { id: string }; select?: { id?: boolean } }) => {
        const result = await (fn as (args: unknown) => Promise<unknown>).call(d, args);
        if (barrier?.rowId === args.where.id && args.select?.id) { const b = barrier; b.count++; if (b.count === 2) b.release.open(); await b.release.wait; }
        return result;
      };
      if (key === "auditLog" && method === "update") return async (args: { where: { id: string }; data: { detail: string } }) => {
        if (terminalFail === args.where.id && JSON.parse(args.data.detail).phase === "complete") throw new Error("isolated terminal marker failure");
        return (fn as (args: unknown) => Promise<unknown>).call(d, args);
      };
      return bind(fn, d);
    } });
  } }) };
});
async function main() {
  const db = await bootDrillDb({ engine: "postgres", pool: 6, port: Number(process.env.DRILL_PORT ?? 5972), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-upload-receipt-secret" } });
  const c = makeChecker(), fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const a = await import("@/app/upload/actions");
    const { setSession } = await import("@/lib/auth/session");
    const tm = await prisma.teamMember.create({ data: { name: "Upload Fixture Shooter", email: "shooter-upload@example.test", role: "PHOTOGRAPHER" } });
    const shooter = await prisma.appUser.create({ data: { name: tm.name, email: tm.email!, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: tm.id } });
    const owner = await prisma.appUser.create({ data: { name: "Upload Fixture Office", email: "office-upload@example.test", role: "OWNER", status: "ACTIVE" } });
    const otherTm = await prisma.teamMember.create({ data: { name: "Other Shooter", email: "other-upload@example.test", role: "PHOTOGRAPHER" } });
    const other = await prisma.appUser.create({ data: { name: otherTm.name, email: otherTm.email!, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: otherTm.id } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "editor-upload@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const as = (u: typeof shooter, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Upload Receipt Fixture" } });
    const job = (title: string) => prisma.project.create({ data: { title, clientId: client.id, status: "SCHEDULED", shootDate: new Date("2026-09-30T15:00:00Z"), photographerId: tm.id, deliverables: { create: { type: "PHOTOS", status: "UPLOADED" } } } });
    const payload = { editorBrief: "Exact debrief  spacing\nPreserve this version.", force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" as const }, nothingToRemove: true };
    const attempt = async (value: unknown) => ({ attemptId: randomUUID(), payloadFingerprint: await uploadAttemptFingerprint(value) });
    await as(shooter);
    const p = await job("Delayed receipt fixture"); const id = await attempt(payload);
    park = { projectId: p.id, arrived: door(), release: door() };
    const running = a.finalizeUpload(p.id, { ...payload, ...id });
    await park.arrived.wait;
    const core = await a.readUploadAttempt(p.id, id.attemptId, id.payloadFingerprint);
    c.ok("post-core still-running action proves exact saved request but holds another submit", core.state === "saved" && !core.terminal && core.phase === "core_saved" && (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).editorBrief === payload.editorBrief);
    const replay = await a.finalizeUpload(p.id, { ...payload, ...id });
    c.ok("same exact attempt cannot replay core or remaining handoff while original is running", replay.attemptPending === true && await prisma.auditLog.count({ where: { id: uploadAttemptRowId(id.attemptId) } }) === 1);
    park.release.open(); park = null; const result = await running;
    const complete = await a.readUploadAttempt(p.id, id.attemptId, id.payloadFingerprint);
    c.ok("lost completed response can read exact terminal saved attempt without repeating mutation", result.attemptTerminal === true && complete.state === "saved" && complete.terminal && complete.phase === "complete");
    const rawReceipt = await prisma.auditLog.findUniqueOrThrow({ where: { id: uploadAttemptRowId(id.attemptId) } });
    c.ok("receipt/mirror contract stores opaque identity hashes and stamps, never debrief or source body", !rawReceipt.detail.includes("Exact debrief") && !rawReceipt.detail.includes("Preserve this") && parseUploadCommitReceipt(rawReceipt.detail)?.payloadFingerprint === id.payloadFingerprint);
    const absent = await a.readUploadAttempt(p.id, randomUUID(), id.payloadFingerprint);
    c.ok("an old whole-upload stamp cannot confirm a missing exact resubmit receipt", absent.state === "unknown");
    const mismatched = await a.readUploadAttempt(p.id, id.attemptId, "a".repeat(64));
    c.ok("mismatched fingerprint never proves that request", mismatched.state === "unknown");
    const bad = await a.finalizeUpload(p.id, { ...payload, ...(await attempt(payload)), editorBrief: "Tampered body" });
    c.ok("server rejects invalid exact payload before core mutation", !!bad.blocked && (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).editorBrief === payload.editorBrief);
    let invalid = false; try { await a.readUploadAttempt(p.id, "not-a-uuid", id.payloadFingerprint); } catch { invalid = true; }
    c.ok("receipt reads reject invalid opaque IDs", invalid);
    for (const [label, u, actingAs] of [["unassigned photographer", other], ["editor", editor], ["owner preview", owner, shooter.id]] as const) {
      await as(u, actingAs); let denied = 0;
      for (const read of [() => a.readUploadAttempt(p.id, id.attemptId, id.payloadFingerprint), () => a.readUploadSquareFeet(p.id, id.attemptId, id.payloadFingerprint), () => a.finalizeUpload(p.id, { ...payload, ...id })]) { try { await read(); } catch { denied++; } }
      c.ok(`${label} cannot read/replay upload recovery`, denied === 3);
    }
    await as(shooter); await prisma.project.update({ where: { id: p.id }, data: { photographerId: otherTm.id } });
    let reassigned = false; try { await a.readUploadAttempt(p.id, id.attemptId, id.payloadFingerprint); } catch { reassigned = true; }
    c.ok("receipt guard rechecks current assignment rather than old submit identity", reassigned);
    await prisma.project.update({ where: { id: p.id }, data: { photographerId: tm.id } });
    const officePayload = { ...payload, editorBrief: "Office exact correction", baseHash: complete.state === "saved" ? complete.baseHash : "" };
    await as(owner); const officeId = await attempt(officePayload); const officeResult = await a.finalizeUpload(p.id, { ...officePayload, ...officeId });
    const officeReceipt = await a.readUploadAttempt(p.id, officeId.attemptId, officeId.payloadFingerprint);
    c.ok("signed office correction receives its own exact receipt without transferring author identity", officeResult.attemptTerminal === true && officeReceipt.state === "saved" && officeReceipt.terminal);
    await as(shooter); c.ok("one actor cannot adopt another actor's known receipt", (await a.readUploadAttempt(p.id, officeId.attemptId, officeId.payloadFingerprint)).state === "unknown");
    const later = await a.readUploadAttempt(p.id, id.attemptId, id.payloadFingerprint);
    c.ok("a later edit is reported while original receipt keeps its own base for forced-conflict gate", later.state === "saved" && later.currentChanged && later.baseHash === (core.state === "saved" ? core.baseHash : ""));
    const stalePayload = { ...payload, editorBrief: "My stale correction", baseHash: later.state === "saved" ? later.baseHash : "" }; const stale = await a.finalizeUpload(p.id, { ...stalePayload, ...(await attempt(stalePayload)) });
    c.ok("existing explicit conflict choice remains required after recovery of older attempt", !!stale.conflict && (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).editorBrief === "Office exact correction");
    const f = await job("Post-core failed fixture"); lateFail = f.id; const fi = await attempt(payload); let failed = false;
    try { await a.finalizeUpload(f.id, { ...payload, ...fi }); } catch { failed = true; }
    const ended = await a.readUploadAttempt(f.id, fi.attemptId, fi.payloadFingerprint);
    c.ok("post-core throw preserves saved answers with ended terminal status, not false notification failure", failed && ended.state === "saved" && ended.terminal && ended.phase === "ended");
    const t = await job("Lost terminal marker fixture"); const ti = await attempt(payload); terminalFail = uploadAttemptRowId(ti.attemptId);
    const tr = await a.finalizeUpload(t.id, { ...payload, ...ti }); const held = await a.readUploadAttempt(t.id, ti.attemptId, ti.payloadFingerprint);
    c.ok("normal return whose terminal write failed requires held reconciliation identity", tr.attemptTerminal === false && held.state === "saved" && !held.terminal); terminalFail = null;
    const r = await job("Concurrent exact core fixture"); const ri = await attempt(payload); barrier = { rowId: uploadAttemptRowId(ri.attemptId), count: 0, release: door() };
    const races = await Promise.allSettled([a.finalizeUpload(r.id, { ...payload, ...ri }), a.finalizeUpload(r.id, { ...payload, ...ri })]); barrier = null;
    c.ok("concurrent identical attempts commit one core/receipt and only winner runs remaining effects", races.filter((x) => x.status === "fulfilled").length === 1 && await prisma.auditLog.count({ where: { id: uploadAttemptRowId(ri.attemptId) } }) === 1 && await prisma.activity.count({ where: { projectId: r.id, body: "Photographer completed upload. Editor brief is ready for the editors." } }) === 1);
    const size = await attempt({ squareFeet: 2500 });
    const sr = await a.setProjectSquareFeet(r.id, 2500, size); const sq = await a.readUploadSquareFeet(r.id, size.attemptId, size.payloadFingerprint);
    c.ok("size write has exact atomic saved receipt and terminal readback", sr.ok && sr.terminal === true && sq.state === "saved" && sq.terminal && sq.squareFeet === 2500);
    const sizeReplay = await a.setProjectSquareFeet(r.id, 2500, size);
    c.ok("same size attempt cannot replay a delayed/lost response", !sizeReplay.ok && sizeReplay.pending === true);
    const si = await attempt({ squareFeet: 3200 }); terminalFail = `upload-size:${si.attemptId}`;
    const unfinished = await a.setProjectSquareFeet(r.id, 3200, si); const su = await a.readUploadSquareFeet(r.id, si.attemptId, si.payloadFingerprint);
    c.ok("fresh size value alone cannot release a nonterminal write hold", unfinished.ok && unfinished.terminal === false && su.state === "saved" && !su.terminal && su.squareFeet === 3200); terminalFail = null;
    c.ok("unknown size identity never treats the current value as proof of old request completion", (await a.readUploadSquareFeet(r.id, randomUUID(), si.payloadFingerprint)).state === "unknown");
    const delayedSize = await attempt({ squareFeet: 4100 }); sizePark = { projectId: r.id, arrived: door(), release: door() };
    const sizeRunning = a.setProjectSquareFeet(r.id, 4100, delayedSize); await sizePark.arrived.wait;
    const beforeSize = await a.readUploadSquareFeet(r.id, delayedSize.attemptId, delayedSize.payloadFingerprint);
    c.ok("delayed lost size request stays unknown before its late write and cannot be released by current-value read", beforeSize.state === "unknown" && (await prisma.project.findUniqueOrThrow({ where: { id: r.id } })).squareFeet === 3200);
    sizePark.release.open(); sizePark = null; await sizeRunning;
    const afterSize = await a.readUploadSquareFeet(r.id, delayedSize.attemptId, delayedSize.payloadFingerprint);
    c.ok("size recovery releases only after that exact delayed request has committed and ended", afterSize.state === "saved" && afterSize.terminal && afterSize.squareFeet === 4100);
    c.ok("manual editor Start/pay/client sends remain untouched by these guarded recovery checks", await prisma.editorWorkItem.count() === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && fence.faked.length === 0);
    db.evidence(); console.log("Limits: signed isolated server actions and real PostgreSQL core race; no normal browser, phone/raw upload, provider handoff or production test.");
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
