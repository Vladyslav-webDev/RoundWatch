import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode, RefObject } from "react";

const MotionContext = createContext({
  paused: false,
  reducedMotion: false,
  hidden: false,
  togglePaused: () => {},
});

export function MotionProvider({ children }: { children: ReactNode }) {
  // Keep the first client render identical to the complete prerendered page.
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(preference.matches);
    const updateVisibility = () => setHidden(document.hidden);
    updatePreference();
    updateVisibility();
    preference.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      preference.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  const value = useMemo(
    () => ({
      paused,
      reducedMotion,
      hidden,
      togglePaused: () => setPaused((previous) => !previous),
    }),
    [paused, reducedMotion, hidden],
  );
  return (
    <MotionContext.Provider value={value}>{children}</MotionContext.Provider>
  );
}

export const useMotion = () => useContext(MotionContext);

export function useFirstEntry(ref: RefObject<HTMLElement | null>) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      // Leave the prerendered complete story available without timed playback.
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.28,
          )
        ) {
          setEntered(true);
          observer.disconnect();
        }
      },
      { threshold: 0.28, rootMargin: "0px 0px -6% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return entered;
}

export function useInView(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}
