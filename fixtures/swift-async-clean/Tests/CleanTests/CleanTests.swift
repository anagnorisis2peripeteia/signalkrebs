import XCTest
@testable import Clean

final class CleanTests: XCTestCase {
    func testFetch() async {
        let v = await Clean().fetch()
        XCTAssertEqual(v, 42)
    }
}
