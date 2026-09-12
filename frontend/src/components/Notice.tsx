import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { AlertIcon, RetryIcon } from "./icons";
import { button } from "./ui";

/** A quiet placeholder for a list or screen with nothing to show yet. */
export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("rounded-xl border border-dashed border-line-strong px-5 py-10 text-center sm:py-14", className)}>
      <p className="text-[15px] font-medium text-fg">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-sm text-[14px] leading-6 text-fg-muted">{children}</div>}
    </div>
  );
}

/** A load failure, shown as text, with an optional retry. */
export function ErrorNotice({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-danger/35 bg-danger/5 px-4 py-3",
        className,
      )}
    >
      <p className="flex min-w-0 gap-2 text-[14px] leading-5 text-danger">
        <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={button("secondary", "sm")}>
          <RetryIcon className="h-4 w-4" />
          Try again
        </button>
      )}
    </div>
  );
}
