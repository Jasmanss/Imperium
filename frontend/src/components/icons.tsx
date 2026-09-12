import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ className, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? "h-5 w-5"}
      {...props}
    >
      {children}
    </svg>
  );
}

export function PromptIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 7l5 5-5 5" />
      <path d="M13 17h6" />
    </Icon>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h4l2.5-6.5 5 13L17 12h4" />
    </Icon>
  );
}

export function LedgerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </Icon>
  );
}

export function BarsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 20.5h17" />
      <path d="M6.5 17v-6M11.5 17V5M16.5 17v-9" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4M12 16.8v.2" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.9-7 9-4.1-1.1-7-4.7-7-9V6.3z" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" />
    </Icon>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.5 12a7.5 7.5 0 11-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </Icon>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 19.5h3.8L19 8.8 15.2 5 4.5 15.7z" />
      <path d="M13 7.2l3.8 3.8" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 6l6 6-6 6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9.5l6 6 6-6" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 5.5v13M15 5.5v13" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.5l11 6.5-11 6.5z" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </Icon>
  );
}

export function WrenchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.8 5.2a4.2 4.2 0 00-5.6 5.3L4 15.7 8.3 20l5.2-5.2a4.2 4.2 0 005.3-5.6l-2.6 2.6-2.8-.5-.5-2.8z" />
    </Icon>
  );
}

export function QrIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 14a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5l-1 1" />
      <path d="M14 10a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5l1-1" />
    </Icon>
  );
}

/** The Imperium mark: a prompt and a cursor in a console key. */
export function ImperiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" focusable="false" className={className ?? "h-7 w-7"}>
      <rect x="0.75" y="0.75" width="26.5" height="26.5" rx="7" className="fill-raised stroke-line-strong" strokeWidth="1.5" />
      <path
        d="M8.5 9.5l4.5 4.5-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="17" width="5.5" height="2.2" rx="1.1" className="fill-ok" />
    </svg>
  );
}
