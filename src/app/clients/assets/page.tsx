import Link from "next/link";
import { redirect } from "next/navigation";
import { Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { listClientAssets, videoClients } from "@/lib/clientAssets";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";

export const dynamic = "force-dynamic";
// ~100 clients × a Dropbox folder-list each; the token is cached but the walk
// still takes real seconds — never let the platform default cut it off.
export const maxDuration = 60;

// CLIENT ASSETS — every video client's brand-asset shelf in one place
// (Jordan: "an area on the app where we can manage client assets all in one
// place"). One row per client with the Assets-available/No-assets truth read
// straight from their Dropbox folder, inline upload, and the folder link.
// Owner/admin (rides the `clients` PageKey via the /clients prefix); editors
// manage assets per-job on /edit/<id> instead.
export default async function ClientAssetsPage() {
  const me = await getCurrentUser().catch(() => null);
  const allowed = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  if (!allowed) redirect(homeFor(me?.role));

  const clients = await videoClients();
  // Folder statuses with modest concurrency — counts only (no link minting).
  const statuses = new Map<string, Awaited<ReturnType<typeof listClientAssets>>>();
  const CONCURRENCY = 8;
  for (let i = 0; i < clients.length; i += CONCURRENCY) {
    const batch = clients.slice(i, i + CONCURRENCY);
    const rs = await Promise.all(batch.map((c) => listClientAssets(c.id, { links: false })));
    rs.forEach((r, j) => statuses.set(batch[j].id, r));
  }
  const withAssets = clients.filter((c) => (statuses.get(c.id)?.files.length ?? 0) > 0);
  const withoutAssets = clients.filter((c) => (statuses.get(c.id)?.files.length ?? 0) === 0);

  const Row = ({ c }: { c: (typeof clients)[number] }) => {
    const s = statuses.get(c.id);
    return (
      <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3.5">
        <span className="text-sm font-semibold">{c.name}</span>
        <ClientAssetsCard
          clientId={c.id}
          files={(s?.files ?? []).map((f) => ({ name: f.name, url: null }))}
          folderUrl={s?.folderUrl ?? null}
          canUpload
          compact
        />
      </li>
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Brand kits, logos & endcards"
        title="Client Assets"
        subtitle={`${withAssets.length} of ${clients.length} video clients have assets on file`}
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
        {clients.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
            No video clients yet — clients appear here once they order a reel.
          </p>
        )}
      </div>
    </div>
  );
}
