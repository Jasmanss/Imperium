import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.02em] text-fg sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-prose text-[14px] leading-6 text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The standard page column; bottom padding clears the mobile tab bar. */
export function PageBody({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={
        wide
          ? "mx-auto w-full max-w-6xl px-page pt-6 pb-page sm:px-6 lg:px-10 lg:pt-10 lg:pb-14"
          : "mx-auto w-full max-w-3xl px-page pt-6 pb-page sm:px-6 lg:px-10 lg:pt-10 lg:pb-14"
      }
    >
      {children}
    </div>
  );
}
