// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Counter",
    targets: [
        .target(name: "Counter"),
        .testTarget(name: "CounterTests", dependencies: ["Counter"]),
    ]
)
