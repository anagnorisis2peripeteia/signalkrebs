package counter

import (
	"sync"
	"testing"
)

// TestSafeCounterConcurrent exercises SafeCounter under parallelism so the
// go-race lane genuinely runs the changed code with GOMAXPROCS>=2 and still
// finds nothing — the verdict must be clean, not a false positive.
func TestSafeCounterConcurrent(t *testing.T) {
	c := &SafeCounter{}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				c.Inc()
				_ = c.Value()
			}
		}()
	}
	wg.Wait()
	if got := c.Value(); got != 8000 {
		t.Fatalf("want 8000, got %d", got)
	}
}
