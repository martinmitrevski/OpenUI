import SwiftUI
import OpenUI

/// A chat with the sample backend. Answers render as native OpenUI components or as Markdown,
/// switchable from the toolbar.
struct ChatView: View {
    @State private var store = ChatStore()
    @State private var draft = ""
    @State private var showSettings = false
    @State private var sourceRendition: Rendition?
    @FocusState private var composerFocused: Bool
    @Environment(\.openURL) private var openURL

    /// Debug hook: `-ChatOffset 800` shifts the conversation up (used for screenshots below the fold).
    private let debugOffset = CGFloat(UserDefaults.standard.double(forKey: "ChatOffset"))

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if store.messages.isEmpty {
                            WelcomeView(store: store)
                        }
                        ForEach(store.messages) { message in
                            MessageRow(message: message, store: store) { sourceRendition = $0 }
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .offset(y: -debugOffset)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.messages.last?.id) {
                    // Keep the question at the top while its answer streams in below it.
                    guard let question = store.messages.last(where: { $0.role == .user }) else { return }
                    withAnimation { proxy.scrollTo(question.id, anchor: .top) }
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle("OpenUI Demo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("New chat", systemImage: "square.and.pencil") { store.startOver() }
                        .disabled(store.messages.isEmpty)
                }
                ToolbarItem(placement: .principal) {
                    Picker("Answer format", selection: $store.format) {
                        ForEach(ResponseFormat.allCases) { format in
                            Text(format.title).tag(format)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await store.checkHealth() } }) {
                SettingsView(store: store)
            }
            .sheet(item: $sourceRendition) { rendition in
                SourceView(rendition: rendition)
            }
            .task {
                store.openURL = { openURL($0) }
                await store.checkHealth()
                // Debug hook: `-ChatPrompt "Plan a 3-day trip to Lisbon"` asks on launch (used for screenshots).
                if store.messages.isEmpty, let prompt = UserDefaults.standard.string(forKey: "ChatPrompt") {
                    store.send(prompt)
                }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Ask about a trip or a recipe", text: $draft)
                .focused($composerFocused)
                .submitLabel(.send)
                .onSubmit(sendDraft)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
            if store.isResponding {
                Button("Stop", systemImage: "stop.circle.fill", action: store.stop)
                    .labelStyle(.iconOnly)
                    .font(.system(size: 30))
            } else {
                Button("Send", systemImage: "arrow.up.circle.fill", action: sendDraft)
                    .labelStyle(.iconOnly)
                    .font(.system(size: 30))
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func sendDraft() {
        guard !store.isResponding else { return }
        store.send(draft)
        draft = ""
    }
}

/// Shown before the first message: what the demo does, the backend status and suggestions.
private struct WelcomeView: View {
    let store: ChatStore

    private static let suggestions: [(icon: String, text: String)] = [
        ("airplane", "Plan a 3-day trip to Ohrid"),
        ("bed.double", "Find hotels in Ohrid under €70"),
        ("cloud.sun", "What's the weather like next week?"),
        ("fork.knife", "Give me a quick pasta recipe"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "sparkles.rectangle.stack")
                .font(.largeTitle)
                .foregroundStyle(.tint)
            Text("Generative UI, rendered natively")
                .font(.title2.bold())
            Text("Answers stream in as OpenUI Lang and render as SwiftUI components you can interact with. Switch to **Markdown** in the toolbar at any time to see the same answers as a regular chat would show them.")
                .foregroundStyle(.secondary)
            BackendStatusView(store: store)
            VStack(spacing: 10) {
                ForEach(Self.suggestions, id: \.text) { suggestion in
                    Button {
                        store.send(suggestion.text)
                    } label: {
                        Label(suggestion.text, systemImage: suggestion.icon)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
        .padding(.top, 24)
    }
}

/// The backend's mode, or how to start it when it can't be reached.
struct BackendStatusView: View {
    let store: ChatStore

    var body: some View {
        Group {
            if let health = store.health {
                if health.mode == "llm" {
                    Label("Live answers from \(health.model ?? "Claude")", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    Label("Demo mode: scripted answers. Add an Anthropic or OpenAI API key to the backend for live answers.", systemImage: "play.circle.fill")
                        .foregroundStyle(.blue)
                }
            } else if store.healthError != nil {
                Label("Can't reach the backend at \(store.backendURL). Run `npm start` in SampleBackend.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
        }
        .font(.footnote)
    }
}
