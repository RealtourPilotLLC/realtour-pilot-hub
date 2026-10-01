// C04 provider-boundary replay. PGlite and a fake Slack response only.
import { bootDrillDb, installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();

async function main() {
  const drill = await bootDrillDb({ port: 5591 });
  const attempts: string[] = [];
  let slackUp = false;
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fence = fenceFetch(async (url, init) => {
    if (url === "https://slack.com/api/chat.postMessage") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string };
      attempts.push(body.channel ?? "?");
      return json(slackUp ? { ok: true } : { ok: false, error: "ratelimited" });
    }
    if (url === "https://slack.com/api/conversations.list") return json({ ok: true, channels: [] });
    if (url === "https://slack.com/api/conversations.open") return json({ ok: false, error: "ratelimited" });
    return null;
  });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { alertBrandChanges, sweepBrandChangeAlerts } = await import("@/lib/brandProfile");
    await saveSecret("slack", "xoxb-drill-not-a-real-token");
    const kim = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-c04@example.com", role: "EDITOR", slackId: "U-KIM" }, select: { id: true } });
    await prisma.appUser.create({ data: { email: "kim-c04@example.com", name: "Kim", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    await prisma.programAutomation.create({ data: { key: "brand_change_alerts", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
    const client = await prisma.client.create({ data: { name: "C04 Provider Client" }, select: { id: true } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "C04 editing", status: "EDITING" }, select: { id: true } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", assignedKey: "kim", projectId: project.id, clientId: client.id, status: "OPEN" } });
    const at = new Date();
    const change = await prisma.clientBrandChange.create({ data: { clientId: client.id, fieldKey: "brandColors", label: "Colors", kind: "SET", toText: "blue", source: "staff", createdAt: at } });
    const first = await alertBrandChanges(client.id, { now: at });
    const failedLegs = await prisma.notificationDelivery.findMany({ where: { teamMemberId: kim.id, kind: "brand_updated", channel: "slack" } });
    c.ok("failed Slack attempt has a durable failed leg", failedLegs.length === 1 && failedLegs[0].status === "failed");
    c.ok("failed Slack does not settle as delivered or bell-only", first.channel === "delivery_failed", first.channel ?? "null");
    await prisma.notification.updateMany({ where: { kind: "brand_updated" }, data: { createdAt: new Date(at.getTime() - 2 * 60_000) } });
    slackUp = true;
    const later = new Date(at.getTime() + 10 * 60_000);
    await sweepBrandChangeAlerts({ now: later });
    const row = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: change.id } });
    const legs = await prisma.notificationDelivery.findMany({ where: { teamMemberId: kim.id, kind: "brand_updated", channel: "slack" }, orderBy: { createdAt: "asc" } });
    c.ok("expired failure retries the same bell and reaches Kim", row.alertChannel === "slack" && legs.length === 2 && legs[1].status === "sent", `${row.alertChannel}/${legs.map((l) => l.status)}`);
    c.ok("one bell and one open confirmation task survive the retry", (await prisma.notification.count({ where: { kind: "brand_updated" } })) === 1 && (await prisma.smartTask.count({ where: { clientId: client.id, dedupeKey: { startsWith: `brand-ack:${client.id}:` }, status: "OPEN" } })) === 1);
    await prisma.clientBrandChange.update({ where: { id: change.id }, data: { alertChannel: "preparing", alertedAt: at } });
    await sweepBrandChangeAlerts({ now: later });
    c.ok("crash after provider acceptance reuses receipt without another DM", attempts.filter((a) => a === "U-KIM").length === 2 && (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: change.id } })).alertChannel === "deduped");

    // A bell committed without a channel leg cannot prove whether Slack
    // accepted the DM before the process died. Do not send it again blindly.
    const unknownClient = await prisma.client.create({ data: { name: "C04 Unknown Client" }, select: { id: true } });
    const unknownProject = await prisma.project.create({ data: { clientId: unknownClient.id, title: "C04 unknown edit", status: "EDITING" }, select: { id: true } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", assignedKey: "kim", projectId: unknownProject.id, clientId: unknownClient.id, status: "OPEN" } });
    await prisma.clientBrandChange.create({ data: { clientId: unknownClient.id, fieldKey: "brandColors", label: "Colors", kind: "SET", toText: "green", source: "staff", createdAt: at } });
    const hour = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
    const key = `brand-updated-${unknownClient.id}-${hour.year}${hour.month}${hour.day}${hour.hour}-0`;
    const unknownBell = await prisma.notification.create({ data: { kind: "brand_updated", title: "Brand updated", href: "/editing", audience: '["EDITOR"]', userKey: "editor:kim", dedupeKey: key, createdAt: new Date(at.getTime() - 2 * 60_000) } });
    await prisma.notificationDelivery.create({ data: { notificationId: unknownBell.id, teamMemberId: kim.id, kind: "brand_updated", channel: "bell", status: "sent" } });
    const attemptsBeforeUnknown = attempts.length;
    const unknown = await alertBrandChanges(unknownClient.id, { now: at });
    c.ok("bell with no provider result is marked unknown for staff, with no resend", unknown.channel === "delivery_unknown" && attempts.length === attemptsBeforeUnknown);

    // Explicit provider refusals can be retried twice; the third is terminal
    // and visible for Kyle rather than a silent endless cron loop.
    slackUp = false;
    const cappedClient = await prisma.client.create({ data: { name: "C04 Capped Client" }, select: { id: true } });
    const cappedProject = await prisma.project.create({ data: { clientId: cappedClient.id, title: "C04 capped edit", status: "EDITING" }, select: { id: true } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", assignedKey: "kim", projectId: cappedProject.id, clientId: cappedClient.id, status: "OPEN" } });
    const cappedChange = await prisma.clientBrandChange.create({ data: { clientId: cappedClient.id, fieldKey: "brandColors", label: "Colors", kind: "SET", toText: "red", source: "staff", createdAt: at } });
    await alertBrandChanges(cappedClient.id, { now: at });
    await prisma.notification.updateMany({ where: { kind: "brand_updated", dedupeKey: { startsWith: `brand-updated-${cappedClient.id}-` } }, data: { createdAt: new Date(at.getTime() - 2 * 60_000) } });
    await sweepBrandChangeAlerts({ now: later });
    await sweepBrandChangeAlerts({ now: new Date(at.getTime() + 20 * 60_000) });
    const capped = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: cappedChange.id } });
    const cappedLegs = await prisma.notificationDelivery.findMany({ where: { kind: "brand_updated", teamMemberId: kim.id, channel: "slack", notificationId: { in: (await prisma.notification.findMany({ where: { dedupeKey: { startsWith: `brand-updated-${cappedClient.id}-` } }, select: { id: true } })).map((n) => n.id) } } });
    c.ok("three explicit provider refusals end as unreached", capped.alertChannel === "delivery_unreached" && cappedLegs.length === 3 && cappedLegs.every((l) => l.status === "failed"), `${capped.alertChannel}/${cappedLegs.length}`);
    const attemptsAtCap = attempts.length;
    await sweepBrandChangeAlerts({ now: new Date(at.getTime() + 30 * 60_000) });
    c.ok("terminal unreached state does not send a fourth DM", attempts.length === attemptsAtCap);

    // Catch-up is keyed to the hour the pending batch was dispatched, not
    // the original edit hour. A retry must not create a second bell/DM key.
    await prisma.programAutomation.update({ where: { key: "brand_change_alerts" }, data: { enabled: false } });
    const catchupClient = await prisma.client.create({ data: { name: "C04 Catchup Client" }, select: { id: true } });
    const catchupProject = await prisma.project.create({ data: { clientId: catchupClient.id, title: "C04 catchup edit", status: "EDITING" }, select: { id: true } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", assignedKey: "kim", projectId: catchupProject.id, clientId: catchupClient.id, status: "OPEN" } });
    const catchupChange = await prisma.clientBrandChange.create({ data: { clientId: catchupClient.id, fieldKey: "brandColors", label: "Colors", kind: "SET", toText: "gold", source: "staff", createdAt: at } });
    const held = await alertBrandChanges(catchupClient.id, { now: at });
    c.ok("alerts-off change stays pending with one confirmation task", held.channel === "pending" && !!held.taskId);
    await prisma.programAutomation.update({ where: { key: "brand_change_alerts" }, data: { enabled: true } });
    const catchupAt = new Date(at.getTime() + 70 * 60_000);
    await sweepBrandChangeAlerts({ now: catchupAt });
    const caught = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: catchupChange.id } });
    const bellBefore = await prisma.notification.findMany({ where: { kind: "brand_updated", dedupeKey: { startsWith: `brand-updated-${catchupClient.id}-` } } });
    c.ok("failed catch-up stays retryable with its dispatch-hour claim", caught.alertChannel === "delivery_failed" && /^\d{10}:/.test(caught.alertClaim ?? "") && bellBefore.length === 1);
    await prisma.notification.update({ where: { id: bellBefore[0].id }, data: { createdAt: new Date(at.getTime() - 2 * 60_000) } });
    slackUp = true;
    await sweepBrandChangeAlerts({ now: new Date(at.getTime() + 80 * 60_000) });
    const bellAfter = await prisma.notification.findMany({ where: { kind: "brand_updated", dedupeKey: { startsWith: `brand-updated-${catchupClient.id}-` } } });
    c.ok("catch-up retry uses the same bell and reaches Kim once", bellAfter.length === 1 && bellAfter[0].id === bellBefore[0].id && (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: catchupChange.id } })).alertChannel === "slack");
    c.ok("no real outbound request crossed the fence", fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
