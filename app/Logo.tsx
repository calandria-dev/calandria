// Calandria logomark: a 3×3 isometric lattice of control rods, radial
// opacity fade from the raised center rod, each standing in a thin open
// "channel ring". Single color via currentColor; tint with CSS (see
// .tb-logo in globals.css). Source: docs/design/handoff/assets/logo.svg.
import type { SVGProps } from "react";

export function Logo({ size = 17.5, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  const height = size;
  const width = size * (14.45 / 17.23);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="4.78 6.6 14.45 17.23"
      fill="none"
      width={width}
      height={height}
      style={{ flex: "none" }}
      {...props}
    >
      <ellipse cx="12" cy="16.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".21" />
      <rect x="10.95" y="7.1" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".3" />
      <ellipse cx="14.6" cy="18.1" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".385" />
      <rect x="13.55" y="8.6" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".55" />
      <ellipse cx="9.4" cy="18.1" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".385" />
      <rect x="8.35" y="8.6" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".55" />
      <ellipse cx="17.2" cy="19.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".21" />
      <rect x="16.15" y="10.1" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".3" />
      <ellipse cx="12" cy="19.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".7" />
      <rect x="10.95" y="6.6" width="2.1" height="13" rx="1.05" fill="currentColor" />
      <ellipse cx="6.8" cy="19.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".21" />
      <rect x="5.75" y="10.1" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".3" />
      <ellipse cx="14.6" cy="21.1" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".385" />
      <rect x="13.55" y="11.6" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".55" />
      <ellipse cx="9.4" cy="21.1" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".385" />
      <rect x="8.35" y="11.6" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".55" />
      <ellipse cx="12" cy="22.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".21" />
      <rect x="10.95" y="13.1" width="2.1" height="9.5" rx="1.05" fill="currentColor" opacity=".3" />
    </svg>
  );
}

// Sub-14px uses: center rod + ring only (docs/design/handoff/assets/favicon-small.svg).
export function LogoSmall({ size = 12, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  const height = size;
  const width = size * (4.05 / 14.23);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="9.98 6.6 4.05 14.23"
      fill="none"
      width={width}
      height={height}
      style={{ flex: "none" }}
      {...props}
    >
      <ellipse cx="12" cy="19.6" rx="1.75" ry=".95" stroke="currentColor" strokeWidth=".55" opacity=".7" />
      <rect x="10.95" y="6.6" width="2.1" height="13" rx="1.05" fill="currentColor" />
    </svg>
  );
}
