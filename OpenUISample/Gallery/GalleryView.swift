import SwiftUI
import OpenUI

/// Offline showcase: renders the example programs that ship with the OpenUI libraries.
struct GalleryView: View {
    struct Example: Identifiable, Hashable {
        let id: String
        let title: String
        let library: String
        let source: String
    }

    private static func examples(from library: ComponentLibrary, name: String) -> [Example] {
        library.defaultPromptOptions.examples.enumerated().map { index, text in
            let lines = text.components(separatedBy: "\n")
            let title = lines.first?
                .replacingOccurrences(of: #"^Example \d+ — "#, with: "", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: ": ")) ?? "Example"
            let source = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return Example(id: "\(name)-\(index)", title: title, library: name, source: source)
        }
    }

    let examples: [Example] =
        examples(from: .openUIChat, name: "Chat") + examples(from: .openUI, name: "Standard")

    /// Debug hook: `-GalleryExample Chat-0` opens an example directly (used for screenshots).
    @State private var path: [Example] = {
        guard let id = UserDefaults.standard.string(forKey: "GalleryExample") else { return [] }
        let all = examples(from: .openUIChat, name: "Chat") + examples(from: .openUI, name: "Standard")
        return all.filter { $0.id == id }
    }()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section("Chat library") {
                    ForEach(examples.filter { $0.library == "Chat" }) { example in
                        NavigationLink(example.title, value: example)
                    }
                }
                Section("Standard library") {
                    ForEach(examples.filter { $0.library == "Standard" }) { example in
                        NavigationLink(example.title, value: example)
                    }
                }
            }
            .navigationTitle("Gallery")
            .navigationDestination(for: Example.self) { example in
                GalleryDetailView(example: example)
            }
        }
    }
}

struct GalleryDetailView: View {
    let example: GalleryView.Example
    @State private var showSource = false
    @State private var lastAction: String?

    /// Debug hook: `-GalleryOffset 800` shifts content up (used for screenshots below the fold).
    private let debugOffset = CGFloat(UserDefaults.standard.double(forKey: "GalleryOffset"))

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                OpenUIView(
                    response: example.source,
                    library: example.library == "Chat" ? .openUIChat : .openUI
                ) { event in
                    lastAction = event.isOpenURL ? "Open \(event.url?.absoluteString ?? "")" : "\(event.type): \(event.humanFriendlyMessage)"
                }
                if showSource {
                    CodeBlockView(language: "openui-lang", code: example.source)
                }
            }
            .padding()
            .offset(y: -debugOffset)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(example.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button(showSource ? "Hide source" : "Source") { showSource.toggle() }
        }
        .safeAreaInset(edge: .bottom) {
            if let lastAction {
                Text(lastAction)
                    .font(.footnote)
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background(.thinMaterial)
            }
        }
    }
}
