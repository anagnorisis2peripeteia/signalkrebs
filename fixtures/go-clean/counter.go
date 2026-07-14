// Package counter is the signalkrebs FALSE-POSITIVE guard fixture: correctly
// synchronized code that must produce verdict=clean. A lane that flags this as a
// defect is over-firing and is caught by scripts/validate-detector.mjs, exactly
// as marmorkrebs asserts survivors are NOT reported for an untested but unchanged
// neighbour.
package counter

import "sync"

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
