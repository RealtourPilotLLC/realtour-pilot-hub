import { createHash } from "node:crypto";
import type { ShootView } from "@/lib/shoot";
import type { AssetRow } from "@/lib/clientAssets";
import { stripMoneySentences } from "@/lib/text";

export type BriefLine = { key: string; label: string; value: string };

// Use the same released scripts and per-video briefs the shoot screen renders.
// No access codes, contact details, prices or unreleased script drafts enter a
// receipt. Stable keys make a rename/change visible beside the prior value.
export function shootBriefLines(view: ShootView, assets: AssetRow[]): BriefLine[] {
  const lines: BriefLine[] = [];
  const add = (key: string, label: string, value: string | null | undefined) => {
    const text = value ? stripMoneySentences(value).trim() : "";
    if (text) lines.push({ key, label, value: text });
  };

  add("job:shared", "Job-wide editing instructions", view.project.editorBrief);
  add("job:special", "Must-get / property instructions", view.appointment?.parsed?.special);
  view.specialRequests.filter((s) => !view.editRequests.includes(s)).forEach((s, i) => add(`job:must:${i}`, `Must-get ${i + 1}`, s));
  add("client:style", "Client's on-camera style", view.client.theirStyle);
  add("client:preferences", "Client's preferences", view.client.theirPreferences);
  add("reel:hook", "Listing reel hook", view.project.reelHook);
  add("reel:script", "Listing reel script", view.project.reelScript);
  add("reel:shots", "Listing reel shot list", view.project.reelShotList);
  add("reel:song", "Listing reel song", view.project.reelSong);

  for (const topic of view.session?.topics ?? []) {
    const stem = `topic:${topic.topicId}`;
    add(`${stem}:name`, "Session topic", `${topic.title}${topic.overflow ? " · extra if time" : ""}${topic.filmedElsewhere ? " · filmed at another session" : ""}`);
    add(`${stem}:script`, `${topic.title} · latest released script`, topic.script
      ? `v${topic.script.versionNo} · ${topic.script.standing}\n${topic.script.title}\n${topic.script.text ?? ""}`
      : topic.noScript);
    const direction = topic.script?.direction;
    add(`${stem}:filming`, `${topic.title} · filming notes`, direction?.filmingNotes);
    add(`${stem}:direction`, `${topic.title} · direction`, direction?.creativeDirection);
    add(`${stem}:production`, `${topic.title} · production notes`, direction?.productionNotes);
  }

  const brand = view.session?.brand;
  add("brand:fonts", "Font names", brand?.fontNames);
  add("brand:music", "Music", brand?.music);
  brand?.productionDefaults.forEach((d, i) => add(`brand:default:${i}`, d.name, d.text));
  brand?.acceptedPreferences.forEach((v, i) => add(`brand:accepted:${i}`, `Accepted preference ${i + 1}`, v));
  brand?.files.forEach((f, i) => add(`brand:file:${i}`, f.typeWord, `${f.name} · v${f.versionNo}`));

  for (const asset of assets) {
    if (!["PRONUNCIATION", "APPROVED_PHOTO", "EXAMPLE_VIDEO"].includes(asset.type) || !asset.active || asset.active.cleared) continue;
    add(`asset:${asset.id}`, `${asset.type === "PRONUNCIATION" ? "Pronunciation" : asset.type === "EXAMPLE_VIDEO" ? "Video reference" : "Approved photo"} · ${asset.name}`,
      `v${asset.active.versionNo} · ${asset.active.valueText ?? asset.active.fileName ?? "file on record"}`);
  }

  for (const output of view.outputBriefs) {
    const stem = `output:${output.outputId}`;
    add(`${stem}:name`, "Video output", `${output.label} · ${output.format}`);
    add(`${stem}:version`, `${output.label} · brief version`, output.versionLabel);
    add(`${stem}:asset`, `${output.label} · chosen asset`, output.brandAsset
      ? `${output.brandAsset.name} · v${output.brandAsset.versionNo ?? "?"}${output.brandAsset.state !== "current" ? " · no longer current" : ""}`
      : "No chosen logo or branding card recorded");
    output.sections.forEach((section) => add(`${stem}:section:${section.label}`, `${output.label} · ${section.label}`, section.text));
  }
  return lines;
}

export const briefSnapshot = (lines: BriefLine[]) => JSON.stringify(lines);
export const briefDigest = (snapshot: string) => createHash("sha256").update(snapshot).digest("hex");

export function briefChanges(previous: BriefLine[], current: BriefLine[]): { label: string; before: string | null; after: string | null }[] {
  const old = new Map(previous.map((line) => [line.key, line]));
  const now = new Map(current.map((line) => [line.key, line]));
  return [...new Set([...old.keys(), ...now.keys()])].flatMap((key) => {
    const before = old.get(key);
    const after = now.get(key);
    return before?.value === after?.value ? [] : [{ label: after?.label ?? before?.label ?? key, before: before?.value ?? null, after: after?.value ?? null }];
  });
}

export function parseBriefSnapshot(json: string): BriefLine[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((x) => x && typeof x.key === "string" && typeof x.label === "string" && typeof x.value === "string") ? value : [];
  } catch { return []; }
}
