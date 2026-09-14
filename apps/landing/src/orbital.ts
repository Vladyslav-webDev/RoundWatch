import { useEffect, useRef } from "react";
import { useMotion } from "./motion";

type MotionState = { paused: boolean; reducedMotion: boolean; hidden: boolean };
type Orbit = {
  element: SVGSVGElement;
  animation: Animation;
  velocity: number;
  target: number;
};

// Native animation owns rotation and phase. This one shared frame loop exists
// only while a visible identity mark is gaining or shedding angular velocity.
const changing = new Set<Orbit>();
let frame = 0;
let previousTime = 0;
const idleVelocity = 1; // One revolution every ten seconds.
const maximumVelocity = 9; // 0.9 revolutions per second; brightness adds energy.

function paintEnergy(orbit: Orbit) {
  const energy =
    (orbit.velocity - idleVelocity) / (maximumVelocity - idleVelocity);
  const warm = Math.max(0, Math.min(1, energy));
  const ring = [255 - warm * 10, 100 + warm * 143, 45 + warm * 193];
  orbit.element.style.setProperty(
    "--orbital-ring",
    `rgb(${ring.map(Math.round).join(" ")})`,
  );
  orbit.element.style.setProperty("--orbital-trail", String(warm * 0.68));
  orbit.element.style.setProperty("--orbital-glow", `${warm * 2.6}px`);
  orbit.element.style.setProperty(
    "--orbital-pulse",
    String(Math.max(0, (warm - 0.8) * 0.9)),
  );
}

function tick(time: number) {
  const elapsed = previousTime
    ? Math.min((time - previousTime) / 1000, 0.05)
    : 0;
  previousTime = time;
  for (const orbit of changing) {
    const response = orbit.target > orbit.velocity ? 1.45 : 1.8;
    orbit.velocity +=
      (orbit.target - orbit.velocity) * (1 - Math.exp(-elapsed / response));
    if (Math.abs(orbit.target - orbit.velocity) < 0.006) {
      orbit.velocity = orbit.target;
      changing.delete(orbit);
    }
    // updatePlaybackRate preserves currentTime: leaving never snaps the point.
    orbit.animation.updatePlaybackRate(orbit.velocity);
    paintEnergy(orbit);
  }
  frame = changing.size ? requestAnimationFrame(tick) : 0;
  if (!frame) previousTime = 0;
}

function wake(orbit: Orbit) {
  if (Math.abs(orbit.target - orbit.velocity) < 0.006) return;
  changing.add(orbit);
  if (!frame) frame = requestAnimationFrame(tick);
}

function rest(orbit: Orbit) {
  changing.delete(orbit);
  if (!changing.size && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }
}

export function useOrbitalCharge(enabled: boolean) {
  const element = useRef<SVGSVGElement>(null);
  const motion = useMotion();
  const currentMotion = useRef<MotionState>(motion);
  const updateMotion = useRef<((next: MotionState) => void) | null>(null);
  currentMotion.current = motion;

  useEffect(() => {
    const node = element.current;
    if (!enabled || !node) return;
    const mark: SVGSVGElement = node;
    const signal = mark.querySelector<SVGGElement>(".orbital-signal");
    if (!signal || typeof signal.animate !== "function") return;
    const animation = signal.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 10000, iterations: Infinity, easing: "linear" },
    );
    animation.pause();
    const orbit: Orbit = {
      element: mark,
      animation,
      velocity: idleVelocity,
      target: idleVelocity,
    };
    let visible = !("IntersectionObserver" in window);
    let pointer = false;
    let focused = false;
    let motionState = currentMotion.current;
    const trigger = mark.closest("a, button, [data-orbital-trigger]") ?? mark;

    function synchronize() {
      orbit.target = pointer || focused ? maximumVelocity : idleVelocity;
      const stopped =
        !visible ||
        motionState.paused ||
        motionState.reducedMotion ||
        motionState.hidden;
      mark.dataset.orbitalStopped = String(stopped);
      mark.dataset.orbitalActive = String(pointer || focused);
      if (stopped) {
        animation.pause();
        rest(orbit);
        if (motionState.reducedMotion) {
          orbit.velocity = idleVelocity;
          animation.updatePlaybackRate(idleVelocity);
          paintEnergy(orbit);
        }
      } else {
        animation.play();
        wake(orbit);
      }
    }

    const enter = (event: Event) => {
      if ((event as PointerEvent).pointerType === "touch") return;
      pointer = true;
      synchronize();
    };
    const leave = () => {
      pointer = false;
      synchronize();
    };
    const focus = () => {
      focused = true;
      synchronize();
    };
    const blur = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget;
      if (next instanceof Node && trigger.contains(next)) return;
      focused = false;
      synchronize();
    };
    trigger.addEventListener("pointerenter", enter);
    trigger.addEventListener("pointerleave", leave);
    trigger.addEventListener("focusin", focus);
    trigger.addEventListener("focusout", blur);
    focused = trigger.contains(document.activeElement);
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            synchronize();
          })
        : null;
    observer?.observe(mark);
    updateMotion.current = (next) => {
      motionState = next;
      synchronize();
    };
    synchronize();

    return () => {
      rest(orbit);
      animation.cancel();
      observer?.disconnect();
      trigger.removeEventListener("pointerenter", enter);
      trigger.removeEventListener("pointerleave", leave);
      trigger.removeEventListener("focusin", focus);
      trigger.removeEventListener("focusout", blur);
      updateMotion.current = null;
      for (const variable of [
        "--orbital-ring",
        "--orbital-trail",
        "--orbital-glow",
        "--orbital-pulse",
      ])
        mark.style.removeProperty(variable);
      delete mark.dataset.orbitalStopped;
      delete mark.dataset.orbitalActive;
    };
  }, [enabled]);

  useEffect(() => {
    updateMotion.current?.(motion);
  }, [motion.paused, motion.reducedMotion, motion.hidden]);
  return element;
}
