package clean

import (
	"sync"
	"sync/atomic"
	"testing"
)

// The correctly-synchronized twin: an atomic counter has no data race and no lost updates, so it
// passes under every GOMAXPROCS / -count / -race / -shuffle perturbation.
func TestPlantedFlake(t *testing.T) {
	var counter int64
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			atomic.AddInt64(&counter, 1)
			wg.Done()
		}()
	}
	wg.Wait()
	if atomic.LoadInt64(&counter) != 200 {
		t.Fatalf("counter = %d, want 200", atomic.LoadInt64(&counter))
	}
}
