import { useEffect, useRef, useState } from "react";
import { Icon } from "./graphics";
import { useFirstEntry, useInView, useMotion } from "./motion";

const stages = [
  { label: "Payment expected", state: "expecting", note: "", duration: 1050 },
  {
    label: "Scan progress saved",
    state: "saved",
    note: "Saved",
    duration: 1100,
  },
  {
    label: "Server stops",
    state: "offline",
    note: "Process offline",
    duration: 1550,
  },
  { label: "Server starts", state: "starting", note: "", duration: 1050 },
  {
    label: "State restored",
    state: "restored",
    note: "Recovered",
    duration: 1150,
  },
  { label: "Observation resumes", state: "resuming", note: "", duration: 1300 },
  {
    label: "Future payment detected",
    state: "matched",
    note: "Matched",
    duration: 0,
  },
] as const;

export default function Resilience() {
  const { paused, reducedMotion, hidden } = useMotion();
  const diagram = useRef<HTMLDivElement>(null);
  const entered = useFirstEntry(diagram);
  const visible = useInView(diagram);
  // The finished story is readable before hydration, with JavaScript disabled,
  // or when motion is disabled before the observer reaches this section.
  const [phase, setPhase] = useState<number>(stages.length - 1);
  const [started, setStarted] = useState(false);
  const handled = useRef(false);
  const timedPhase = useRef<number | null>(null);
  const remaining = useRef(0);
  const shownPhase = reducedMotion ? stages.length - 1 : phase;

  useEffect(() => {
    if (reducedMotion) {
      handled.current = true;
      setPhase(stages.length - 1);
    }
  }, [reducedMotion]);

  useEffect(() => {
    if (
      !entered ||
      !visible ||
      paused ||
      reducedMotion ||
      hidden ||
      handled.current
    )
      return;
    handled.current = true;
    setStarted(true);
    setPhase(0);
  }, [entered, visible, paused, reducedMotion, hidden]);

  useEffect(() => {
    if (timedPhase.current !== phase) {
      timedPhase.current = phase;
      remaining.current = stages[phase].duration;
    }
    if (
      !started ||
      phase === stages.length - 1 ||
      paused ||
      reducedMotion ||
      hidden ||
      !visible
    )
      return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      setPhase((value) => Math.min(value + 1, stages.length - 1));
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - startedAt),
      );
    };
  }, [phase, started, paused, reducedMotion, hidden, visible]);

  return (
    <section
      className="section resilience"
      data-reveal
      aria-labelledby="resilience-title"
    >
      <div className="resilience-copy">
        <p className="eyebrow">
          <span>05</span>
          <span className="eyebrow-slash">/</span>Resilience
        </p>
        <h2 id="resilience-title">
          Restart the server.
          <br />
          <span className="orange-text">Keep the truth.</span>
        </h2>
        <p>A process can stop. Its evidence shouldn’t disappear with it.</p>
        <p>
          RoundWatch restores durable state and resumes from saved observation
          progress. A future payment can still be detected after restart.
        </p>
        <span className="proof-note mono">
          <Icon name="check" />
          Verified with a real process restart
          <br />
          on Algorand TestNet
        </span>
      </div>
      <div
        ref={diagram}
        className="restart-diagram restart-story"
        data-story-phase={stages[shownPhase].state}
        data-story-started={started && !reducedMotion}
        data-story-running={
          started &&
          shownPhase < stages.length - 1 &&
          visible &&
          !paused &&
          !hidden &&
          !reducedMotion
        }
      >
        <p className="mono diagram-label">Process changes. Evidence remains.</p>
        <ol className="restart-timeline">
          {stages.map((item, i) => (
            <li
              key={item.state}
              data-stage-state={
                i < shownPhase
                  ? "past"
                  : i === shownPhase
                    ? "current"
                    : "future"
              }
              className={
                i === 2
                  ? "restart-stop"
                  : i === 3
                    ? "restart-start"
                    : i === 6
                      ? "restart-detected"
                      : ""
              }
            >
              <span className="restart-node" aria-hidden="true">
                {i === 2 ? "×" : i === 6 ? <Icon name="check" /> : ""}
              </span>
              <span>{item.label}</span>
              <small className="mono">{item.note}</small>
              {i !== 2 && i !== stages.length - 1 && (
                <i className="restart-signal ambient" aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
        <span className="persistent-bridge mono">Durable state</span>
      </div>
    </section>
  );
}
