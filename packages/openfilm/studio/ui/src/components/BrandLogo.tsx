/*
 * Framino mark: a single lowercase `f`, drawn as two quiet strokes — an ascender that curves at the top and one
 * crossbar. No robot, wand, star or brain; no gradients. It inherits the surrounding text color so it sits in a
 * toolbar, a menu or a loading screen without its own palette.
 */
const VIEWBOX = '0 0 28 28';
const ASCENDER = 'M11 24V10a3.5 3.5 0 0 1 3.5-3.5h2.5';
const CROSSBAR = 'M7.5 14h10';

export function BrandLogo({ size = 18, className = 'block shrink-0' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} className={className} fill="none" role="img" aria-label="Framino">
      <g stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={ASCENDER} />
        <path d={CROSSBAR} />
      </g>
    </svg>
  );
}
