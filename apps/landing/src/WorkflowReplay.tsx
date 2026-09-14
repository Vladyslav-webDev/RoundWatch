import { useEffect, useRef, useState } from "react";
import { Icon } from "./graphics";

const events = [
  {
    time: "10:24:01",
    source: "agent",
    message: "Task completed",
    state: "Work complete",
  },
  {
    time: "10:24:02",
    source: "payment",
    message: "x402 payment initiated",
    state: "Payment pending",
  },
  {
    time: "10:24:05",
    source: "observer",
    message: "Transaction detected",
    state: "Evidence observed",
  },
  {
    time: "10:24:08",
    source: "settlement",
    message: "Settlement verified",
    state: "Settlement verified",
  },
  {
    time: "10:24:08",
    source: "state",
    message: "Evidence persisted",
    state: "State persisted",
  },
  {
    time: "10:24:09",
    source: "workflow",
    message: "Continuation unlocked",
    state: "Ready to continue",
  },
];

export default function WorkflowReplay({
  reducedMotion,
}: {
  reducedMotion: boolean;
}) {
  const [count, setCount] = useState(events.length);
  const [playing, setPlaying] = useState(false);
  const playbackControl = useRef<HTMLButtonElement>(null);
  const replayControl = useRef<HTMLButtonElement>(null);
  const complete = count === events.length;

  function advance() {
    if (
      count === events.length - 1 &&
      document.activeElement === playbackControl.current
    ) {
      replayControl.current?.focus();
    }
    setCount((value) => Math.min(value + 1, events.length));
  }

  useEffect(() => {
    if (!playing || complete || reducedMotion) return;
    const timer = window.setTimeout(advance, 1250);
    return () => window.clearTimeout(timer);
  }, [count, playing, complete, reducedMotion]);

  function replay() {
    setCount(1);
    setPlaying(!reducedMotion);
  }

  return (
    <div className="replay-shell">
      <div className="terminal">
        <div className="terminal-bar">
          <span className="mono">
            <i className="signal-dot" />
            Workflow replay
          </span>
          <span className="mono terminal-network">Algorand TestNet</span>
        </div>
        <div className="terminal-content">
          <ol className="event-list" aria-label="Illustrative workflow events">
            {events.map((event, index) => (
              <li
                key={event.source}
                className={`event ${index < count ? "event-shown" : ""} ${index === count - 1 ? "event-current" : ""}`}
                aria-hidden={index >= count}
              >
                <span className="event-time">{event.time}</span>
                <span className="event-source">[{event.source}]</span>
                <span className="event-message">
                  {event.message}
                  {index === 3 && <Icon name="check" />}
                </span>
              </li>
            ))}
          </ol>
          <div className="terminal-result">
            <span className="mono">
              {complete ? "Evidence ready" : "Processing replay"}
            </span>
            <Icon name={complete ? "check" : "eye"} />
            <p>
              {complete ? (
                <>
                  Verified.
                  <br />
                  Persisted.
                  <br />
                  <em>Ready for what’s next.</em>
                </>
              ) : (
                <>
                  From payment
                  <br />
                  to trusted
                  <br />
                  <em>state.</em>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="replay-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${count / events.length})` }} />
        </div>
        <div className="terminal-controls">
          <p role="status" className="mono">
            {String(count).padStart(2, "0")} / 06{" "}
            <span>{events[count - 1].state}</span>
          </p>
          <div className="replay-buttons">
            {!complete && (
              <button
                ref={playbackControl}
                className="text-control"
                onClick={() =>
                  reducedMotion
                    ? advance()
                    : setPlaying((value) => !value)
                }
              >
                <Icon
                  name={reducedMotion ? "arrow" : playing ? "pause" : "play"}
                />
                {reducedMotion ? "Next event" : playing ? "Pause" : "Resume"}
              </button>
            )}
            <button ref={replayControl} className="text-control" onClick={replay}>
              <Icon name="replay" />
              Replay<span className="desktop-word"> workflow</span>
            </button>
          </div>
        </div>
      </div>
      <p className="replay-note">
        Illustrative sequence based on verified prototype behavior. No live
        connection or payment is made.
      </p>
    </div>
  );
}
