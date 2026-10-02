export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  sticky = true,
}: {
  title: string;
  /** a string, or a node — e.g. the client's headshot beside their name */
  subtitle?: React.ReactNode;
  /** small uppercase copper label above the title (the brand motif) */
  eyebrow?: string;
  actions?: React.ReactNode;
  sticky?: boolean | "desktop";
}) {
  return (
    <div className={`${sticky === "desktop" ? "relative lg:sticky" : sticky ? "sticky" : "relative"} top-0 z-10 flex flex-wrap items-end justify-between gap-3 border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6`}>
      <div className="min-w-0 flex-1 basis-64">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="break-words text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 break-words text-ui-secondary leading-relaxed text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
