/**
 * A dependency-free sparkline.
 *
 * Deliberately hand-rolled SVG rather than a charting library: this renders one
 * series of at most a few hundred points, and shipping 60 kB of chart code for
 * it would be the largest thing in the client bundle. It is a server component,
 * so the SVG arrives with the HTML and costs nothing at runtime.
 */
export function Sparkline({
  points,
  width = 640,
  height = 96,
  label,
  className,
}: {
  points: number[];
  width?: number;
  height?: number;
  label: string;
  className?: string;
}) {
  if (points.length === 0) {
    return (
      <div className={className} style={{ height }} aria-hidden>
        <div className="skeleton h-full w-full" />
      </div>
    );
  }

  const max = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const y = (value: number) => height - (value / max) * (height - 8) - 4;
  const path = points.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
  const area = `${path} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: peak ${max}`}
    >
      {/* Baseline: gives the eye a zero to compare against. */}
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth="1" />
      <path d={area} fill="var(--primary)" opacity="0.12" />
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
