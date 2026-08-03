"use client";

export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-[70vh] flex items-center justify-center px-6 py-16 bg-bg text-txt">
      <section className="w-full max-w-md rounded-xl border border-line-gold bg-panel p-8 text-center shadow-[0_18px_50px_rgba(0,0,0,0.45)]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-teal">CoachBuild</p>
        <h1 className="mt-4 font-display text-2xl text-txt">The page hit a snag</h1>
        <p className="mt-3 text-sm leading-6 text-mut">
          Something went wrong while loading this view. Try again and your place should be restored.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 rounded-md border border-line-gold bg-teal/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-teal transition-colors hover:bg-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
