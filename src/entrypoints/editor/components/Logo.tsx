import { useId } from 'react';

/**
 * The BlockFlow mark, no background: a trigger block (clock) wired to a browser block, with a "done"
 * block. Same drawing as public/logo.svg (see docs/brand/README.md). Colours come from `--logo-a`
 * (violet), `--logo-b` (sky) and `--logo-ok` in style.css, which are lighter in dark mode.
 */
export function Logo({ size = 26 }: { size?: number }) {
  const link = useId();
  return (
    <svg className="bf-logo" width={size} height={size} viewBox="40 60 440 350" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={link} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--logo-a)" />
          <stop offset="1" stopColor="var(--logo-b)" />
        </linearGradient>
      </defs>
      <path d="M214 240 C268 240 262 330 304 330" fill="none" stroke={`url(#${link})`} strokeWidth="22" strokeLinecap="round" />
      <path d="M214 240 C262 240 266 132 312 132" fill="none" stroke="var(--logo-a)" strokeWidth="14" strokeLinecap="round" strokeDasharray="1 30" />
      <rect x="44" y="156" width="170" height="168" rx="42" fill="var(--logo-a)" fillOpacity=".12" stroke="var(--logo-a)" strokeWidth="24" />
      <circle cx="129" cy="240" r="44" fill="none" stroke="var(--logo-a)" strokeWidth="18" />
      <path d="M129 214 V242 H150" fill="none" stroke="var(--logo-a)" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="304" y="262" width="168" height="136" rx="38" fill="var(--logo-b)" fillOpacity=".12" stroke="var(--logo-b)" strokeWidth="24" />
      <path d="M304 306 H472" stroke="var(--logo-b)" strokeWidth="18" />
      <circle cx="340" cy="285" r="8" fill="var(--logo-b)" />
      <circle cx="366" cy="285" r="8" fill="var(--logo-b)" />
      <rect x="312" y="84" width="128" height="96" rx="30" fill="var(--logo-a)" fillOpacity=".12" stroke="var(--logo-a)" strokeWidth="20" />
      <path d="M348 133 L368 152 L404 114" fill="none" stroke="var(--logo-ok)" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
