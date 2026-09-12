import { cx } from "@/lib/cx";
import type { Tone } from "@/lib/labels";

interface ToneClasses {
  text: string;
  badge: string;
  dot: string;
  fill: string;
  border: string;
  wash: string;
}

/** Class names for each semantic tone, written out in full so Tailwind can see them. */
export const TONE: Record<Tone, ToneClasses> = {
  neutral: {
    text: "text-neutral",
    badge: "border-neutral/25 bg-neutral/10 text-neutral",
    dot: "bg-neutral",
    fill: "fill-neutral",
    border: "border-neutral/30",
    wash: "bg-neutral/5",
  },
  act: {
    text: "text-act",
    badge: "border-act/30 bg-act/10 text-act",
    dot: "bg-act",
    fill: "fill-act",
    border: "border-act/35",
    wash: "bg-act/5",
  },
  danger: {
    text: "text-danger",
    badge: "border-danger/30 bg-danger/10 text-danger",
    dot: "bg-danger",
    fill: "fill-danger",
    border: "border-danger/35",
    wash: "bg-danger/5",
  },
  ok: {
    text: "text-ok",
    badge: "border-ok/30 bg-ok/10 text-ok",
    dot: "bg-ok",
    fill: "fill-ok",
    border: "border-ok/30",
    wash: "bg-ok/5",
  },
  blocked: {
    text: "text-blocked",
    badge: "border-blocked/30 bg-blocked/10 text-blocked",
    dot: "bg-blocked",
    fill: "fill-blocked",
    border: "border-blocked/35",
    wash: "bg-blocked/5",
  },
  pending: {
    text: "text-pending",
    badge: "border-pending/30 bg-pending/10 text-pending",
    dot: "bg-pending",
    fill: "fill-pending",
    border: "border-pending/35",
    wash: "bg-pending/5",
  },
  muted: {
    text: "text-muted",
    badge: "border-muted/30 bg-muted/10 text-muted",
    dot: "bg-muted",
    fill: "fill-muted",
    border: "border-muted/30",
    wash: "bg-muted/5",
  },
};

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-fg text-ground hover:bg-white disabled:hover:bg-fg",
  secondary: "border border-line-strong bg-control text-fg hover:bg-hover disabled:hover:bg-control",
  ghost: "text-fg-muted hover:bg-control hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted",
  danger: "bg-danger text-black hover:bg-danger/85 disabled:hover:bg-danger",
};

/** Buttons keep a 44px touch target on touch screens and tighten up under a mouse. */
export function button(variant: ButtonVariant = "secondary", size: "md" | "sm" = "md", extra?: string): string {
  return cx(
    "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
    size === "md" ? "min-h-11 px-4 text-[14px]" : "min-h-11 px-3 text-[13px] pointer-fine:min-h-8",
    BUTTON_VARIANTS[variant],
    extra,
  );
}

export function chip(active: boolean, extra?: string): string {
  return cx(
    "inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium transition-colors duration-150 pointer-fine:min-h-9",
    active
      ? "border-fg bg-fg text-ground"
      : "border-line-strong bg-panel text-fg-muted hover:border-fg-faint hover:text-fg",
    extra,
  );
}

export const INPUT =
  "min-h-11 w-full min-w-0 rounded-lg border border-line-strong bg-raised px-3 text-base text-fg placeholder:text-fg-faint transition-colors hover:border-fg-faint focus:border-fg-muted";
