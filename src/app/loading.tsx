// Shown during route navigation while server components fetch (every page is
// force-dynamic + DB-backed, so without this the user sees a blank frame).
export default function Loading() {
  return (
    <div className="p-4 sm:p-6">
      <div className="h-7 w-56 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-2 h-4 w-36 animate-pulse rounded bg-surface-2" />
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border bg-surface" />
        ))}
      </div>
      <div className="mt-6 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl border bg-surface" />
        ))}
      </div>
    </div>
  );
}
