// The correctly-synchronized twin: the continuation resumes on its only path (no SA001), so the
// analyzer stays silent and the test terminates.
public struct Clean {
    public init() {}
    public func fetch() async -> Int {
        await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
            c.resume(returning: 42)
        }
    }
}

// Regression guard for the escape-check (the false positive found dogfooding on Tachikoma): the
// stored-continuation pattern hands the continuation to a queue and resumes it ELSEWHERE. The
// analyzer must NOT flag `waitInLine` as a leak even though its closure never resumes directly.
public final class Gate {
    private var waiters: [CheckedContinuation<Int, Never>] = []
    public init() {}
    public func waitInLine() async -> Int {
        await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
            waiters.append(c) // stored — resumed later in resumeAll(), not a leak
        }
    }
    public func resumeAll() {
        for w in waiters { w.resume(returning: 0) }
        waiters.removeAll()
    }
}
