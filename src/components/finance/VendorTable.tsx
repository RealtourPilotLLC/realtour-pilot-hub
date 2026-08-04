"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

type Row = {
  vendor: string;
  kind: "BUSINESS" | "PERSONAL";
  category: string;
  ytd: number;
  count: number;
  avgMonthly: number;
};

type SortKey = "vendor" | "category" | "ytd" | "avgMonthly" | "count";

const m = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// Sortable vendors table — click a header to sort by it; click again to flip.
// Text columns default A→Z, money/number columns default high→low.
export function VendorTable({ vendors }: { vendors: Row[] }) {
  const [key, setKey] = useState<SortKey>("ytd");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const setSort = (k: SortKey) => {
    if (k === key) setDir(dir === "asc" ? "desc" : "asc");
    else { setKey(k); setDir(k === "vendor" || k === "category" ? "asc" : "desc"); }
  };

  const rows = useMemo(() => {
    const s = [...vendors];
    const mul = dir === "asc" ? 1 : -1;
    s.sort((a, b) => {
      if (key === "vendor" || key === "category") {
        const cmp = a[key].localeCompare(b[key], "en", { sensitivity: "base" });
        // Tie-break categories by biggest spend first so groups read naturally.
        return cmp !== 0 ? cmp * mul : b.ytd - a.ytd;
      }
      return (a[key] - b[key]) * mul;
    });
    return s;
  }, [vendors, key, dir]);

  const Th = ({ k, label, right, wide }: { k: SortKey; label: string; right?: boolean; wide?: boolean }) => (
    <th className={`${wide ? "px-5" : "px-3"} py-2 font-medium ${right ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => setSort(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground ${key === k ? "text-foreground" : ""}`}
      >
        {right && sortIcon(k, key, dir)}
        {label}
        {!right && sortIcon(k, key, dir)}
      </button>
    </th>
  );

  return (
    <table className="w-full min-w-[640px] text-sm">
      <thead>
        <tr className="border-b border-border text-xs text-muted-2">
          <Th k="vendor" label="Vendor" wide />
          <Th k="category" label="Category" />
          <Th k="ytd" label="YTD spend" right />
          <Th k="avgMonthly" label="Avg / month" right />
          <Th k="count" label="Txns" right wide />
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.vendor} className="border-b border-border/60 last:border-0 hover:bg-surface-2">
            <td className="px-5 py-2">
              <span className="font-medium">{v.vendor}</span>
              <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${v.kind === "BUSINESS" ? "bg-[#6ba3d6]/15 text-[#6ba3d6]" : "bg-[#d4a95f]/15 text-[#d4a95f]"}`}>
                {v.kind === "BUSINESS" ? "Biz" : "Personal"}
              </span>
            </td>
            <td className="px-3 py-2 text-xs text-muted">{v.category}</td>
            <td className="px-3 py-2 text-right font-medium tabular-nums">{m(v.ytd)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-muted">{m(v.avgMonthly)}</td>
            <td className="px-5 py-2 text-right tabular-nums text-muted-2">{v.count || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function sortIcon(k: SortKey, active: SortKey, dir: "asc" | "desc") {
  if (k !== active) return <ArrowUpDown className="size-3 opacity-40" />;
  return dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />;
}
