// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Leak",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "Leak"),
        .testTarget(name: "LeakTests", dependencies: ["Leak"]),
    ]
)
