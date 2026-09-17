import { useEffect, useRef, useState } from "react";
import { Icon } from "./graphics";
import { useFirstEntry, useInView, useMotion } from "./motion";
import "./narrative-motion.css";

const events = [
  {
    time: "10:24:01",
    source: "watch",
    message: "Exact future payment defined",
    state: "Watch specified",
    signal: "Defined",
    heading: ["Watch defined.", "Waiting for", "service settlement."],
    icon: "eye",
  },
  {
    time: "10:24:02",
    source: "x402",
    message: "Service payment requirements accepted",
    state: "Settlement pending",
    signal: "x402",
    heading: ["Service fee accepted.", "Settlement", "to establish."],
    icon: "code",
  },
  {
    time: "10:24:05",
    source: "settlement",
    message: "x402 service payment settled",
    state: "Settlement verified",
    signal: "Verified",
    heading: ["Settlement verified.", "Safe round", "to persist."],
    icon: "shield",
  },
  {
    time: "10:24:08",
    source: "state",
    message: "Watch activated from safe round",
    state: "Watch active",
    signal: "Active",
    heading: ["Watch activated.", "Caller may", "exit now."],
    icon: "database",
  },
  {
    time: "10:25:11",
    source: "observer",
    message: "Exact future USDC payment matched",
    state: "Payment matched",
    signal: "Matched",
    heading: ["Payment matched.", "Transaction", "evidence found."],
    icon: "eye",
  },
  {
    time: "10:25:11",
    source: "evidence",
    message: "Transaction ID and round persisted",
    state: "Durable evidence ready",
    signal: "Ready",
    heading: ["Matched.", "Persisted.", "Ready to retrieve."],
    icon: "check",
  },
] as const;

export default function WorkflowReplay() {
  const { paused, reducedMotion, hidden } = useMotion();
  // Full content is present in prerendered HTML and remains the static fallback.
  const [count, setCount] = useState<number>(events.length);
  const [playing, setPlaying] = useState(false);
  const [userControlled, setUserControlled] = useState(false);
  const [run, setRun] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const shell = useRef<HTMLDivElement>(null);
  const entered = useFirstEntry(shell);
  const visible = useInView(shell);
  const autoplayHandled = useRef(false);
  const userInteracted = useRef(false);
  const timedStep = useRef<number | null>(null);
  const remaining = useRef(600);
  const playbackControl = useRef<HTMLButtonElement>(null);
  const replayControl = useRef<HTMLButtonElement>(null);
  const playbackFocused = useRef(false);
  const shownCount = reducedMotion ? events.length : count;
  const complete = shownCount === events.length;
  const current = shownCount > 0 ? events[shownCount - 1] : null;

  useEffect(() => {
    if (reducedMotion) {
      autoplayHandled.current = true;
      if (playbackFocused.current) replayControl.current?.focus();
      setCount(events.length);
      setPlaying(false);
    }
  }, [reducedMotion]);

  useEffect(() => {
    if (
      !entered ||
      !visible ||
      paused ||
      reducedMotion ||
      hidden ||
      autoplayHandled.current ||
      userInteracted.current
    )
      return;
    autoplayHandled.current = true;
    timedStep.current = null;
    setCount(0);
    setPlaying(true);
  }, [entered, visible, paused, reducedMotion, hidden]);

  useEffect(() => {
    if (timedStep.current !== count) {
      timedStep.current = count;
      remaining.current = count === 0 ? 600 : 1250;
    }
    if (!playing || complete || paused || reducedMotion || hidden || !visible)
      return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      if (
        count === events.length - 1 &&
        document.activeElement === playbackControl.current
      )
        replayControl.current?.focus();
      setCount((value) => Math.min(value + 1, events.length));
      if (count === events.length - 1) {
        setPlaying(false);
        if (!userControlled)
          setAnnouncement(
            "Workflow replay complete. Watch activated, future payment matched, durable evidence ready.",
          );
      }
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - startedAt),
      );
    };
  }, [
    count,
    playing,
    complete,
    paused,
    reducedMotion,
    hidden,
    visible,
    run,
    userControlled,
  ]);

  function markInteraction() {
    userInteracted.current = true;
    autoplayHandled.current = true;
  }

  function replay() {
    markInteraction();
    setUserControlled(true);
    setAnnouncement("");
    timedStep.current = null;
    setCount(reducedMotion || paused ? events.length : 0);
    setPlaying(!reducedMotion && !paused);
    setRun((value) => value + 1);
  }

  return (
    <div
      ref={shell}
      className="replay-shell"
      data-replay-state={current?.signal.toLowerCase() ?? "waiting"}
      data-replay-running={
        playing && !paused && !hidden && visible && !reducedMotion
      }
      onPointerDownCapture={markInteraction}
      onFocusCapture={markInteraction}
    >
      <div className="terminal">
        <div className="terminal-bar">
          <span className="mono">
            <i className="signal-dot" />
            Workflow replay
          </span>
          <span className="mono terminal-network">Algorand MainNet</span>
        </div>
        <div className="terminal-content">
          <ol className="event-list" aria-label="Illustrative workflow events">
            {events.map((event, index) => (
              <li
                key={event.source}
                className={`event ${index < shownCount ? "event-shown" : ""} ${index === shownCount - 1 ? "event-current" : ""}`}
                aria-hidden={index >= shownCount}
              >
                <span className="event-time">{event.time}</span>
                <span className="event-source">[{event.source}]</span>
                <span className="event-message">
                  {event.message}
                  {index === 2 && <Icon name="check" />}
                </span>
              </li>
            ))}
          </ol>
          <div className="terminal-result">
            <span className="mono">{current?.signal ?? "Waiting"}</span>
            <div className="replay-state-body" key={shownCount}>
              <Icon name={current?.icon ?? "eye"} />
              <p>
                {current?.heading[0] ?? "From a watch"}
                <br />
                {current?.heading[1] ?? "to exact"}
                <br />
                <em>{current?.heading[2] ?? "evidence."}</em>
              </p>
            </div>
          </div>
        </div>
        <div className="replay-progress" aria-hidden="true">
          <span
            style={{ transform: `scaleX(${shownCount / events.length})` }}
          />
        </div>
        <div className="terminal-controls">
          <p
            className="mono"
            aria-live={userControlled ? "polite" : "off"}
            aria-atomic="true"
          >
            {String(shownCount).padStart(2, "0")} / 06{" "}
            <span>{current?.state ?? "Waiting for replay"}</span>
          </p>
          <div className="replay-buttons">
            {!complete && (
              <button
                ref={playbackControl}
                className="text-control"
                onFocus={() => {
                  playbackFocused.current = true;
                }}
                onBlur={() => {
                  playbackFocused.current = false;
                }}
                onClick={() => {
                  markInteraction();
                  setUserControlled(true);
                  if (paused) {
                    // A reader can inspect the complete sequence without
                    // re-enabling motion or losing a paused stage by accident.
                    replayControl.current?.focus();
                    setCount(events.length);
                    setPlaying(false);
                  } else {
                    setPlaying((value) => !value);
                  }
                }}
              >
                <Icon name={paused ? "arrow" : playing ? "pause" : "play"} />
                {paused ? "Show all events" : playing ? "Pause" : "Resume"}
              </button>
            )}
            <button
              ref={replayControl}
              className="text-control"
              onClick={replay}
            >
              <Icon name="replay" />
              Replay<span className="desktop-word"> workflow</span>
            </button>
          </div>
        </div>
      </div>
      <p className="replay-note">
        Illustrative sequence based on the verified MainNet flow. No live
        connection or payment is made.
      </p>
      <p className="narrative-announcement" role="status">
        {announcement}
      </p>
    </div>
  );
}
