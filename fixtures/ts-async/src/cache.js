// signalkrebs ts-async liveness fixture: KNOWN, deliberate async defects so the
// validator can confirm the lane catches them. A lane that reports this clean is
// broken and must fail closed.
export const cache = {};

// PLANTED await-race (require-atomic-updates): the check and the assignment are
// separated by an await, so two concurrent callers both miss the cache and both
// write — the classic JS check-then-act race.
export async function getOrFetch(key, fetcher) {
  if (!cache[key]) {
    cache[key] = await fetcher(key);
  }
  return cache[key];
}

// PLANTED interval leak: stored on a field, never cleared anywhere in this file.
export class Poller {
  start() {
    this.handle = setInterval(() => {}, 1000);
  }
}
