// signalkrebs false-positive guard: correctly synchronized, must be verdict=clean.
import Foundation

public final class SafeCounter {
    private let lock = NSLock()
    private var _value = 0
    public init() {}
    public func inc() { lock.lock(); _value += 1; lock.unlock() }
    public var value: Int { lock.lock(); defer { lock.unlock() }; return _value }
}
