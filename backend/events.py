"""Live event bus — what the agent is doing, streamed to the phone as Server-Sent Events.

Commands run on a worker thread while the event stream is served from the event
loop, so `publish` is safe to call from any thread. Each open `GET /events`
connection is a subscriber with a bounded asyncio.Queue on its own loop, fed with
`loop.call_soon_threadsafe` (asyncio queues are not thread-safe, and a put from
another thread would not wake a loop waiting on the queue). A subscriber that
stops reading until its queue overflows is dropped instead of letting memory
grow; it reconnects with Last-Event-ID and replays what it missed from the last
BUFFER_SIZE events. The queue is smaller than that buffer, so everything a
dropped subscriber missed is still buffered when it reconnects promptly.

Event ids are increasing integers that start at this boot's start time in
microseconds, so an id from an earlier boot is always below the current boot's
first id and is never mistaken for a current one.

Events describe commands only. They are built from command state, never from
request headers, so they cannot carry the pairing token.
"""

from __future__ import annotations

import asyncio
import collections
import json
import re
import threading
import time
import uuid

from starlette.responses import StreamingResponse

BUFFER_SIZE = 200
MAX_SUBSCRIBERS = 8
# Must stay below BUFFER_SIZE (see the module docstring).
QUEUE_SIZE = 64
HEARTBEAT_SECONDS = 15.0

_EVENT_ID = re.compile(r"[0-9]{1,20}")


class TooManySubscribers(Exception):
    """Every event stream slot is taken."""


class Subscriber:
    """One open event stream. Its queue belongs to `loop` and is only touched there."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue_size: int) -> None:
        self.loop = loop
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=queue_size)
        self.closed = False


class EventBus:
    def __init__(
        self,
        buffer_size: int | None = None,
        max_subscribers: int | None = None,
        queue_size: int | None = None,
    ) -> None:
        self.boot_id = uuid.uuid4().hex[:12]
        self.first_id = time.time_ns() // 1000
        self._buffer_size = BUFFER_SIZE if buffer_size is None else buffer_size
        self._max_subscribers = max_subscribers
        self._queue_size = queue_size
        self._next_id = self.first_id
        self._buffer: collections.deque = collections.deque(maxlen=self._buffer_size)
        self._subscribers: list[Subscriber] = []
        self._lock = threading.Lock()

    def publish(self, event_type: str, **fields) -> dict:
        """Record an event and hand it to every subscriber. Safe from any thread."""
        with self._lock:
            event = {"type": event_type, "ts": time.time()}
            event.update(fields)
            record = (self._next_id, event)
            self._next_id += 1
            self._buffer.append(record)
            # Scheduling under the lock keeps every subscriber's copy in id order.
            for subscriber in list(self._subscribers):
                try:
                    subscriber.loop.call_soon_threadsafe(self._deliver, subscriber, record)
                except RuntimeError:
                    # The subscriber's event loop has closed.
                    self._subscribers.remove(subscriber)
                    subscriber.closed = True
        return event

    def _deliver(self, subscriber: Subscriber, record: tuple) -> None:
        """Runs on the subscriber's loop."""
        if subscriber.closed:
            return
        try:
            subscriber.queue.put_nowait(record)
        except asyncio.QueueFull:
            self.unsubscribe(subscriber)

    def subscribe(self, last_event_id: str | None = None) -> tuple:
        """Register a subscriber on the running loop.

        Returns the subscriber and the buffered events to replay: those newer than
        `last_event_id` when it belongs to this boot, otherwise none. Registration
        and the replay snapshot happen under one lock, so no event is missed or
        delivered twice.
        """
        limit = MAX_SUBSCRIBERS if self._max_subscribers is None else self._max_subscribers
        queue_size = QUEUE_SIZE if self._queue_size is None else self._queue_size
        subscriber = Subscriber(asyncio.get_running_loop(), queue_size)
        with self._lock:
            if len(self._subscribers) >= limit:
                raise TooManySubscribers()
            self._subscribers.append(subscriber)
            after = self._replay_after(last_event_id)
            replay = [] if after is None else [record for record in self._buffer if record[0] > after]
        return subscriber, replay

    def _replay_after(self, last_event_id: str | None) -> int | None:
        """The id to replay after, or None when absent, malformed, or not from this boot."""
        text = (last_event_id or "").strip()
        if not _EVENT_ID.fullmatch(text):
            return None
        value = int(text)
        return value if self.first_id <= value < self._next_id else None

    def unsubscribe(self, subscriber: Subscriber) -> None:
        with self._lock:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)
        subscriber.closed = True

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def buffered(self) -> list:
        with self._lock:
            return list(self._buffer)

    def hello(self) -> dict:
        now = time.time()
        return {"type": "hello", "ts": now, "boot_id": self.boot_id, "server_time": now}


bus = EventBus()


def publish(event_type: str, **fields) -> dict:
    return bus.publish(event_type, **fields)


def format_frame(record: tuple) -> str:
    event_id, event = record
    return f"id: {event_id}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"


async def _frames(event_bus: EventBus, subscriber: Subscriber, replay: list):
    getter = None
    try:
        yield f"event: hello\ndata: {json.dumps(event_bus.hello())}\n\n"
        for record in replay:
            yield format_frame(record)
        while not subscriber.closed:
            if getter is None:
                getter = asyncio.ensure_future(subscriber.queue.get())
            # asyncio.wait leaves the pending get in place across heartbeats, so no
            # event is lost to a cancelled get.
            done, _ = await asyncio.wait({getter}, timeout=HEARTBEAT_SECONDS)
            if not done:
                yield ": ping\n\n"
                continue
            record, getter = getter.result(), None
            yield format_frame(record)
    finally:
        if getter is not None:
            getter.cancel()
        event_bus.unsubscribe(subscriber)


class EventStream(StreamingResponse):
    """An SSE response that releases its subscriber slot however the stream ends."""

    def __init__(self, event_bus: EventBus, subscriber: Subscriber, replay: list) -> None:
        super().__init__(
            _frames(event_bus, subscriber, replay),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )
        self._bus = event_bus
        self._subscriber = subscriber

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Also covers a stream cancelled before its body generator ever started.
            self._bus.unsubscribe(self._subscriber)


def open_stream(last_event_id: str | None) -> EventStream:
    """Subscribe the calling connection; raises TooManySubscribers when every slot is taken."""
    event_bus = bus
    subscriber, replay = event_bus.subscribe(last_event_id)
    return EventStream(event_bus, subscriber, replay)
