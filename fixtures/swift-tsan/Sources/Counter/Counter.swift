// signalkrebs swift-tsan liveness fixture: a KNOWN, deliberate data race so the
// validator can confirm Xcode Thread Sanitizer actually catches races on this
// host. A lane that reports this clean is broken and must fail closed.
public final class RacyCounter {
    public var value = 0
    public init() {}
    public func inc() { value += 1 } // concurrent unsynchronized write — the planted race
}

private enum CounterError: Error {
    case invalid
}

private struct CounterHandle {
    public static func open() throws -> CounterHandle { CounterHandle() }
    public func close() {}
}

public extension RacyCounter {
    public func leakOnErrorReturn(_ shouldFail: Bool) throws -> Int {
        let handle = try CounterHandle.open()
        _ = handle
        if shouldFail { throw CounterError.invalid }
        return value
    }
}
