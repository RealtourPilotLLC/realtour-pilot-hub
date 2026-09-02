import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink, FolderOpen, Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { listClientAssets, videoClients } from "@/lib/clientAssets";
import { brandFolderPath, dropboxConnected } from "@/lib/clientFolders";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { DropboxError, dropboxListFolder } from "@/lib/integrations/dropbox";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";

export const dynamic = "force-dynamic";
// One recursive walk of the shared root now, not ~100 folder-lists (see
// assetsByFolder below) — but keep the generous ceiling: a Dropbox stall must
// not truncate the page mid-render.
export const maxDuration = 60;

// CLIENT ASSETS — every video client's brand-asset shelf in one place
// (Jordan: "an area on the app where we can manage client assets all in one
// place"). One row per client with the Assets-available/No-assets truth read
// straight from their Dropbox folder, inline upload, and the folder link.
// Owner/admin (rides the `clients` PageKey via the /clients prefix); editors
// manage assets per-job on /edit/<id> instead.

// The canonical brand-assets root, derived from brandFolderPath() so this page
// and clientFolders.ts can never drift apart ("/AutoHDR/Client Assets").
const CLIENTS_ROOT = brandFolderPath("x").slice(0, -"/x".length);

// Same per-client ceiling listClientAssets() applies, so the two surfaces agree.
const MAX_FILES = 40;
// A client stored somewhere outside the canonical root still gets a real read,
// but bounded — this fallback must never grow back into a ~100-call walk.
const MAX_CUSTOM_PATH_READS = 12;

// WHY ONE RECURSIVE WALK: this page used to call listClientAssets() per client,
// which is a Dropbox files/list_folder each — and dbx() holds a hard 4-wide
// ceiling, so 94 video clients meant 94 calls squeezed through 4 lanes. Timed
// live against production: 94 calls / 8.5s, on top of 188 wasted Neon round
// trips (a client re-fetch + a Connection read PER client). The whole tree
// comes back in ONE paginated call instead: 2 calls / 0.9s.
// Files roll up to the client's TOP-LEVEL folder, so assets someone tidied into
// a "Logos" subfolder still count — the same one-level-down miss that once told
// Harrison his RAW-Video folder was empty.
async function assetsByFolder(): Promise<Map<string, string[]> | null> {
  try {
    const entries = await dropboxListFolder(CLIENTS_ROOT, { recursive: true });
    const prefix = `${CLIENTS_ROOT.toLowerCase()}/`;
    const byFolder = new Map<string, string[]>();
    for (const e of entries) {
      if (e.tag !== "file" || !e.path) continue;
      const lower = e.path.toLowerCase();
      if (!lower.startsWith(prefix)) continue;
      const rest = lower.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut <= 0) continue; // a file sitting loose at the root belongs to no client
      const folder = rest.slice(0, cut);
      const key = prefix + folder;
      const files = byFolder.get(key) ?? [];
      if (files.length < MAX_FILES) files.push(e.name);
      byFolder.set(key, files);
    }
    return byFolder;
  } catch (e) {
    // A missing root is a real answer ("nobody has assets yet"), same as
    // listClientAssets treats a missing client folder. Anything else means we
    // couldn't look, and the page says so rather than claiming "no assets".
    if (e instanceof DropboxError && e.message.includes("not_found")) return new Map();
    return null;
  }
}

export default async function ClientAssetsPage() {
  const me = await getCurrentUser().catch(() => null);
  const allowed = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  if (!allowed) redirect(homeFor(me?.role));

  const clients = await videoClients();
  // Connection state is read ONCE for the page (it used to be re-read, and
  // decrypted, once per client inside listClientAssets).
  const connected = await dropboxConnected();
  const byFolder = connected ? await assetsByFolder() : null;

  // Each client's folder path: the stored one, else the canonical convention.
  const paths = new Map(clients.map((c) => [c.id, c.brandAssetsPath || brandFolderPath(c.name)]));

  // Anything parked outside the canonical root can't come from the one walk —
  // read those individually, capped. Today this is zero clients; the cap is
  // here so a future custom path can't silently re-slow the page.
  const files = new Map<string, string[]>();
  const unchecked = new Set<string>(); // past the cap — we did NOT look, and must not imply we did
  if (byFolder) {
    const prefix = `${CLIENTS_ROOT.toLowerCase()}/`;
    const outside: typeof clients = [];
    for (const c of clients) {
      const path = paths.get(c.id)!.toLowerCase();
      if (path.startsWith(prefix)) files.set(c.id, byFolder.get(path) ?? []);
      else outside.push(c);
    }
    const extra = await Promise.all(
      outside.slice(0, MAX_CUSTOM_PATH_READS).map((c) =>
        listClientAssets(c.id, { links: false }).then((r) => [c.id, (r?.files ?? []).map((f) => f.name)] as const),
      ),
    );
    for (const [id, names] of extra) files.set(id, names);
    for (const c of outside.slice(MAX_CUSTOM_PATH_READS)) unchecked.add(c.id);
  }

  // "Assets on file" vs "Missing assets" is only an honest split when we could
  // actually read Dropbox. If we couldn't, show one flat list plus a banner —
  // never a "Missing assets (94)" wall that just means "we didn't look".
  const known = byFolder !== null;
  const checked = known ? clients.filter((c) => !unchecked.has(c.id)) : [];
  const withAssets = checked.filter((c) => (files.get(c.id)?.length ?? 0) > 0);
  const withoutAssets = checked.filter((c) => (files.get(c.id)?.length ?? 0) === 0);
  const notLookedAt = known ? clients.filter((c) => unchecked.has(c.id)) : [];

  const notice = !connected
    ? "Dropbox isn’t connected — add it in Connections to see what’s on file."
    : !known
      ? "Couldn’t reach Dropbox just now, so we can’t say what’s on file. The folder links still work; reload in a minute."
      : null;

  const Row = ({ c }: { c: (typeof clients)[number] }) => (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3.5">
      <span className="text-sm font-semibold">{c.name}</span>
      <ClientAssetsCard
        clientId={c.id}
        files={(files.get(c.id) ?? []).map((name) => ({ name, url: null }))}
        folderUrl={dropboxWebUrl(paths.get(c.id)!)}
        canUpload={connected}
        compact
      />
    </li>
  );

  // A row we could NOT read. It must not borrow the card's "No assets" badge —
  // that badge means "the folder is empty", and this means "we didn't look".
  const UncheckedRow = ({ c }: { c: (typeof clients)[number] }) => (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3.5">
      <span className="text-sm font-semibold">{c.name}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted-2">Not checked</span>
        <a
          href={dropboxWebUrl(paths.get(c.id)!)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
        >
          <FolderOpen className="size-3.5" /> Open folder <ExternalLink className="size-3" />
        </a>
      </div>
    </li>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Brand kits, logos & endcards"
        title="Client Assets"
        subtitle={
          known
            ? `${withAssets.length} of ${checked.length} video clients have assets on file`
            : `${clients.length} video clients`
        }
        actions={
          <Link
            href="/clients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            ← Clients
          </Link>
        }
      />
      <div className="mx-auto max-w-3xl space-y-6 p-4 pb-16 sm:p-6">
        {notice && (
          <p className="rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-sm text-warning">{notice}</p>
        )}
        {!known && clients.length > 0 && (
          <ul className="space-y-2">{clients.map((c) => <UncheckedRow key={c.id} c={c} />)}</ul>
        )}
        {withoutAssets.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-warning">
              <Palette className="size-4" /> Missing assets ({withoutAssets.length})
            </h2>
            <ul className="space-y-2">{withoutAssets.map((c) => <Row key={c.id} c={c} />)}</ul>
          </section>
        )}
        {withAssets.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Palette className="size-4 text-success" /> Assets on file ({withAssets.length})
            </h2>
            <ul className="space-y-2">{withAssets.map((c) => <Row key={c.id} c={c} />)}</ul>
          </section>
        )}
        {notLookedAt.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
              <Palette className="size-4" /> Not checked ({notLookedAt.length})
            </h2>
            <p className="mb-2 text-xs text-muted-2">
              These clients&rsquo; folders sit outside the shared root, so they need their own read — open the folder to see
              what&rsquo;s in it.
            </p>
            <ul className="space-y-2">{notLookedAt.map((c) => <UncheckedRow key={c.id} c={c} />)}</ul>
          </section>
        )}
        {clients.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
            No video clients yet — clients appear here once they order a reel.
          </p>
        )}
      </div>
    </div>
  );
}
