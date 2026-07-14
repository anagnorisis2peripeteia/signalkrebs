// signalkrebs FALSE-POSITIVE guard fixture: the same shapes written correctly —
// must produce verdict=clean.
const inflight = new Map();

// Single-flight: the promise (not the value) is stored synchronously, so there is
// no check-then-act gap across the await.
export function getOrFetch(key, fetcher) {
  let p = inflight.get(key);
  if (!p) {
    p = fetcher(key);
    inflight.set(key, p);
  }
  return p;
}

export class Poller {
  start() {
    this.handle = setInterval(() => {}, 1000);
  }
  stop() {
    clearInterval(this.handle);
  }
}
