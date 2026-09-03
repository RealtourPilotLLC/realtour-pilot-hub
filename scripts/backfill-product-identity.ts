/**
 * Backfill PRODUCT IDENTITY onto existing deliverables (Sep 2 2026).
 *
 * `Deliverable.type` is a category; mapping an Aryeo line through Settings →
 * Products used to keep only that plus a generic label, so "Standard Reel with
 * Agent Intro" landed as SOCIAL_REEL "Social Reel" and every surface read the
 * wrong video type (626 Greycliffe). The sync now writes two more columns —
 * `productTitle` (the order-item name, verbatim) and `videoStyle` (the Style
 * Guide key) — and this fills them in for the 3,900 rows that predate it.
 *
 * Evidence per row, best first:
 *   order_items  the project's STORED OrderItem rows (verbatim Aryeo titles)
 *                run through the live derivation (orderDeliverables) and
 *                matched by type — the exact path a fresh sync takes.
 *   aryeo_live   (--aryeo) a project with no stored items: its order re-read
 *                from Aryeo, read-only GET, then the same derivation. (491
 *                Aryeo projects have no stored items; backfillOrderItems()
 *                in integrations/aryeo.ts persists them if wanted.)
 *   label_title  the row's own label is a real product name (the keyword
 *                parser has always kept titles) → productTitle = label.
 *   label_tier   a generic video label ("Premium Social Reel", "Video") — no
 *                title to recover; the style follows the label's tier + type.
 *   unresolved   nothing to go on (generic non-video labels with no items).
 *
 * Project.packageName is null on every project today (probe, Sep 2), so it is
 * only a hint that will start mattering if that column is ever filled.
 *
 * Never creates or deletes rows; never touches type / status / quantity.
 * The LABEL changes only on VIDEO / SOCIAL_REEL rows, only from order_items /
 * aryeo_live evidence, and only to what the sync itself now writes — so the
 * hourly reconcile finds nothing left to relabel (and logs no "order changed"
 * activity for it). --keep-labels fills title/style only.
 *
 * DRY RUN by default. The module tree is `server-only`, so tsx needs the
 * react-server condition:
 *
 *   npx tsx --conditions=react-server scripts/backfill-product-identity.ts            # dry run
 *   npx tsx --conditions=react-server scripts/backfill-product-identity.ts --apply    # write
 *
 * Flags: --aryeo        also re-read orders for projects with no stored items (read-only)
 *        --limit N      first N projects only (newest first)
 *        --project ID   one project
 *        --force        recompute rows that already carry a productTitle
 *        --keep-labels  never change a label
 */
import { prisma } from "../src/lib/prisma";
import {
  Aryeo,
  loadManualProductMap,
  orderDeliverables,
  resolveVideoStyle,
  type ParsedDeliverable,
  type VideoStyleKey,
} from "../src/lib/integrations/aryeo";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = flag("--apply");
const USE_ARYEO = flag("--aryeo");
const FORCE = flag("--force");
const KEEP_LABELS = flag("--keep-labels");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : undefined;
const PROJECT = opt("--project");

type Method = "order_items" | "aryeo_live" | "label_title" | "label_tier" | "unresolved" | "already";
type Plan = {
  id: string;
  project: string;
  type: string;
  from: { label: string | null; productTitle: string | null; videoStyle: string | null };
  to: { label?: string; productTitle?: string | null; videoStyle?: string | null };
  method: Method;
};

const VIDEO_TYPES = new Set(["VIDEO", "SOCIAL_REEL"]);
// The labels the mapping writes when it is not naming a product — the bare
// type words, tier-decorated ("Premium Video"), the drone splits, and the
// keyword parser's component labels. A label outside this set IS a title.
const GENERIC_LABEL_RE =
  /^(premium\s+)?(video|reel|social\s+(media\s+)?reel|drone\s+(photos|video)|photos|floor\s+plan|drone\s*\/\s*aerial|zillow\s+3d\s+tour|matterport\s+3d|twilight|virtual\s+staging|headshots?|item|other)(\s*\(\s*discounted\s*\))?$/i;
// "Premium Reel 1 of 4" is a hub-minted slot name, not a product either.
const isGenericLabel = (label: string | null | undefined) =>
  !label?.trim() || GENERIC_LABEL_RE.test(label.trim()) || /\b\d+\s+of\s+\d+\b/i.test(label);
// manualLabel suffixes a personal-branding title that doesn't say "monthly"
// with " · Monthly Content" — strip it to recover the verbatim product name.
const titleFromLabel = (label: string) => label.replace(/\s*·\s*Monthly Content\s*$/i, "").trim();

async function main() {
  await loadManualProductMap(true);

  const projects = await prisma.project.findMany({
    where: {
      ...(PROJECT ? { id: PROJECT } : {}),
      deliverables: { some: FORCE ? {} : { productTitle: null } },
    },
    select: {
      id: true, title: true, aryeoOrderId: true, packageName: true,
      orderItems: { select: { title: true, quantity: true, isCanceled: true } },
      deliverables: {
        select: { id: true, type: true, label: true, quantity: true, productTitle: true, videoStyle: true, manual: true, removedFromOrderAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`${projects.length} project(s) with ${FORCE ? "deliverables" : "deliverables missing a productTitle"}${LIMIT ? ` (limit ${LIMIT})` : ""}.`);

  const plans: Plan[] = [];
  const counts: Record<Method, number> = { order_items: 0, aryeo_live: 0, label_title: 0, label_tier: 0, unresolved: 0, already: 0 };
  let aryeoFetched = 0, aryeoFailed = 0, labelChanges = 0;
  const styleCounts = new Map<string, number>();

  for (const p of projects) {
    // ---- evidence: stored items, else (opt-in) the live order ------------
    let items = p.orderItems.filter((it) => !it.isCanceled).map((it) => ({ title: it.title, quantity: it.quantity, is_canceled: false }));
    let evidence: Method = "order_items";
    if (items.length === 0 && USE_ARYEO && p.aryeoOrderId) {
      try {
        const order = await Aryeo.order(p.aryeoOrderId);
        items = (order.items ?? []).filter((it) => !it.is_canceled).map((it) => ({ title: (it.title || it.sub_title || it.subtitle || "").trim(), quantity: it.quantity || 1, is_canceled: false })).filter((it) => it.title);
        evidence = "aryeo_live";
        aryeoFetched++;
      } catch { aryeoFailed++; }
    }
    const want = new Map<string, ParsedDeliverable>();
    if (items.length > 0) {
      for (const d of orderDeliverables(items as Parameters<typeof orderDeliverables>[0])) want.set(d.type, d);
    }

    for (const d of p.deliverables) {
      if (!FORCE && d.productTitle) { counts.already++; continue; }
      const from = { label: d.label, productTitle: d.productTitle, videoStyle: d.videoStyle };
      const plan: Plan = { id: d.id, project: p.title, type: d.type, from, to: {}, method: "unresolved" };
      const w = d.manual ? undefined : want.get(d.type); // hub-created rows are never described by the order
      if (w) {
        plan.method = evidence;
        plan.to.productTitle = w.productTitle;
        plan.to.videoStyle = w.videoStyle;
        if (!KEEP_LABELS && VIDEO_TYPES.has(d.type) && !d.removedFromOrderAt && (d.label ?? "") !== w.label) plan.to.label = w.label;
      } else if (!isGenericLabel(d.label)) {
        // The keyword parser kept the real name as the label.
        const title = titleFromLabel(d.label!);
        plan.method = "label_title";
        plan.to.productTitle = title;
        plan.to.videoStyle = resolveVideoStyle(d.type, { title: d.label });
      } else if (VIDEO_TYPES.has(d.type)) {
        // "Premium Social Reel" / "Video" / "Social Reel": the tier is in the
        // label, the product name is gone.
        plan.method = "label_tier";
        plan.to.videoStyle = resolveVideoStyle(d.type, { title: [d.label, p.packageName].filter(Boolean).join(" ") });
      }
      counts[plan.method]++;
      const changes =
        (plan.to.productTitle !== undefined && plan.to.productTitle !== from.productTitle) ||
        (plan.to.videoStyle !== undefined && plan.to.videoStyle !== from.videoStyle) ||
        plan.to.label !== undefined;
      if (plan.method === "unresolved" || !changes) continue;
      if (plan.to.label !== undefined) labelChanges++;
      if (plan.to.videoStyle) styleCounts.set(plan.to.videoStyle, (styleCounts.get(plan.to.videoStyle) ?? 0) + 1);
      plans.push(plan);
    }
  }

  // ---- report ---------------------------------------------------------------
  console.log("\nRows by resolution method:");
  for (const [m, n] of Object.entries(counts)) console.log(`  ${m.padEnd(12)} ${n}`);
  if (USE_ARYEO) console.log(`  (aryeo orders fetched ${aryeoFetched}, unreachable ${aryeoFailed})`);
  console.log(`\n${plans.length} row(s) would be updated · ${labelChanges} label change(s)${KEEP_LABELS ? " (labels kept)" : ""}`);
  console.log("videoStyle by key:");
  for (const [k, n] of [...styleCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${(k as VideoStyleKey).padEnd(26)} ${n}`);

  // 15 samples, round-robin across methods so every path shows itself, video
  // rows first inside each (they carry the most change).
  const byMethod = new Map<Method, Plan[]>();
  for (const pl of plans) byMethod.set(pl.method, [...(byMethod.get(pl.method) ?? []), pl]);
  for (const list of byMethod.values()) list.sort((a, b) => Number(VIDEO_TYPES.has(b.type)) - Number(VIDEO_TYPES.has(a.type)));
  const samples: Plan[] = [];
  for (let i = 0; samples.length < 15; i++) {
    let any = false;
    for (const list of byMethod.values()) if (list[i]) { samples.push(list[i]); any = true; if (samples.length >= 15) break; }
    if (!any) break;
  }
  console.log("\nSample rows:");
  for (const s of samples) {
    const label = s.to.label !== undefined ? `label "${s.from.label}" → "${s.to.label}"` : `label "${s.from.label}"`;
    console.log(`  [${s.method}] ${s.project.slice(0, 40).padEnd(40)} ${s.type.padEnd(12)} ${label}`);
    console.log(`      productTitle → ${JSON.stringify(s.to.productTitle ?? null)} · videoStyle → ${JSON.stringify(s.to.videoStyle ?? null)}`);
  }

  if (!APPLY) {
    const flags = argv.filter((a) => a !== "--apply").join(" ");
    console.log(`\nDRY RUN — nothing written. To apply exactly this plan:\n  npx tsx --conditions=react-server scripts/backfill-product-identity.ts ${flags}${flags ? " " : ""}--apply`);
    return;
  }

  // ---- apply: chunked transactions of plain updates -------------------------
  let written = 0;
  for (let i = 0; i < plans.length; i += 100) {
    const chunk = plans.slice(i, i + 100);
    await prisma.$transaction(
      chunk.map((pl) =>
        prisma.deliverable.update({
          where: { id: pl.id },
          data: {
            ...(pl.to.productTitle !== undefined ? { productTitle: pl.to.productTitle } : {}),
            ...(pl.to.videoStyle !== undefined ? { videoStyle: pl.to.videoStyle } : {}),
            ...(pl.to.label !== undefined ? { label: pl.to.label } : {}),
          },
        }),
      ),
    );
    written += chunk.length;
    console.log(`  wrote ${written}/${plans.length}`);
  }
  console.log(`\nAPPLIED — ${written} row(s) updated.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
