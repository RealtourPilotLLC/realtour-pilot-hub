// U5: ordinary reminder fields, draft truth, template preview and policy-only saves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// The actual panel is server-rendered for its first paint. Browser interaction
// and visual acceptance remain separate; no provider or send action is called.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import {
  currentPolicyValidation, parsePolicyDraft, policyEditorReducer, policyNumberInput,
  previewPolicyTemplate, updatePolicyField, type PolicyEditorState,
} from "../../src/lib/reminderPolicyEditor";

installNextStubs();

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5926), env: { AUTH_ENFORCE: "true", APP_SECRET: "u5-policy-isolated-secret" } });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { REMINDER_DEFAULTS, validateReminderPolicy } = await import("@/lib/programReminders");
    const { saveReminderPolicy, loadRemindersPanelState, validateReminderPolicyAction } = await import("@/app/settings/reminderActions");
    const { setSession } = await import("@/lib/auth/session");
    const { RemindersPanel } = await import("@/components/settings/RemindersPanel");
    const owner = await prisma.appUser.create({ data: { name: "Policy owner", email: "owner-policy@example.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Policy admin", email: "admin-policy@example.test", role: "ADMIN", status: "ACTIVE" } });
    const signIn = (user: typeof owner) => setSession({ uid: user.id, role: user.role, email: user.email });
    await signIn(owner);
    const unknown = { nested: [null, false, { note: "exact future data", zero: 0 }], empty: "", large: "9007199254740993" };
    const original = JSON.stringify({
      ...REMINDER_DEFAULTS,
      futurePolicy: unknown,
      businessHours: { ...REMINDER_DEFAULTS.businessHours, futureHours: unknown },
      scriptApproval: { ...REMINDER_DEFAULTS.scriptApproval, futureApproval: unknown },
      templates: { ...REMINDER_DEFAULTS.templates, REVIEW_WORK: "reminder.review_work.v1" },
    }, null, 2);
    let edited = updatePolicyField(original, ["followUpAfterBusinessDays"], 4);
    edited = updatePolicyField(edited, ["scriptApproval", "clientLeadHours"], 60);
    edited = updatePolicyField(edited, ["businessHours", "start"], "09:30");
    edited = updatePolicyField(edited, ["templates", "REVIEW_WORK"], "reminder.review_work.v2");
    const parsed = parsePolicyDraft(edited).policy!;
    c.ok("ordinary fields preserve all unknown root and nested values", JSON.stringify(parsed.futurePolicy) === JSON.stringify(unknown)
      && JSON.stringify((parsed.businessHours as Record<string, unknown>).futureHours) === JSON.stringify(unknown)
      && JSON.stringify((parsed.scriptApproval as Record<string, unknown>).futureApproval) === JSON.stringify(unknown));
    c.ok("unrelated saved policy values and existing gates remain unchanged", parsed.testClientsOnly === true && parsed.staffFollowUpsForRealClients === false
      && parsed.includePastMonths === false && parsed.planningDeadlineDayOfPrevMonth === REMINDER_DEFAULTS.planningDeadlineDayOfPrevMonth
      && parsed.quotedPlanningDeadlineDayOfMonth === null && (parsed.templates as Record<string, unknown>).BOOK_CALL === REMINDER_DEFAULTS.templates.BOOK_CALL);
    c.ok("malformed raw JSON remains an explicit error", parsePolicyDraft("{bad draft").policy === null && parsePolicyDraft("[]").policy === null);
    let malformedParentRefused = false;
    try { updatePolicyField('{"scriptApproval":["keep me"]}', ["scriptApproval", "clientLeadHours"], 60); } catch { malformedParentRefused = true; }
    c.ok("ordinary edit refuses to erase a malformed nested value", malformedParentRefused);
    c.ok("blank required numbers stay invalid; blank optional deadline is explicitly null", policyNumberInput("") === "" && policyNumberInput("", true) === null
      && !validateReminderPolicy({ ...REMINDER_DEFAULTS, followUpAfterBusinessDays: policyNumberInput("") }).ok);
    const validated = await validateReminderPolicyAction(edited);
    c.ok("server validates the actual edited policy and reports preserved unknown keys", validated.ok && validated.warnings.some((warning) => warning.includes("futurePolicy")));
    c.ok("invalid field range and contradictory script timing are refused", !(await validateReminderPolicyAction(updatePolicyField(edited, ["maxAttemptsPerAction"], 999))).ok
      && !(await validateReminderPolicyAction(updatePolicyField(edited, ["scriptApproval", "deadlineHoursBefore"], 70))).ok);

    let state: PolicyEditorState = { json: original, savedJson: original, validation: { json: original, result: { ok: true, errors: [], warnings: [] } }, feedback: null };
    state = policyEditorReducer(state, { type: "edit", json: edited });
    c.ok("typing immediately removes previous valid feedback and marks the draft dirty", currentPolicyValidation(state) === null && state.json !== state.savedJson && state.feedback === null);
    state = policyEditorReducer(state, { type: "validation", json: original, result: { ok: true, errors: [], warnings: [] } });
    c.ok("late validation never describes a newer draft as valid", currentPolicyValidation(state) === null);
    state = policyEditorReducer(state, { type: "saved", json: original, ok: true, message: "Saved the submitted draft." });
    c.ok("typing during save keeps the new draft unsaved and unvalidated", state.json === edited && state.savedJson === original && currentPolicyValidation(state) === null);
    state = policyEditorReducer(state, { type: "saved", json: edited, ok: false, message: "Save failed." });
    c.ok("failed save preserves both the draft and previous saved snapshot", state.json === edited && state.savedJson === original && state.feedback?.ok === false);
    state = policyEditorReducer(state, { type: "saved", json: edited, ok: true, message: "Saved." });
    c.ok("successful retry clears dirty state for exactly the saved draft", state.json === state.savedJson && currentPolicyValidation(state)?.ok === true);

    const preview = previewPolicyTemplate(parsed, "BOOK_CALL");
    c.ok("template preview uses sample details without a real booking link or fabricated deadline", preview.body.includes("Hi Alex") && preview.body.includes("[strategy call link]")
      && !preview.body.includes("planned by") && !preview.body.includes("https://"));
    const retired = previewPolicyTemplate({ ...parsed, templates: { ...REMINDER_DEFAULTS.templates, BOOK_SESSION: "reminder.book_session.v1" } }, "BOOK_SESSION");
    c.ok("preview resolves retired templates exactly as a send would", retired.id === "reminder.book_session.v2");
    const withDeadline = previewPolicyTemplate({ ...parsed, quotedPlanningDeadlineDayOfMonth: 22 }, "BOOK_CALL");
    c.ok("only the deliberate client deadline appears in the sample", withDeadline.body.includes("planned by October 22"));

    const firstSave = await saveReminderPolicy(edited);
    let stored = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "reminders" } });
    c.ok("first owner save creates policy with automation OFF and no activation receipt", firstSave.ok && !stored.enabled && stored.enabledBy === null && stored.enabledAt === null);
    const roundTrip = JSON.parse(stored.configJson!);
    c.ok("saved and reloaded policy retains unknown nested data", JSON.stringify(roundTrip.futurePolicy) === JSON.stringify(unknown)
      && JSON.stringify(roundTrip.businessHours.futureHours) === JSON.stringify(unknown)
      && JSON.stringify(roundTrip.scriptApproval.futureApproval) === JSON.stringify(unknown)
      && JSON.stringify(JSON.parse((await loadRemindersPanelState()).policyJson).futurePolicy) === JSON.stringify(unknown));
    // Fixture state only: never evaluate or send. Preserve both kinds of switch
    // receipt, proving a policy save does not masquerade as activation.
    const activatedAt = new Date("2026-01-05T15:00:00Z");
    const disabledAt = new Date("2026-01-06T15:00:00Z");
    await prisma.programAutomation.update({ where: { key: "reminders" }, data: { enabled: true, enabledBy: "previous owner", enabledAt: activatedAt, disabledBy: "earlier stop", disabledAt } });
    await saveReminderPolicy(updatePolicyField(edited, ["maxSendsPerRun"], 12));
    stored = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "reminders" } });
    c.ok("policy save preserves an ON switch and all prior activation/disable receipts", stored.enabled && stored.enabledBy === "previous owner" && stored.enabledAt?.getTime() === activatedAt.getTime()
      && stored.disabledBy === "earlier stop" && stored.disabledAt?.getTime() === disabledAt.getTime());
    await prisma.programAutomation.update({ where: { key: "reminders" }, data: { enabled: false, disabledBy: "stop before save", disabledAt } });
    await saveReminderPolicy(edited);
    stored = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "reminders" } });
    c.ok("saving after a disable never re-enables the switch or rewrites its receipt", !stored.enabled && stored.disabledBy === "stop before save" && stored.disabledAt?.getTime() === disabledAt.getTime());

    const beforeRefusal = stored.configJson;
    await signIn(admin);
    const denied = await saveReminderPolicy(updatePolicyField(edited, ["maxSendsPerRun"], 14));
    c.ok("signed admin cannot save owner-only policy", !denied.ok && (await prisma.programAutomation.findUniqueOrThrow({ where: { key: "reminders" } })).configJson === beforeRefusal);
    await setSession({ uid: owner.id, role: owner.role, email: owner.email, actingAs: admin.id });
    c.ok("owner preview cannot mutate policy", !(await saveReminderPolicy(edited)).ok);
    await signIn(owner);
    c.ok("invalid save does not replace the existing policy", !(await saveReminderPolicy("{unfinished")).ok && (await prisma.programAutomation.findUniqueOrThrow({ where: { key: "reminders" } })).configJson === beforeRefusal);
    const savedUpsert = prisma.programAutomation.upsert;
    prisma.programAutomation.upsert = (async () => { throw new Error("Isolated save unavailable"); }) as typeof savedUpsert;
    let failed: Awaited<ReturnType<typeof saveReminderPolicy>>;
    try { failed = await saveReminderPolicy(edited); } finally { prisma.programAutomation.upsert = savedUpsert; }
    c.ok("database save failure is surfaced and a retry succeeds", !failed.ok && failed.message.includes("Isolated save unavailable") && (await saveReminderPolicy(edited)).ok);

    const panelState = await loadRemindersPanelState();
    const html = renderToStaticMarkup(createElement(RemindersPanel, { state: panelState }));
    c.ok("actual panel renders ordinary labeled fields and closed advanced JSON", html.includes("Planning opens") && html.includes('type="number"') && html.includes('for="reminder-policy-json"')
      && /<details[^>]*><summary[^>]*>Advanced policy/.test(html) && !/<details[^>]*open[^>]*><summary[^>]*>Advanced policy/.test(html));
    c.ok("actual panel states saved-policy dry run and separates activation", html.includes("Uses the saved policy and current rollout") && html.includes("Saving keeps the automation switch as it is") && html.includes("Saved policy"));
    const malformedJson = JSON.stringify({ ...REMINDER_DEFAULTS, scriptApproval: { clientLeadHours: { future: true } } });
    const malformedHtml = renderToStaticMarkup(createElement(RemindersPanel, { state: { ...panelState, policyJson: malformedJson, validation: { ok: false, errors: ["Invalid hours"], warnings: [] } } }));
    c.ok("advanced draft with malformed script values remains editable instead of crashing", malformedHtml.includes("Validate the script reminder hours") && malformedHtml.includes("Invalid hours") && malformedHtml.includes("future"));
    c.ok("no messages, reminders, or provider calls were produced", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programReminder.count() === 0);
    c.summary();
  } finally { fence.restore(); await drill.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
