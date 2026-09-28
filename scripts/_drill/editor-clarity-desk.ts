// ---------------------------------------------------------------------------
// DRILL: editor-clarity-desk — the name the Sep 28 editor-clarity task gave the
// editor half's drill. It IS c2-editor-desk.ts (the spec's name for it), run on
// port 5942 unless DRILL_PORT says otherwise. One drill, two names: every check
// lives in c2, so the two can never drift apart.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/editor-clarity-desk.ts
// ---------------------------------------------------------------------------
process.env.DRILL_PORT ??= "5942";
// A require, not an import: c2 reads DRILL_PORT when it loads, and an import
// would be hoisted above the line that sets it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./c2-editor-desk");

export {};
