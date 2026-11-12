/** The Silica mark: a faceted crystal. Same drawing as public/logo.svg. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <polygon points="16,1 7,10 16,13.5" fill="#c4b5fd" />
      <polygon points="16,1 25,10 16,13.5" fill="#8b5cf6" />
      <polygon points="7,10 16,13.5 16,31 7,22" fill="#67e8f9" />
      <polygon points="25,10 25,22 16,31 16,13.5" fill="#0ea5b7" />
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
