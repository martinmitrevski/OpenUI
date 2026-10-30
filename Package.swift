// swift-tools-version:6.0

import PackageDescription

// The renderer as a package, and `openui-prompt`, which writes the system prompt for a library
// and an app's own components from their portable definitions. The StreamChatAI renderer is its
// own package, in StreamChatAIOpenUI/, so this one stays free of dependencies.
let package = Package(
    name: "OpenUI",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "OpenUI", targets: ["OpenUI"]),
        .executable(name: "openui-prompt", targets: ["OpenUIPrompt"])
    ],
    targets: [
        .target(name: "OpenUI", path: "OpenUI"),
        .executableTarget(name: "OpenUIPrompt", dependencies: ["OpenUI"], path: "OpenUIPrompt")
    ]
)
