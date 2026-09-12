/**
 * Incremental Server-Sent Events parser, following the WHATWG HTML event-stream
 * interpretation rules.
 *
 * EventSource cannot send an Authorization header, so the app reads /events
 * with fetch and feeds decoded text to this parser chunk by chunk. Chunks can
 * split anywhere: inside a field, between CR and LF of a CRLF pair, or between
 * the two line breaks that end an event.
 */

export interface SSEMessage {
  /** The event type, "message" when the frame had no event field. */
  event: string;
  /** Data lines joined with "\n". */
  data: string;
  /** The id field of this frame, or null when the frame had none. */
  id: string | null;
  /** The stream's last event ID after this frame (ids persist across frames, per spec). */
  lastEventId: string;
}

export interface SSEHandlers {
  onMessage: (message: SSEMessage) => void;
  onComment?: (text: string) => void;
  onRetry?: (milliseconds: number) => void;
}

export interface SSEParser {
  /** Feed the next piece of decoded text. */
  feed: (chunk: string) => void;
  readonly lastEventId: string;
}

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;
const BOM = 0xfeff;

export function createSSEParser(handlers: SSEHandlers): SSEParser {
  let buffer = "";
  let started = false;
  // The previous chunk ended with CR, so an LF at the start of the next chunk
  // belongs to the same line break.
  let skipLeadingLF = false;

  let data = "";
  let eventType = "";
  let frameId: string | null = null;
  // The spec's "last event ID buffer": set by an id field, and copied to the
  // stream's last event ID only when a frame is dispatched, so an id in a frame
  // cut off by a dropped connection never counts as received.
  let lastEventIdBuffer = "";
  let lastEventId = "";

  function dispatch(): void {
    lastEventId = lastEventIdBuffer;
    const id = frameId;
    frameId = null;
    if (data === "") {
      eventType = "";
      return;
    }
    const message: SSEMessage = {
      event: eventType || "message",
      data: data.charCodeAt(data.length - 1) === LF ? data.slice(0, -1) : data,
      id,
      lastEventId,
    };
    data = "";
    eventType = "";
    handlers.onMessage(message);
  }

  function processLine(line: string): void {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.charCodeAt(0) === COLON) {
      const text = line.slice(1);
      handlers.onComment?.(text.charCodeAt(0) === SPACE ? text.slice(1) : text);
      return;
    }
    const colon = line.indexOf(":");
    let field = line;
    let value = "";
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === SPACE) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data += value + "\n";
        break;
      case "id":
        // Per spec, an id containing U+0000 NULL is ignored.
        if (!value.includes("\u0000")) {
          lastEventIdBuffer = value;
          frameId = value;
        }
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) handlers.onRetry?.(Number(value));
        break;
      default:
        // Unknown fields are ignored.
        break;
    }
  }

  function feed(chunk: string): void {
    if (chunk === "") return;
    let text = chunk;
    if (!started) {
      started = true;
      if (text.charCodeAt(0) === BOM) text = text.slice(1);
    }
    if (skipLeadingLF) {
      skipLeadingLF = false;
      if (text.charCodeAt(0) === LF) text = text.slice(1);
    }

    // Everything already in the buffer is a partial line with no line break,
    // so scanning can start where the new text begins.
    let lineStart = 0;
    let index = buffer.length;
    buffer += text;
    while (index < buffer.length) {
      const code = buffer.charCodeAt(index);
      if (code === LF || code === CR) {
        processLine(buffer.slice(lineStart, index));
        if (code === CR) {
          if (index + 1 === buffer.length) {
            skipLeadingLF = true;
          } else if (buffer.charCodeAt(index + 1) === LF) {
            index += 1;
          }
        }
        lineStart = index + 1;
      }
      index += 1;
    }
    buffer = buffer.slice(lineStart);
  }

  return {
    feed,
    get lastEventId() {
      return lastEventId;
    },
  };
}
