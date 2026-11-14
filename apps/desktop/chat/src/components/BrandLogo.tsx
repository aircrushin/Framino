'use client';

/*
 * Framino mark: a single lowercase `f`, drawn as two quiet strokes — an ascender that curves at the top and one
 * crossbar. Inherits the surrounding text color so it works in the desktop chat chrome too.
 */
const VIEWBOX = '0 0 28 28';
const ASCENDER = 'M11 24V10a3.5 3.5 0 0 1 3.5-3.5h2.5';
const CROSSBAR = 'M7.5 14h10';

export function BrandLogo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      fill="none"
      className={`block shrink-0 ${className ?? ''}`.trim()}
      role="img"
      aria-label="Framino"
    >
      <g stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={ASCENDER} />
        <path d={CROSSBAR} />
      </g>
    </svg>
  );
}
