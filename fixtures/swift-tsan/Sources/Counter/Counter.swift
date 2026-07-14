// signalkrebs swift-tsan liveness fixture: a KNOWN, deliberate data race so the
// validator can confirm Xcode Thread Sanitizer actually catches races on this
// host. A lane that reports this clean is broken and must fail closed.
public final class RacyCounter {
    public var value = 0
    public init() {}
    public func inc() { value += 1 } // concurrent unsynchronized write — the planted race
}
