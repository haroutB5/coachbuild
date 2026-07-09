// Loading skeleton shared by ProGamesSection (home page champion view) and
// ProHistoryResults (/history page). Mimics the ProGameCard layout at final
// dimensions so there's no layout shift when real cards swap in.
export default function ProGamesSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-pulse">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl p-4 h-[168px]"
        >
          <div className="h-3 w-1/3 bg-line rounded mb-3" />
          <div className="flex gap-2 mb-4">
            <div className="w-11 h-11 rounded-full bg-line" />
            <div className="w-6 h-6 rounded-full bg-line" />
            <div className="w-6 h-6 rounded-full bg-line" />
          </div>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <div key={j} className="w-9 h-9 rounded-lg bg-line" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
