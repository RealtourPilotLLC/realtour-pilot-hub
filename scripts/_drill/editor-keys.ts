// R04: an unlinked editor must inherit nothing through a display name.
// guards.ts drags next/headers in through getCurrentUser at module load, which
// tsx cannot resolve outside a request. The three functions under test touch
// none of that, so the module is loaded with a stub in front of that import.
import Module from "module";

type Req = { prototype: { require: (id: string) => unknown } };
const M = Module as unknown as Req;
const real = M.prototype.require;
M.prototype.require = function (this: unknown, id: string) {
  if (id === "next/navigation" || id === "next/headers") return {};
  return real.call(this, id);
} as never;

async function main() {
  const { addressableKeys, editorScopeOf, isUnmappedEditor } = await import("@/lib/auth/guards");
  type V = Parameters<typeof addressableKeys>[0];
  const cases: { label: string; u: V; expect: string[] }[] = [
    { label: 'EDITOR, no editorKey, no team link, named "John Example"', u: { id: "u1", role: "EDITOR", editorKey: null, teamMemberId: null, name: "John Example" } as V, expect: [] },
    { label: "EDITOR with an assigned editorKey", u: { id: "u2", role: "EDITOR", editorKey: "kim", teamMemberId: null, name: "Kim Miguel" } as V, expect: ["kim"] },
    { label: "ADMIN with no assigned identity (keeps the task-ticking fallback)", u: { id: "u3", role: "ADMIN", editorKey: null, teamMemberId: null, name: "Kyle Cabrera" } as V, expect: ["kyle"] },
  ];
  let fail = 0;
  for (const c of cases) {
    const keys = [...(await addressableKeys(c.u))].sort();
    const scope = editorScopeOf(c.u as never);
    const ok = JSON.stringify(keys) === JSON.stringify([...c.expect].sort());
    if (!ok) fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${c.label}`);
    console.log(`        project keys: [${keys.join(", ")}]   task scope: ${scope ?? "(not an editor)"}${scope && isUnmappedEditor(scope) ? " (unmapped → fails closed)" : ""}`);
  }
  console.log(fail === 0 ? "\nALL PASS — an unlinked editor inherits nothing, and the two answers agree" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
