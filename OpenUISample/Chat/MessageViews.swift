import SwiftUI
import OpenUI

struct MessageRow: View {
    let message: ChatMessage
    let store: ChatStore
    let showSource: (Rendition) -> Void

    var body: some View {
        switch message.role {
        case .user:
            Text(message.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(.white)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 48)
        case .assistant:
            AssistantMessageView(message: message, store: store, showSource: showSource)
        }
    }
}

/// An answer in the selected format: native OpenUI components or Markdown, followed by its status.
/// The rendition for a format is written the first time the answer is shown in it.
struct AssistantMessageView: View {
    let message: ChatMessage
    let store: ChatStore
    let showSource: (Rendition) -> Void

    var body: some View {
        let format = store.format
        VStack(alignment: .leading, spacing: 8) {
            if let rendition = message.renditions[format] {
                RenditionView(rendition: rendition, showSource: showSource, retry: retry(format))
            } else {
                ActivityLabel(text: "Thinking…")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: format) { store.ensureRendition(of: message, in: format) }
    }

    private func retry(_ format: ResponseFormat) -> (() -> Void)? {
        guard !store.isResponding else { return nil }
        return { store.retry(message, in: format) }
    }
}

private struct RenditionView: View {
    let rendition: Rendition
    let showSource: (Rendition) -> Void
    let retry: (() -> Void)?

    var body: some View {
        content
        footer
    }

    @ViewBuilder
    private var content: some View {
        switch rendition.format {
        case .openUI:
            if let runtime = rendition.runtime, runtime.root != nil {
                OpenUIView(runtime: runtime)
            }
        case .markdown:
            if !rendition.text.isEmpty {
                MarkdownView(rendition.text)
                    .padding(16)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch rendition.phase {
        case .pending(let activity):
            ActivityLabel(text: activity)
        case .streaming:
            ActivityLabel(text: "Writing…")
        case .complete, .stopped:
            HStack(spacing: 6) {
                Label(rendition.format.title, systemImage: rendition.format == .openUI ? "square.stack.3d.up" : "text.alignleft")
                if let model = rendition.model {
                    Text("· \(model)")
                }
                if rendition.phase == .stopped {
                    Text("· Stopped")
                }
                Spacer()
                Button("Source", systemImage: "chevron.left.forwardslash.chevron.right") { showSource(rendition) }
                    .labelStyle(.iconOnly)
                    .disabled(rendition.text.isEmpty)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let note = rendition.note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .failed(let error):
            Problem(text: error, icon: "exclamationmark.triangle.fill", tint: .orange, retry: retry)
        case .refused(let reason):
            Problem(text: reason, icon: "hand.raised.fill", tint: .secondary, retry: retry)
        }
    }
}

private struct ActivityLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text(text)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

private struct Problem: View {
    let text: String
    let icon: String
    let tint: Color
    let retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(LocalizedStringKey(text))
            } icon: {
                Image(systemName: icon).foregroundStyle(tint)
            }
            .font(.footnote)
            if let retry {
                Button("Try again", systemImage: "arrow.clockwise", action: retry)
                    .font(.footnote.weight(.semibold))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The raw answer, plus the persisted UI state and any render errors for OpenUI answers.
struct SourceView: View {
    let rendition: Rendition
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    CodeBlockView(language: rendition.format == .openUI ? "openui-lang" : "markdown", code: rendition.text)
                    if let errors = rendition.runtime?.errors, !errors.isEmpty {
                        section("Issues") {
                            ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                                Text(error.description)
                                    .font(.footnote.monospaced())
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    if !rendition.persistedState.isEmpty {
                        section("UI state (sent back with the conversation)") {
                            CodeBlockView(language: "json", code: OpenUIJSON.stringify(.object(rendition.persistedState)))
                        }
                    }
                }
                .padding()
            }
            .navigationTitle(rendition.format == .openUI ? "OpenUI Lang" : "Markdown")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
        }
    }
}
