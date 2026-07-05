import type { CSSProperties } from 'react';

/**
 * The Claudable wordmark rendered via CSS mask, so it can be tinted with any
 * color or gradient through the `background` style. Works in server and client
 * components (no hooks). Size it with width/height classes; the source SVG has
 * a 2229x385 (~5.79:1) aspect ratio.
 */
const MASK: CSSProperties = {
  maskImage: "url('/Claudable_logo.svg')",
  WebkitMaskImage: "url('/Claudable_logo.svg')",
  maskSize: 'contain',
  WebkitMaskSize: 'contain',
  maskRepeat: 'no-repeat',
  WebkitMaskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskPosition: 'center',
};

export default function BrandWordmark({
  className = '',
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="img"
      aria-label="Claudable"
      className={className}
      style={{ ...MASK, ...style }}
    />
  );
}
