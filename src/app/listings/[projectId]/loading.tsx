// While the listing is read from Aryeo (one read per open): the page's shape.
export default function ListingLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 pb-16 sm:p-6" aria-busy="true" aria-label="Loading the listing">
      <div className="h-11 w-36 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
      <div className="panel-shadow overflow-hidden rounded-3xl border bg-surface">
        <div className="aspect-[4/3] w-full animate-pulse bg-surface-2 motion-reduce:animate-none sm:aspect-[21/9]" />
        <div className="space-y-2 p-4 sm:px-7">
          <div className="h-4 w-48 rounded bg-surface-2" />
          <div className="h-4 w-64 rounded bg-surface-2" />
        </div>
      </div>
      <div className="panel-shadow rounded-2xl border bg-surface p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
