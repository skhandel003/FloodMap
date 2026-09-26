import { EarthGlobe } from "@/components/landing/EarthGlobe";
import { Hero } from "@/components/landing/Hero";
import { NavigationButtons } from "@/components/landing/NavigationButtons";

/**
 * Landing page component (Server Component)
 *
 * Following Next.js 16 best practices:
 * - Server Component by default for better performance
 * - Only child components that need interactivity are Client Components
 * - Image optimization with Next.js Image component
 * - Optimized for dark background with light text
 */
export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-black">
      {/* Rotating earth background */}
      <EarthGlobe />

      {/* Main content - sits in the space above the globe */}
      <main className="relative flex flex-col items-center min-h-screen pt-[10vh]">
        {/* Hero section */}
        <section className="w-full">
          <Hero />
        </section>

        {/* Navigation buttons */}
        <section className="w-full py-8">
          <NavigationButtons />
        </section>
      </main>
    </div>
  );
}
