import SwiftUI
import OpenUI

@main
struct OpenUISampleApp: App {
    /// Debug hook: `-SelectedTab gallery` opens the gallery (as does `-GalleryExample`).
    @State private var tab: String = {
        let defaults = UserDefaults.standard
        if let tab = defaults.string(forKey: "SelectedTab") { return tab }
        return defaults.string(forKey: "GalleryExample") == nil ? "chat" : "gallery"
    }()

    var body: some Scene {
        WindowGroup {
            TabView(selection: $tab) {
                ChatView()
                    .tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right") }
                    .tag("chat")
                GalleryView()
                    .tabItem { Label("Gallery", systemImage: "square.grid.2x2") }
                    .tag("gallery")
            }
        }
    }
}
