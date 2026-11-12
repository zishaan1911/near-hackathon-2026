import { useId } from 'react';

/** The Silica mark: a wafer of nine dies, one lit. Same drawing as public/logo.svg. */
export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId();
  const cells = [6, 13.25, 20.5];
  // Opacity per die, row by row. The top-right die is the lit one.
  const light = [0.38, 0.38, 1, 0.38, 0.7, 0.38, 0.7, 0.38, 0.38];
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f6bff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      {cells.flatMap((y, row) =>
        cells.map((x, col) => (
          <rect
            key={`${row}-${col}`}
            x={x}
            y={y}
            width="5.5"
            height="5.5"
            rx="1.25"
            fill="#fff"
            opacity={light[row * 3 + col]}
          />
        )),
      )}
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">Silica</span>
    </span>
  );
}
