import Foundation
import Observation
import OpenUI

/// How answers are rendered.
nonisolated enum ResponseFormat: String, CaseIterable, Identifiable, Sendable {
    /// Native SwiftUI components generated from OpenUI Lang.
    case openUI = "openui"
    /// Plain chat Markdown.
    case markdown

    var id: String { rawValue }

    var title: String {
        switch self {
        case .openUI: "OpenUI"
        case .markdown: "Markdown"
        }
    }
}

/// One message in the conversation. An assistant message holds one rendition of the answer per
/// format; the one for the other format is written when the user switches to it.
@Observable
final class ChatMessage: Identifiable {
    enum Role {
        case user
        case assistant
    }

    let id = UUID()
    let role: Role
    /// User messages: the visible text.
    let text: String
    /// User messages sent from a UI action: the envelope sent to the backend instead of `text`.
    let payload: String?
    /// Assistant messages: the answer in each format written so far.
    private(set) var renditions: [ResponseFormat: Rendition] = [:]

    private init(role: Role, text: String, payload: String?) {
        self.role = role
        self.text = text
        self.payload = payload
    }

    static func user(_ text: String, payload: String? = nil) -> ChatMessage {
        ChatMessage(role: .user, text: text, payload: payload)
    }

    static func assistant() -> ChatMessage {
        ChatMessage(role: .assistant, text: "", payload: nil)
    }

    func setRendition(_ rendition: Rendition?, for format: ResponseFormat) {
        renditions[format] = rendition
    }

    /// The message as sent to the backend for an answer in `format`, or `nil` when it isn't part of
    /// the history. Answers are sent in the requested format when that rendition exists.
    func wireMessage(for format: ResponseFormat) -> WireMessage? {
        switch role {
        case .user:
            return WireMessage(role: "user", content: payload ?? text)
        case .assistant:
            let candidates = [renditions[format]] + ResponseFormat.allCases.filter { $0 != format }.map { renditions[$0] }
            return candidates.lazy.compactMap { $0?.wireContent }.first.map { WireMessage(role: "assistant", content: $0) }
        }
    }
}

/// One answer in one format.
@Observable
final class Rendition: Identifiable {
    enum Phase: Equatable {
        /// Waiting for the first token; `activity` describes what the model is doing.
        case pending(activity: String)
        case streaming
        case complete
        /// The user stopped the answer.
        case stopped
        case failed(String)
        /// The model declined to answer.
        case refused(String)

        var isFinished: Bool {
            switch self {
            case .pending, .streaming: false
            case .complete, .stopped, .failed, .refused: true
            }
        }
    }

    let id = UUID()
    let format: ResponseFormat
    /// The raw answer (OpenUI Lang or Markdown).
    var text = ""
    var phase: Phase = .pending(activity: "Thinking…")
    /// The model that wrote the answer (live mode).
    var model: String?
    /// A short note shown under the answer (fallback model, truncation).
    var note: String?
    /// OpenUI only: the state the user left the UI in, persisted with the answer (as upstream does).
    var persistedState: OpenUIObject = [:]
    /// OpenUI only: renders the answer and owns its state, queries and actions.
    @ObservationIgnored let runtime: OpenUIRuntime?

    /// The request writing this rendition.
    @ObservationIgnored var task: Task<Void, Never>?
    /// Streamed text not yet shown; flushed in batches to keep re-rendering cheap.
    @ObservationIgnored var buffer = ""
    @ObservationIgnored var flushTask: Task<Void, Never>?

    init(format: ResponseFormat, runtime: OpenUIRuntime?) {
        self.format = format
        self.runtime = runtime
    }

    /// The content sent back to the model, or `nil` when the answer isn't usable history.
    var wireContent: String? {
        guard phase == .complete || phase == .stopped, !text.isEmpty else { return nil }
        if format == .openUI, !persistedState.isEmpty {
            return MessageEnvelope.wrap(content: text, context: [.object(persistedState)])
        }
        return text
    }
}
