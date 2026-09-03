import { Skeleton } from "@/components/ui/primitives";

/**
 * Route-level loading boundary: the shell (header, ticker, footer) stays put and the page area
 * shows a neutral skeleton the moment a link is clicked, instead of waiting for the server render.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-4 w-[520px] max-w-full" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-[360px]" />
    </div>
  );
}
