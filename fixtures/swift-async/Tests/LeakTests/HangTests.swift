import XCTest
@testable import Leak

final class HangTests: XCTestCase {
    // Awaiting the never-resumed continuation hangs this test forever — the hang probe must catch it.
    func testHangs() async {
        _ = await Leak().hangs()
    }
}
