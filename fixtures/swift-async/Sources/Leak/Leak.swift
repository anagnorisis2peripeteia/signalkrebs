// Planted-defect fixture for the swift-async lane.
// The continuation is NEVER resumed (SA001) — awaiting `hangs()` blocks forever, which both the
// static SwiftSyntax analyzer flags and the dynamic hang probe catches at runtime.
public struct Leak {
    public init() {}
    public func hangs() async -> Int {
        await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
            let _ = c // BUG: never calls c.resume(...) on any path
        }
    }
}
