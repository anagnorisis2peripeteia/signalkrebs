package stress

import (
	"sync"
	"testing"
)

// A scheduling-dependent flake: 200 goroutines each do a NON-atomic increment of a shared int.
// Run serially (GOMAXPROCS=1) the increments do not collide and counter reaches 200, so the test
// passes. Under real parallelism (GOMAXPROCS>1) the read-modify-write races: -race reports a DATA
// RACE and lost updates leave counter < 200, so the assertion also fails. The stress sweep thus
// surfaces what a single serial run hides.
func TestPlantedFlake(t *testing.T) {
	counter := 0
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			counter++
			wg.Done()
		}()
	}
	wg.Wait()
	if counter != 200 {
		t.Fatalf("counter = %d, want 200 (lost updates under parallel scheduling)", counter)
	}
}
