// swift-tools-version:6.0

import PackageDescription

// The renderer StreamChatAI shows replies written in OpenUI Lang with. It is a package of its
// own, beside the OpenUI one, so OpenUI keeps no dependencies, and it reaches StreamChatAI only
// through its public API, as any renderer from outside the SDK would.
let package = Package(
    name: "StreamChatAIOpenUI",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "StreamChatAIOpenUI", targets: ["StreamChatAIOpenUI"])
    ],
    dependencies: [
        .package(path: ".."),
        .package(path: "../../stream-chat-swift")
    ],
    targets: [
        .target(
            name: "StreamChatAIOpenUI",
            dependencies: [
                .product(name: "OpenUI", package: "OpenUI"),
                .product(name: "StreamChatAI", package: "stream-chat-swift")
            ]
        ),
        .testTarget(name: "StreamChatAIOpenUITests", dependencies: ["StreamChatAIOpenUI"])
    ]
)
