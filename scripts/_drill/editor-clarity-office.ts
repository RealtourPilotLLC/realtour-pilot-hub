// The office half of the editor-clarity build (Sep 28), under the name the
// build order gave it. The drill itself is c1-editor-activity.ts; this only
// gives it its own default port so the two names can run side by side.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/editor-clarity-office.ts
process.env.DRILL_PORT ??= "5941";
// require, not import: an import is hoisted above the line that sets the port.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./c1-editor-activity");
