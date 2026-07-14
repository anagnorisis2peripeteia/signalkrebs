import XCTest
import Dispatch
@testable import Counter

final class CounterTests: XCTestCase {
    func testSafeCounter() {
        let c = SafeCounter()
        DispatchQueue.concurrentPerform(iterations: 2000) { _ in c.inc() }
        XCTAssertEqual(c.value, 2000)
    }
}
