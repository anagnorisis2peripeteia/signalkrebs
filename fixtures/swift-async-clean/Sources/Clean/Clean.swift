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
