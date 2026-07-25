"use client";

// ─────────────────────────────────────────────────────────────────────────────
// components/hextech/ChampionPickPrompt.tsx — what Builds shows before you have
// picked anything (fresh install, or storage cleared).
//
// WHY (user directive 2026-07-25, "stop showing viktor by default"): the page
// landed on Viktor for everyone, because `app/page.tsx` seeded its state with
// STATIC_FALLBACK_LANE_CHAMPIONS.mid so first paint matched the original design
// mockup. A build page asserting a champion you never picked is the same
// mistake as a training app asserting a program you never chose.
//
// NOTE ON WHAT THIS DELIBERATELY DOESN'T DO: it does not suggest champions.
// Recommending "popular picks" here would be Viktor with extra steps — still
// the app choosing for you. It points at the one control that starts
// everything, and says what the page becomes once you use it. Favourite-
// champion shortcuts were considered and dropped: `lib/favorites.ts` stores only
// {id, name}, while ChampionRef needs the ddragon `key`, and inventing one risks
// a wrong build fetch. Wiring those properly (via the champion list the app
// already loads) is a clean follow-up, not something to fake here.
// ─────────────────────────────────────────────────────────────────────────────

export default function ChampionPickPrompt() {
  return (
    <div className="mt-2 rounded-2xl border border-line bg-panel/60 px-5 py-12 text-center">
      <p className="text-[10.5px] tracking-[1.5px] uppercase text-teal font-bold">Builds</p>
      <h2 className="mt-2 font-display text-2xl sm:text-3xl text-txt">
        Search a champion to see their build.
      </h2>
      <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-mut">
        Runes, summoners, item order and pro builds for any champion and lane. Use the search at
        the top — whatever you look at last will be waiting here next time.
      </p>
      <p className="mt-6 text-[12.5px] text-mut/70">
        Playing right now? Install the companion and Builds follows your champ select
        automatically.
      </p>
    </div>
  );
}
