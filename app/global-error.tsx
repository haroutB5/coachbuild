"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <main className="min-h-screen flex items-center justify-center bg-[#0a0d0b] px-6 py-16 text-[#ece7de]">
          <section className="w-full max-w-md rounded-xl border border-[rgba(200,170,110,0.28)] bg-[#141916] p-8 text-center shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#c8aa6e]">CoachBuild</p>
            <h1 className="mt-4 text-2xl font-semibold">The app hit a snag</h1>
            <p className="mt-3 text-sm leading-6 text-[#838d84]">
              CoachBuild could not finish loading this screen. Retry to continue.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              className="mt-6 rounded-md border border-[rgba(200,170,110,0.28)] bg-[rgba(200,170,110,0.1)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#c8aa6e] transition-colors hover:bg-[rgba(200,170,110,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c8aa6e]"
            >
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
