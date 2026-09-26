/**
 * Hero component for landing page (Server Component)
 */
export function Hero() {
  return (
    <div className="relative flex flex-col items-center justify-center text-center px-4 py-6">
      {/* Content */}
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="scroll-m-20 border-b pb-2 text-4xl sm:text-7xl text-white font-extrabold tracking-tight first:mt-0 text-balance">
          Flood Map
        </h1>

        <p className="text-lg sm:text-xl md:text-2xl text-white/80 max-w-2xl mx-auto">
          Firsthand flood reports from social media, sorted by AI and pinned to
          a live map, so communities and responders can see where flooding is
          happening and act sooner.
        </p>
      </div>
    </div>
  );
}
