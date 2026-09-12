"use client";

import { useEffect } from "react";

/** How much of the layout viewport the software keyboard covers, in CSS pixels. */
export function keyboardInset(view: VisualViewport, layoutHeight: number): number {
  const covered = layoutHeight - view.height - view.offsetTop;
  // Rounding noise and rubber-band scrolling both produce small values that are
  // not a keyboard; anything under a tenth of the screen is treated as none.
  return covered > layoutHeight / 10 ? Math.round(covered) : 0;
}

/**
 * Publishes the keyboard's height as `--keyboard-inset` on the document element.
 *
 * `interactive-widget=resizes-content` (set in the root layout's viewport) makes
 * Chrome shrink the layout viewport, which is enough on Android. iOS Safari
 * ignores it and shrinks only the visual viewport, so a bar fixed to the bottom
 * of the layout viewport ends up behind the keyboard; this measures the gap so
 * the bar can sit above it. Where the layout viewport did shrink, the gap is 0
 * and nothing moves twice.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement;

    const update = () => {
      const inset = keyboardInset(view, root.clientHeight);
      root.style.setProperty("--keyboard-inset", `${inset}px`);
    };

    update();
    view.addEventListener("resize", update);
    view.addEventListener("scroll", update);
    return () => {
      view.removeEventListener("resize", update);
      view.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
