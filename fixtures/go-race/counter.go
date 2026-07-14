// Package counter is a signalkrebs liveness fixture: it carries a KNOWN,
// deliberate data race so scripts/validate-detector.mjs (and the inline
// per-run liveness check) can confirm the go-race lane actually catches
// races on this host. A detector that reports this fixture clean is broken
// and must fail closed — never trust a lane that cannot catch a planted race.
//
// It also carries a CLEAN neighbour (SafeCounter) the validator asserts is
// NOT flagged, so a lane that screams "race" at everything is caught too.
package counter

import "sync"

// RacyCounter increments an int from multiple goroutines with NO
// synchronization — a textbook data race on the `value` field.
type RacyCounter struct {
	value int
}

func (c *RacyCounter) Inc() {
	c.value++ // concurrent unsynchronized write — the planted race
}

func (c *RacyCounter) Value() int {
	return c.value // concurrent unsynchronized read
}

// SafeCounter is the clean control: the same shape, correctly guarded.
type SafeCounter struct {
	mu    sync.Mutex
	value int
}

func (c *SafeCounter) Inc() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value++
}

func (c *SafeCounter) Value() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.value
}
