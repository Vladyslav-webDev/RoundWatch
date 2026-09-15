import { useEffect, useRef } from "react";
import { useMotion } from "./motion";

type MotionState = { paused: boolean; reducedMotion: boolean; hidden: boolean };
type Orbit = {
  element: SVGSVGElement;
  animation: Animation;
  velocity: number;
  target: number;
};

// Native animation owns rotation and phase. One shared frame loop only runs
// while a visible identity mark is accelerating or coasting back to idle.
const changing = new Set<Orbit>();
let frame = 0;
let previousTime = 0;

const idleVelocity = 1; // One revolution every ten seconds.
const maximumVelocity = 72; // 7.2 revolutions per second at full charge.
const acceleration = 25.36; // ~2.8 seconds from idle to maximum.
const deceleration = 17.75; // ~4 seconds to coast back to idle.
const touchChargeDuration = 3600; // One tap charges, then releases automatically.

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ramp(value: number, start: number, end: number) {
  return clamp((value - start) / (end - start));
}

function paintEnergy(orbit: Orbit) {
  const energy = clamp(
    (orbit.velocity - idleVelocity) / (maximumVelocity - idleVelocity),
  );

  // The logo should read as acceleration first. The ring only begins to charge
  // after the point is already moving noticeably faster than idle.
  const charge = ramp(energy, 0.52, 1);
  const ghosts = ramp(energy, 0.66, 0.98);
  const glow = ramp(energy, 0.78, 1);
  const pulse = ramp(energy, 0.93, 1);

  const orange = [255, 100, 45];
  const warmWhite = [245, 243, 238];
  const ring = orange.map(
    (channel, index) =>
      channel + (warmWhite[index] - channel) * charge,
  );

  orbit.element.style.setProperty(
    "--orbital-ring",
    `rgb(${ring.map(Math.round).join(" ")})`,
  );
  orbit.element.style.setProperty("--orbital-ghost", String(ghosts));
  orbit.element.style.setProperty("--orbital-glow", `${glow * 5.5}px`);
  orbit.element.style.setProperty("--orbital-dot-glow", `${glow * 4}px`);
  orbit.element.style.setProperty("--orbital-pulse", String(pulse * 0.5));
}

function tick(time: number) {
  const elapsed = previousTime
    ? Math.min((time - previousTime) / 1000, 0.05)
    : 0;
  previousTime = time;

  for (const orbit of changing) {
    if (orbit.target > orbit.velocity) {
      orbit.velocity = Math.min(
        orbit.target,
        orbit.velocity + acceleration * elapsed,
      );
    } else {
      orbit.velocity = Math.max(
        orbit.target,
        orbit.velocity - deceleration * elapsed,
      );
    }

    if (Math.abs(orbit.target - orbit.velocity) < 0.006) {
      orbit.velocity = orbit.target;
      changing.delete(orbit);
    }

    // updatePlaybackRate preserves phase, so leaving never snaps the point.
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

export function useOrbitalCharge(enabled: boolean, chargeEnabled = true) {
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
    animation.updatePlaybackRate(idleVelocity);

    const orbit: Orbit = {
      element: mark,
      animation,
      velocity: idleVelocity,
      target: idleVelocity,
    };

    let visible = !("IntersectionObserver" in window);
    let pointer = false;
    let touchCharging = false;
    let touchTimer: number | null = null;
    let motionState = currentMotion.current;
    let finePointer = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
    const pointerQuery = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    );
    const trigger = mark.closest("a, button, [data-orbital-trigger]") ?? mark;

    function synchronize() {
      const charging =
        chargeEnabled && ((finePointer && pointer) || touchCharging);
      orbit.target = charging ? maximumVelocity : idleVelocity;

      const stopped =
        !visible ||
        motionState.paused ||
        motionState.reducedMotion ||
        motionState.hidden;

      mark.dataset.orbitalStopped = String(stopped);
      mark.dataset.orbitalActive = String(charging);

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

    function clearTouchCharge() {
      if (touchTimer !== null) {
        window.clearTimeout(touchTimer);
        touchTimer = null;
      }
      if (touchCharging) {
        touchCharging = false;
        synchronize();
      }
    }

    const enter = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      if (!finePointer || pointerEvent.pointerType === "touch") return;
      pointer = true;
      synchronize();
    };
    const leave = () => {
      pointer = false;
      synchronize();
    };
    const tapCharge = (event: Event) => {
      if (
        !chargeEnabled ||
        finePointer ||
        motionState.paused ||
        motionState.reducedMotion ||
        motionState.hidden
      )
        return;

      // On touch devices the mark itself is the interaction target. Prevent the
      // surrounding brand link from navigating for this tap; tapping the brand
      // text still behaves like the normal link.
      event.preventDefault();
      event.stopPropagation();

      if (touchTimer !== null) window.clearTimeout(touchTimer);
      touchCharging = true;
      synchronize();
      touchTimer = window.setTimeout(() => {
        touchTimer = null;
        touchCharging = false;
        synchronize();
      }, touchChargeDuration);
    };
    const pointerModeChanged = (event: MediaQueryListEvent) => {
      finePointer = event.matches;
      if (!finePointer) pointer = false;
      if (finePointer) clearTouchCharge();
      synchronize();
    };

    if (chargeEnabled) {
      trigger.addEventListener("pointerenter", enter);
      trigger.addEventListener("pointerleave", leave);
      mark.addEventListener("click", tapCharge);
      pointerQuery.addEventListener("change", pointerModeChanged);
    }

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
      if (next.paused || next.reducedMotion || next.hidden) clearTouchCharge();
      synchronize();
    };

    paintEnergy(orbit);
    synchronize();

    return () => {
      clearTouchCharge();
      rest(orbit);
      animation.cancel();
      observer?.disconnect();
      if (chargeEnabled) {
        trigger.removeEventListener("pointerenter", enter);
        trigger.removeEventListener("pointerleave", leave);
        mark.removeEventListener("click", tapCharge);
        pointerQuery.removeEventListener("change", pointerModeChanged);
      }
      updateMotion.current = null;
      for (const variable of [
        "--orbital-ring",
        "--orbital-ghost",
        "--orbital-glow",
        "--orbital-dot-glow",
        "--orbital-pulse",
      ])
        mark.style.removeProperty(variable);
      delete mark.dataset.orbitalStopped;
      delete mark.dataset.orbitalActive;
    };
  }, [enabled, chargeEnabled]);

  useEffect(() => {
    updateMotion.current?.(motion);
  }, [motion.paused, motion.reducedMotion, motion.hidden]);

  return element;
}
