import XCTest
import Dispatch
@testable import Counter

final class CounterTests: XCTestCase {
    func testPlantedRace() {
        let c = RacyCounter()
        DispatchQueue.concurrentPerform(iterations: 2000) { _ in c.inc() }
        _ = c.value
    }
}
