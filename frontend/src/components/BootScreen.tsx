import { ImperiumMark } from "./icons";

/** Shown until the browser has read its stored pairing; fades in only if that is slow. */
export function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ground">
      <div className="animate-appear-late flex items-center gap-2.5 text-fg-faint">
        <ImperiumMark className="h-7 w-7" />
        <span className="wordmark">Imperium</span>
      </div>
    </div>
  );
}
