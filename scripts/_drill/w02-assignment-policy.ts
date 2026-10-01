// @drill-run: engine=postgres needs=tools/realpg timeout=180
// W02 policy: intentional no branding requires an exact receipt; returning to
// an earlier editor requires another one even when the intervening editor never
// opened the brief. Real signed actions, disposable PostgreSQL, no providers.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, portFree } from "./_harness";

installNextStubs();
interceptModule((r) => r === "@/lib/notify" || /[\\/]src[\\/]lib[\\/]notify(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (target, key) => key === "notifyInApp" ? async () => undefined : target[key],
}));
const fence = fenceFetch();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!(await portFree(5970))) throw new Error("W02 fixture port 5970 is busy; existing process left untouched");
  const db = await bootDrillDb({ port: 5970, engine: "postgres", pool: 5, env: { AUTH_ENFORCE: "true", APP_SECRET: "w02-policy-fixture-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { outputBriefsFor, readOutputBrief, saveOutputBrief } = await import("@/lib/deliverableOutputs");
    const { assignmentReceiptStates, assignmentSnapshot, assignmentDigest, withEditorAssignmentChange } = await import("@/lib/editorBriefReceipt");
    const { acknowledgeEditorBrief } = await import("@/app/edit/[id]/receipt.actions");
    const { setEditVideoEditor, saveVideoBrief, addToEditorQueue } = await import("@/app/editing/actions");
    const { setTaskAssignee, assignMember, assignTeamMember, setSmartTaskStatus, toggleTaskChecklistItem, dismissTask } = await import("@/app/actions");
    const { execHubTool } = await import("@/lib/hubTools");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { buildEditorPacket } = await import("@/lib/editorPacket");
    const { getShoot } = await import("@/lib/shoot");
    const { shootBriefLines } = await import("@/lib/shootBriefRead");
    const kimTeam = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-w02-policy@example.test", role: "EDITOR" } });
    const johnTeam = await prisma.teamMember.create({ data: { name: "John Mark", email: "john-w02-policy@example.test", role: "EDITOR" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "kim-login-w02-policy@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle TEST", email: "kyle-w02-policy@example.test", role: "ADMIN", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { name: "Owner TEST", email: "owner-w02-policy@example.test", role: "OWNER", status: "ACTIVE" } });
    const client = await prisma.client.create({ data: { name: "W02 Policy TEST", autoDeliveryText: false } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "W02 Policy TEST", status: "SHOT", editorId: kimTeam.id, videoInstructions: "Warm and human." } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Personal Branding Reel", quantity: 2 } });
    const briefJson = JSON.stringify({ version: 1, sections: { purpose: "Show the neighborhood" }, brandAssetVersionId: null });
    const output = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO", briefJson } });
    const pinned = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 2, category: "VIDEO", briefJson, ownerKey: "kim", ownerName: "Kim", ownerSetAt: new Date("2026-01-01T00:00:00Z") } });
    const context = { editorBrief: null, videoInstructions: "Warm and human.", reelScript: null };
    const as = (user: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: user.id, email: user.email, role: user.role, ...(actingAs ? { actingAs } : {}) });
    const view = async (id = output.id) => {
      const briefs = await outputBriefsFor(project.id, { scrub: true });
      const brief = briefs.find((b) => b.outputId === id)!;
      if (!brief) throw new Error("Missing fixture brief");
      const state = (await assignmentReceiptStates(project.id, [brief], context)).get(id)!;
      return { brief, state };
    };
    const count = () => prisma.editorBriefReceipt.count({ where: { outputId: output.id } });
    await as(kim);
    const first = await view();
    c.ok("legacy null is unspecified and retains its original snapshot digest", first.brief.brandChoice === "unspecified" && first.state.digest === assignmentDigest(assignmentSnapshot(first.brief, "kim", context)));
    c.ok("signed Kim receives her existing unspecified assignment", (await acknowledgeEditorBrief(project.id, output.id, first.state.digest)).ok && await count() === 1);
    const oldPinned = await view(pinned.id);
    const legacySnapshot = assignmentSnapshot(oldPinned.brief, "kim", context);
    await prisma.editorBriefReceipt.create({ data: { projectId: project.id, outputId: pinned.id, editorKey: "kim", digest: assignmentDigest(legacySnapshot), snapshotJson: legacySnapshot, actorUserId: kim.id, actorName: "Kim" } });
    const legacy = await view(pinned.id);
    c.ok("pre-policy owner timestamp does not invalidate matching historical receipt", !legacy.state.changedSinceReceipt && !!legacy.state.acceptedAtISO && legacy.state.digest === assignmentDigest(legacySnapshot));

    c.head("Explicit no-brand decision and versioned acknowledgment");
    c.ok("editor cannot choose no-brand for the office", !(await saveVideoBrief(project.id, output.id, {}, 1, null, "none")).ok);
    await as(admin);
    const none = await saveVideoBrief(project.id, output.id, { purpose: null }, 1, null, "none");
    const noBrand = await view();
    c.ok("office choice saves an explicit no-brand brief version", none.ok && none.version === 2 && noBrand.brief.brandChoice === "none" && noBrand.state.intentionalNoBrand === true && noBrand.state.changedSinceReceipt);
    const packet = await buildEditorPacket(project.id);
    c.ok("new agency packet names intentional-none instead of missing choice", packet?.manifest.videos.find((v) => v.outputId === output.id)?.brandChoice?.includes("Intentionally no logo") === true);
    const shoot = await getShoot(project.id);
    c.ok("intentional-none with no own sections remains on shoot and its read receipt", !!shoot && shoot.outputBriefs.some((o) => o.outputId === output.id && o.brandChoice === "none") && shootBriefLines(shoot, []).some((line) => line.key === `output:${output.id}:asset` && line.value.includes("Intentionally no logo")));
    await as(kim);
    c.ok("old page cannot acknowledge the new no-brand choice", !(await acknowledgeEditorBrief(project.id, output.id, first.state.digest)).ok && await count() === 1);
    const receipt = await acknowledgeEditorBrief(project.id, output.id, noBrand.state.digest);
    const noneReceipt = await prisma.editorBriefReceipt.findFirst({ where: { outputId: output.id, digest: noBrand.state.digest } });
    c.ok("explicit receipt records and names intentional no-brand", receipt.ok && receipt.message.includes("intentional") && noneReceipt?.snapshotJson.includes('"brandChoice":"none"') === true && await count() === 2);
    c.ok("same exact no-brand acknowledgment is idempotent", (await acknowledgeEditorBrief(project.id, output.id, noBrand.state.digest)).ok && await count() === 2);
    await as(admin);
    c.ok("older brief caller preserves explicit none when changing words", (await saveVideoBrief(project.id, output.id, { purpose: "Show the park" }, 2)).ok && (await view()).brief.brandChoice === "none");
    const asset = await prisma.clientAsset.create({ data: { clientId: client.id, name: "Current logo", type: "LOGO" } });
    const assetVersion = await prisma.clientAssetVersion.create({ data: { assetId: asset.id, versionNo: 1, source: "manual", fileRef: "https://example.test/logo.png", fileName: "logo.png" } });
    await prisma.clientAsset.update({ where: { id: asset.id }, data: { activeVersionId: assetVersion.id } });
    const assetSave = await saveVideoBrief(project.id, output.id, {}, 3, assetVersion.id);
    const assetBrief = await view();
    c.ok("none to exact asset changes the receipt without erasing none history", assetSave.ok && assetBrief.brief.brandChoice === "asset" && assetBrief.brief.brandAsset?.versionId === assetVersion.id && assetBrief.state.digest !== noBrand.state.digest && !!noneReceipt);
    c.ok("contradictory asset plus intentional-none is refused", !(await saveOutputBrief({ outputId: output.id, projectId: project.id, sections: {}, expectedVersion: 4, brandAssetVersionId: assetVersion.id, brandChoice: "none", actor: "TEST" })).ok);
    const backToNone = await saveVideoBrief(project.id, output.id, {}, 4, null, "none");
    c.ok("asset to none is another attributed brief version", backToNone.ok && backToNone.version === 5 && (await view()).brief.brandChoice === "none");
    await as(kim);
    const beforeMove = (await view()).state;
    await acknowledgeEditorBrief(project.id, output.id, beforeMove.digest);
    const futureAcceptedAt = new Date(Date.now() + 60_000);
    await prisma.editorBriefReceipt.updateMany({ where: { outputId: output.id, digest: beforeMove.digest }, data: { acceptedAt: futureAcceptedAt } });
    c.ok("legacy receipt survives a clock-ahead timestamp before any assignment change", !(await view()).state.changedSinceReceipt && (await view()).state.digest === beforeMove.digest);
    const baselineCount = await count();

    c.head("Actual assignment doors and return to earlier editor");
    await as(admin);
    await setEditVideoEditor(project.id, "john");
    await setEditVideoEditor(project.id, "kim");
    const returned = (await view()).state;
    c.ok("Kim to John to Kim requires a fresh receipt without John's acknowledgment", returned.editorKey === "kim" && returned.changedSinceReceipt && returned.digest !== beforeMove.digest && await count() === baselineCount);
    c.ok("actual return generation exceeds the clock-ahead legacy receipt", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: output.id } })).ownerSetAt!.getTime() > futureAcceptedAt.getTime());
    c.ok("explicit output owner and historical receipt survive unrelated job reassignments", (await view(pinned.id)).state.digest === legacy.state.digest && !(await view(pinned.id)).state.changedSinceReceipt);
    await as(kim);
    c.ok("returning editor's stale page cannot acknowledge", !(await acknowledgeEditorBrief(project.id, output.id, beforeMove.digest)).ok && await count() === baselineCount);
    c.ok("returning editor records a new immutable receipt", (await acknowledgeEditorBrief(project.id, output.id, returned.digest)).ok && await count() === baselineCount + 1);
    c.ok("exact current receipt is shown despite older clock-ahead evidence", !(await view()).state.changedSinceReceipt && (await view()).state.digest === returned.digest);
    await as(admin);
    const assignedAt = (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: output.id } })).ownerSetAt;
    await setEditVideoEditor(project.id, "kim");
    c.ok("same saved editor does not advance generation or invalidate receipt", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: output.id } })).ownerSetAt?.getTime() === assignedAt?.getTime() && !(await view()).state.changedSinceReceipt);
    await setEditVideoEditor(project.id, "");
    c.ok("explicit unassignment removes the receipt action's owner", !(await view()).state.editorKey);
    await setEditVideoEditor(project.id, "kim");
    c.ok("unassign then return also asks for a fresh receipt", (await view()).state.changedSinceReceipt && (await view()).state.digest !== returned.digest);

    const card = await prisma.smartTask.create({ data: { projectId: project.id, taskType: "edit_video", assignedKey: "kim", assignedManually: true, title: "W02 edit", status: "OPEN", dedupeKey: `edit-video-${project.id}` } });
    await as(kim);
    const taskBefore = (await view()).state;
    await acknowledgeEditorBrief(project.id, output.id, taskBefore.digest);
    await as(admin);
    await setTaskAssignee(card.id, "john");
    await setTaskAssignee(card.id, "kim");
    c.ok("task-card reassignment back requires a fresh receipt", (await view()).state.digest !== taskBefore.digest && (await view()).state.changedSinceReceipt);
    const beforeRefresh = (await view()).state.digest;
    await withEditorAssignmentChange(project.id, (tx) => tx.smartTask.update({ where: { id: card.id }, data: { summary: "A routine refresh", dueAt: new Date("2030-01-01T17:00:00Z") } }));
    c.ok("ordinary card refresh does not change the ownership generation", (await view()).state.digest === beforeRefresh);
    await assignMember(project.id, "editor", johnTeam.id);
    await assignMember(project.id, "editor", kimTeam.id);
    c.ok("project-page assignment back changes generation through the same effective owner rule", (await view()).state.digest !== beforeRefresh);
    await setTaskAssignee(card.id, "john");
    const beforeComplete = (await view()).state;
    await setSmartTaskStatus(card.id, "COMPLETED");
    const completedState = (await view()).state;
    c.ok("signed task completion tracks effective owner falling back to the project", beforeComplete.editorKey === "john" && completedState.editorKey === "kim" && completedState.digest !== beforeComplete.digest);
    await setSmartTaskStatus(card.id, "OPEN");
    const reopenedState = (await view()).state;
    c.ok("signed task reopening records fresh generation for its saved editor", reopenedState.editorKey === "john" && reopenedState.digest !== beforeComplete.digest);
    await prisma.smartTask.update({ where: { id: card.id }, data: { checklist: JSON.stringify([{ label: "Finish the edit", done: false }]) } });
    const checked = await toggleTaskChecklistItem(card.id, 0);
    const checkedState = (await view()).state;
    const unchecked = await toggleTaskChecklistItem(card.id, 0);
    const uncheckedState = (await view()).state;
    c.ok("signed last-check and uncheck track fallback then return", checked.completed && checkedState.editorKey === "kim" && !unchecked.completed && uncheckedState.editorKey === "john" && uncheckedState.digest !== reopenedState.digest);
    const dismissed = await dismissTask(card.id, "not needed");
    const dismissedRow = await prisma.smartTask.findUniqueOrThrow({ where: { id: card.id } });
    c.ok("signed dismissal tracks fallback without claiming task completion", dismissed.ok && (await view()).state.editorKey === "kim" && (await view()).state.digest !== checkedState.digest && dismissedRow.status === "CANCELLED" && dismissedRow.completedAt === null);

    c.head("Ask the Hub assignment, completion and role boundaries");
    await setSmartTaskStatus(card.id, "OPEN");
    const hub = async (name: string, input: Record<string, unknown>) => {
      const user = await getCurrentUser();
      if (!user) throw new Error("Fixture signed identity missing");
      return execHubTool(name, input, { role: user.role, impersonating: user.impersonating, who: user.name });
    };
    const hubBefore = (await view()).state.digest;
    const hubAssigned = await hub("assign_task", { task: "W02 edit", person: "kim" }) as { done?: boolean };
    const hubReturned = await hub("assign_task", { task: "W02 edit", person: "john" }) as { done?: boolean };
    c.ok("Ask the Hub return records a new exact assignment generation", hubAssigned.done === true && hubReturned.done === true && (await view()).state.editorKey === "john" && (await view()).state.digest !== hubBefore);
    const beforeHubComplete = (await view()).state.digest;
    const hubCompleted = await hub("complete_task", { task: "W02 edit" }) as { done?: boolean };
    const hubCompleteState = (await view()).state;
    const hubReopened = await hub("complete_task", { task: "W02 edit", reopen: true }) as { done?: boolean };
    c.ok("Ask the Hub complete and reopen preserve fallback generation", hubCompleted.done === true && hubCompleteState.editorKey === "kim" && hubReopened.done === true && (await view()).state.editorKey === "john" && (await view()).state.digest !== beforeHubComplete);
    const beforeRefusal = (await view()).state.digest;
    await as(kim);
    const refusedAssign = await hub("assign_task", { task: "W02 edit", person: "kim" }) as { error?: string };
    const refusedComplete = await hub("complete_task", { task: "W02 edit" }) as { error?: string };
    c.ok("Ask the Hub still refuses editor assignment and completion writes", !!refusedAssign.error && !!refusedComplete.error && (await view()).state.digest === beforeRefusal);
    await as(owner, admin.id);
    const previewAssign = await hub("assign_task", { task: "W02 edit", person: "kim" }) as { error?: string };
    const previewComplete = await hub("complete_task", { task: "W02 edit" }) as { error?: string };
    const previewDismiss = await dismissTask(card.id, "not needed");
    const previewStatus = await setSmartTaskStatus(card.id, "COMPLETED").then(() => false, () => true);
    const previewChecklist = await toggleTaskChecklistItem(card.id, 0).then(() => false, () => true);
    c.ok("read-only preview refuses every affected fallback write door", !!previewAssign.error && !!previewComplete.error && !previewDismiss.ok && previewStatus && previewChecklist && (await view()).state.digest === beforeRefusal);
    await as(admin);
    await setSmartTaskStatus(card.id, "COMPLETED");
    const beforeDirect = (await view()).state.digest;
    await assignTeamMember(project.id, "editorId", johnTeam.id);
    await assignTeamMember(project.id, "editorId", kimTeam.id);
    c.ok("direct project assignment with no live card also tracks the return", (await view()).state.digest !== beforeDirect);
    const beforeQueue = (await view()).state.digest;
    const queueJohn = await addToEditorQueue(project.id, "john");
    const queueKim = await addToEditorQueue(project.id, "kim");
    c.ok("fresh queue-add Kim to John to Kim records new receipt generation", queueJohn.ok && queueKim.ok && (await view()).state.editorKey === "kim" && (await view()).state.digest !== beforeQueue);
    await setSmartTaskStatus(card.id, "COMPLETED");
    // A prior-cut queue-add routes revision work, and its saved project editor
    // still owns otherwise unassigned outputs when no live edit card remains.
    await prisma.project.update({ where: { id: project.id }, data: { statusEvidence: JSON.stringify({ present: ["Video"] }) } });
    const beforeRevisionQueue = (await view()).state.digest;
    const revisionJohn = await addToEditorQueue(project.id, "john");
    const revisionKim = await addToEditorQueue(project.id, "kim");
    c.ok("prior-cut queue-add fallback return also changes generation", revisionJohn.ok && revisionKim.ok && (await view()).state.editorKey === "kim" && (await view()).state.digest !== beforeRevisionQueue);

    c.head("Reassignment wins a real PostgreSQL race against stale acknowledgment");
    await as(kim);
    const stale = (await view()).state.digest;
    const countBeforeRace = await count();
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const waitsBefore = db.lockWaits();
    let observedWait = false;
    const raced = await db.backendsDuring(async () => {
      const moved = withEditorAssignmentChange(project.id, async (tx) => {
        await tx.project.update({ where: { id: project.id }, data: { editorId: johnTeam.id } });
        locked();
        await gate;
      });
      await isLocked;
      const lateReceipt = acknowledgeEditorBrief(project.id, output.id, stale);
      try {
        for (const until = Date.now() + 2500; Date.now() < until;) {
          if (await db.waitingLocks() > 0) { observedWait = true; break; }
          await pause(20);
        }
      } finally { release(); }
      await moved;
      return lateReceipt;
    });
    // pg_locks is direct evidence. log_lock_waits only emits after 50ms, so
    // releasing the gate as soon as a wait is observed need not produce a log.
    c.ok("independent PostgreSQL backends observed the assignment lock", observedWait && raced.distinctBackends >= 2, `${raced.distinctBackends} backends, pg_locks wait=${observedWait}, long waits logged=${db.lockWaits() - waitsBefore}`);
    c.ok("stale signed acknowledgment cannot commit after reassignment wins", !raced.result.ok && await count() === countBeforeRace && (await view()).state.editorKey === "john");
    await as(owner, kim.id);
    c.ok("owner preview still cannot write an editor receipt", !(await acknowledgeEditorBrief(project.id, output.id, (await view()).state.digest)).ok && await count() === countBeforeRace);
    c.ok("policy changes never start, pause or erase editor work", await prisma.editorWorkItem.count() === 0 && await prisma.editorWorkEvent.count() === 0);
    c.ok("original receipt and exact no-brand snapshot remain unchanged", (await prisma.editorBriefReceipt.findFirst({ where: { outputId: output.id, digest: first.state.digest } }))?.snapshotJson === assignmentSnapshot(first.brief, "kim", context) && (await prisma.editorBriefReceipt.findUnique({ where: { id: noneReceipt!.id } }))?.snapshotJson === noneReceipt?.snapshotJson);
    c.ok("versioned choice is explicit in stored JSON and no provider escaped", readOutputBrief((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: output.id } })).briefJson)?.brandChoice === "none" && fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
