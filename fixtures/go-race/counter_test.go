package counter

import (
	"sync"
	"testing"
)

// TestPlantedRace drives RacyCounter from two goroutines so `go test -race`
// reports the planted data race. The signalkrebs liveness check runs exactly
// this and requires a WARNING: DATA RACE — if it is absent, the go-race lane
// is not detecting races on this host and every gate result from it is
// worthless (verdict: lane-dead).
func TestPlantedRace(t *testing.T) {
	c := &RacyCounter{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			c.Inc()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			_ = c.Value()
		}
	}()
	wg.Wait()
}

// TestSafeCounter is the clean control: the validator asserts a race is NOT
// reported here, so a lane that flags everything is caught.
func TestSafeCounter(t *testing.T) {
	c := &SafeCounter{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			c.Inc()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			_ = c.Value()
		}
	}()
	wg.Wait()
}
