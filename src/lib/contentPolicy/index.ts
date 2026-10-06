// ---------------------------------------------------------------------------
// src/lib/contentPolicy — the Content Program's versioned generation policy
// (spec §27 "Canonical strategy, topic, and scripting configuration").
//
// WHAT THIS LAYER IS
//   One policy object with a version + content hash (policy.ts); the Arielle
//   strategy template with a structure-version-aware parser, renderer and
//   presence validator (strategyTemplate.ts); the canonical script type with a
//   faithful archive reader, renderer, spoken-time estimator and NEW-script
//   validator (scriptFormat.ts); the topic type, Arielle's bank presentation,
//   bank validator and the pure next-session ranking (topicBank.ts); the §6
//   guided-interview plan as data, with the CP-08 sufficiency rule and its
//   targeted gap questions (interview.ts); and prompt builders that return
//   strings + JSON schemas, with the script's per-part word budgets
//   (prompts.ts).
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - No database reads or writes. Nothing here imports prisma. The pipeline /
//     schema builder wires these pure functions to rows.
//   - No AI provider calls. prompts.ts builds text and schemas only.
//   - No duration overrides. The 30–50 s target (Jordan, Oct 6 2026: "video
//     length varies for all clients. They should be between 30-50 seconds
//     long, sometimes a minute, but I don't think that's important to note
//     anywhere" — superseding the Sep 16 20–30 s ruling) has no per-client,
//     per-session or per-script escape hatch anywhere in this layer, and no
//     length is carried into a client's style notes. The length check is a
//     soft warning that only fires under 25 s or over 65 s.
//   - No "fixing" of historical scripts. parseDeliveredScript reads four-point
//     archive scripts as four points; validateNewScript is for NEW generation.
//   - No other client's context. assertClientScoped refuses mixed inputs on
//     every prompt path: the transcript path checks the Topic, the
//     written-answers path checks ScriptGeneratorInput.topic.clientId, and the
//     caption prompt checks CanonicalScript.clientId (null = unscoped import;
//     the wiring layer sets it).
//
// EVIDENCE: scratchpad/portal-references/REFERENCE_MANIFEST.md (Sep 16 2026) —
// GPT instructions verbatim (§2.1), consolidated rules (§2.2), template (§3),
// measured script format (§4), topic presentation (§5), conflicts (§7),
// Jordan's rulings (§9). Proof runs: scratchpad/policy/RESULTS.md.
// ---------------------------------------------------------------------------

export * from "./policy";
export * from "./strategyTemplate";
export * from "./scriptFormat";
export * from "./topicBank";
export * from "./interview";
export * from "./prompts";
