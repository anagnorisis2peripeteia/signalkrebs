// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Clean",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "Clean"),
        .testTarget(name: "CleanTests", dependencies: ["Clean"]),
    ]
)
