'use client';

import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

/**
 * Glass card whose border/interior picks up a soft warm glow that follows the
 * pointer (Linear-style spotlight). Imperative style updates via ref so
 * mousemove never triggers React re-renders.
 */
export default function SpotlightCard({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const glowRef = useRef<HTMLDivElement>(null);

  const handleMove = (e: MouseEvent<HTMLDivElement>) => {
    const glow = glowRef.current;
    if (!glow) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    glow.style.background = `radial-gradient(280px circle at ${x}px ${y}px, rgba(232,168,124,0.09), transparent 72%)`;
    glow.style.opacity = '1';
  };

  const handleLeave = () => {
    if (glowRef.current) glowRef.current.style.opacity = '0';
  };

  return (
    <div
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={`relative overflow-hidden rounded-2xl border border-white/8 bg-linear-to-b from-white/5 to-white/1.5 backdrop-blur-xl shadow-[0_24px_70px_-24px_rgba(0,0,0,0.85)] ${className}`}
      style={style}
    >
      {/* Hairline top highlight — catches the light like a real glass edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/25 to-transparent"
      />
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300"
      />
      <div className="relative">{children}</div>
    </div>
  );
}
