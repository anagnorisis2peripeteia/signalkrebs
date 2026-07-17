// Planted-defect fixture for the swift-async lane.
// The continuation is NEVER resumed (SA001) — awaiting `hangs()` blocks forever, which both the
// static SwiftSyntax analyzer flags and the dynamic hang probe catches at runtime.
public struct Leak {
    public init() {}
    public func hangs() async -> Int {
        await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
            // BUG: the continuation is neither resumed nor stored — it is dropped, so the caller
            // hangs forever. (Referencing `c` at all would look like the stored-continuation
            // pattern; a genuine leak drops it entirely.)
            _ = 1
        }
    }
}
