import { notFound } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { ControlStates } from "@/components/ui/ControlStates";

export const dynamic = "force-dynamic";

export default async function UiPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  await requirePageAccess("settings");
  return <>
    <PageHeader title="Control comparison" subtitle="Development fixtures for save, error, empty and disabled states. All examples are fictional." />
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <section aria-labelledby="staff-control-heading"><h2 id="staff-control-heading" className="mb-3 text-lg font-semibold">Current staff theme</h2><ControlStates prefix="staff" /></section>
      <section aria-labelledby="client-control-heading" className="portal-light rounded-2xl bg-background p-4 text-foreground"><h2 id="client-control-heading" className="mb-3 text-lg font-semibold">Client light palette</h2><ControlStates prefix="client" /></section>
    </main>
  </>;
}
