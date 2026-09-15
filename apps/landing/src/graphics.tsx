import type { CSSProperties } from "react";
import { useOrbitalCharge } from "./orbital";
import "./graphics-motion.css";

export type IconName =
  | "arrow"
  | "play"
  | "pause"
  | "replay"
  | "link"
  | "database"
  | "shield"
  | "bolt"
  | "work"
  | "code"
  | "check"
  | "eye";

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    play: <path d="m9 5 11 7-11 7Z" />,
    pause: <path d="M9 5v14M15 5v14" />,
    replay: (
      <>
        <path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" />
      </>
    ),
    link: (
      <>
        <path
          d="m9 15 6-6M8 17l-1 1a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m0 10a4.2 4.2 0 0 0 6 0l5-5a4.2 4.2 0 0 0-6-6l-1 1"
          transform="translate(1 -1) scale(.9)"
        />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 4 16 4 16 0V5M4 10c0 4 16 4 16 0M4 15c0 4 16 4 16 0" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    bolt: <path d="m14 2-11 12h8l-1 8L21 9h-8Z" />,
    work: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
    code: <path d="m7 6-5 6 5 6M17 6l5 6-5 6M14 4l-4 16" />,
    check: <path d="m4 12 5 5L21 5" />,
    eye: (
      <>
        <path d="M2 12S6 5 12 5s10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function BrandMark({
  orbital = false,
  charge = true,
}: {
  orbital?: boolean;
  charge?: boolean;
}) {
  const ref = useOrbitalCharge(orbital, charge);
  return (
    <svg
      ref={ref}
      className={`brand-mark${orbital ? " orbital-brand" : ""}`}
      viewBox="0 0 40 40"
      aria-hidden="true"
    >
      <circle
        className="brand-ring"
        cx="20"
        cy="20"
        r="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeDasharray="69 13"
        transform="rotate(-30 20 20)"
      />
      {orbital ? (
        <>
          <circle
            className="orbital-ring-pulse ambient"
            cx="20"
            cy="20"
            r="13"
            fill="none"
            strokeWidth="4"
          />
          <g className="orbital-signal">
            <circle
              className="orbital-ghost ghost-far"
              cx="22.7"
              cy="7.28"
              r="1.3"
            />
            <circle
              className="orbital-ghost ghost-mid"
              cx="26.1"
              cy="8.52"
              r="1.8"
            />
            <circle
              className="orbital-ghost ghost-near"
              cx="29.02"
              cy="10.65"
              r="2.3"
            />
            <circle
              className="orbital-dot"
              cx="31.3"
              cy="13.5"
              r="3.4"
              fill="var(--text)"
            />
          </g>
        </>
      ) : (
        <circle cx="31.3" cy="13.5" r="3.4" fill="var(--text)" />
      )}
    </svg>
  );
}

const states = [
  "AGENT WORK",
  "PAYMENT INITIATED",
  "SETTLEMENT VERIFIED",
  "STATE PERSISTED",
  "CONTINUE WORKING",
];

export function StateStack() {
  return (
    <figure
      className="state-stack"
      aria-label="Payment progression: agent work, payment initiated, settlement verified, state persisted, continue working."
    >
      <svg viewBox="0 0 570 530" fill="none" aria-hidden="true">
        <defs>
          <linearGradient
            id="plane-fill"
            x1="290"
            y1="60"
            x2="450"
            y2="340"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#303030" stopOpacity=".34" />
            <stop offset="1" stopColor="#0a0a0a" stopOpacity=".85" />
          </linearGradient>
          <linearGradient id="plane-stroke">
            <stop stopColor="#b5afa5" stopOpacity=".7" />
            <stop offset=".5" stopColor="#c2ad92" stopOpacity=".26" />
            <stop offset="1" stopColor="#ff5a1f" stopOpacity=".6" />
          </linearGradient>
          <linearGradient
            id="axis"
            x1="393"
            y1="30"
            x2="393"
            y2="488"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#ff5a1f" stopOpacity="0" />
            <stop offset=".2" stopColor="#ff5a1f" />
            <stop offset=".85" stopColor="#ff5a1f" />
            <stop offset="1" stopColor="#ff5a1f" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="event-halo">
            <stop stopColor="#ff8a40" stopOpacity=".55" />
            <stop offset="1" stopColor="#ff5a1f" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d="M252 437 393 503 543 433" stroke="#454039" strokeWidth=".7" />
        <path d="M393 28v460" stroke="url(#axis)" strokeWidth="1" />
        {states.map((state, i) => {
          const y = 106 + i * 66;
          const lead = `M${i === 0 ? 153 : 187} ${y} H222 C273 ${y} 269 ${y + 43} 312 ${y + 43} H393`;
          const timing = { "--signal-delay": `${i * 0.56}s` } as CSSProperties;
          return (
            <g key={state}>
              <path className="stack-lead" d={lead} />
              <text x="4" y={y - 11} className="stack-label">
                {state}
              </text>
              <circle cx={i === 0 ? 153 : 187} cy={y} r="3" fill="#ff7335" />
              <path
                d={`M393 ${y - 36} L517 ${y + 20} Q526 ${y + 24} 517 ${y + 29} L402 ${y + 84} Q393 ${y + 88} 384 ${y + 84} L269 ${y + 29} Q260 ${y + 24} 269 ${y + 20} Z`}
                fill="url(#plane-fill)"
                stroke="url(#plane-stroke)"
                strokeWidth=".8"
              />
              <path
                d={`m269 ${y + 26} 124 59 124-59`}
                stroke="#ff6426"
                strokeOpacity=".28"
              />
              <circle cx="393" cy={y + 25} r="28" fill="url(#event-halo)" />
              <path d={`m386 ${y + 25} 7-4 7 4-7 4Z`} fill="#fff2da" />
              <path
                className="stack-input-signal ambient"
                d={lead}
                pathLength="100"
                style={timing}
              />
              <circle
                className="stack-emission ambient"
                cx={i === 0 ? 153 : 187}
                cy={y}
                r="7"
                style={timing}
              />
              <circle
                className="stack-convergence ambient"
                cx="393"
                cy={y + 43}
                r="16"
                fill="url(#event-halo)"
                style={timing}
              />
            </g>
          );
        })}
        <path d="M393 50v428" stroke="url(#axis)" strokeWidth="1.4" />
        <circle
          className="stack-traveler ambient"
          cx="393"
          cy="0"
          r="3.5"
          fill="#fff5e5"
        />
        <text x="4" y="492" className="stack-footnote">
          PAYMENT → EVIDENCE → CONTINUITY
        </text>
        <path d="M4 507h42" stroke="#ff5a1f" />
      </svg>
      <figcaption className="mono">
        A reliable boundary.
        <br />
        <span>A workflow that keeps going.</span>
      </figcaption>
    </figure>
  );
}
