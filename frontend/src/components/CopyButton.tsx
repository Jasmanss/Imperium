"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { cx } from "@/lib/cx";
import { CheckIcon, CopyIcon } from "./icons";
import { button } from "./ui";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    setState((await copyText(text)) ? "copied" : "failed");
  }

  return (
    <button type="button" onClick={copy} className={button("secondary", "sm", className)}>
      {state === "copied" ? (
        <CheckIcon className="h-4 w-4 text-ok" />
      ) : (
        <CopyIcon className={cx("h-4 w-4", state === "failed" && "text-danger")} />
      )}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}
