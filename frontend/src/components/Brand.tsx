export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Congest">
      <img className="brand-mark" src="/logo.svg" alt="Congest" />
      {!compact && <span>Congest</span>}
    </div>
  );
}
