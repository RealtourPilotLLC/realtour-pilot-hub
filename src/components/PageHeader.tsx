export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** small uppercase copper label above the title (the brand motif) */
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-end justify-between gap-3 border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
