import Link from "next/link";

// Shared chrome for the public legal pages (/privacy, /terms). Rendered bare
// (no sidebar) so they're readable by anyone Intuit/Google send here, without
// exposing any part of the app.
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background px-5 py-12">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 border-b border-border pb-6">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Real<span className="text-brand">Tour</span> Pilot
          </Link>
          <h1 className="mt-4 text-3xl font-bold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-2">Last updated {updated}</p>
        </header>

        <div className="space-y-8">{children}</div>

        <footer className="mt-12 border-t border-border pt-6 text-xs text-muted-2">
          <p>RealTour Pilot LLC · Operations Hub</p>
          <p className="mt-1">
            <Link href="/privacy" className="hover:text-foreground">Privacy Policy</Link>
            {" · "}
            <Link href="/terms" className="hover:text-foreground">Terms of Service</Link>
            {" · "}
            <a href="mailto:info@realtourpilot.com" className="hover:text-foreground">info@realtourpilot.com</a>
          </p>
        </footer>
      </div>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted [&_a]:text-brand [&_a]:underline [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground [&_ul]:space-y-1.5">
        {children}
      </div>
    </section>
  );
}
