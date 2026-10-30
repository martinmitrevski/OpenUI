import Foundation
import Observation
import OpenUI

/// The conversation: sends messages to the sample backend, streams answers into their messages and
/// routes actions from generated UIs back into the chat.
@Observable
final class ChatStore {
    static let defaultBackendURL = "http://localhost:8787"

    private(set) var messages: [ChatMessage] = []
    /// How answers are shown. Switching writes the other rendition of existing answers on demand.
    var format: ResponseFormat {
        didSet { UserDefaults.standard.set(format.rawValue, forKey: "ChatFormat") }
    }
    var backendURL: String {
        didSet { UserDefaults.standard.set(backendURL, forKey: "BackendURL") }
    }
    private(set) var health: BackendHealth?
    private(set) var healthError: String?

    /// Whether any answer is being written.
    var isResponding: Bool {
        messages.contains { message in message.renditions.values.contains { !$0.phase.isFinished } }
    }

    /// Opens links from `@OpenUrl` actions (set by the view).
    @ObservationIgnored var openURL: (URL) -> Void = { _ in }

    private let flushInterval: Duration = .milliseconds(50)

    init() {
        let defaults = UserDefaults.standard
        format = defaults.string(forKey: "ChatFormat").flatMap(ResponseFormat.init(rawValue:)) ?? .openUI
        backendURL = defaults.string(forKey: "BackendURL") ?? Self.defaultBackendURL
    }

    // MARK: - Conversation

    func send(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isResponding else { return }
        messages.append(.user(text))
        answer()
    }

    /// Handles actions from generated UIs: follow-ups and `@ToAssistant` continue the conversation,
    /// `@OpenUrl` opens the link. `@Run`, `@Set` and `@Reset` never get here; the runtime handles them.
    func handle(_ event: ActionEvent) {
        if event.isOpenURL {
            if let url = event.url { openURL(url) }
            return
        }
        guard event.isContinueConversation, !isResponding else { return }
        let label = event.humanFriendlyMessage.isEmpty ? (event.context ?? "Continue") : event.humanFriendlyMessage
        messages.append(.user(label, payload: event.assistantMessage))
        answer()
    }

    /// Makes sure `message` has an answer in `format`, writing it if needed. Called when an answer
    /// is shown, so switching formats fills in the other rendition of earlier answers.
    func ensureRendition(of message: ChatMessage, in format: ResponseFormat) {
        guard message.role == .assistant, message.renditions[format] == nil else { return }
        write(message, in: format)
    }

    /// Stops every answer being written.
    func stop() {
        for message in messages {
            message.renditions.values.forEach { $0.task?.cancel() }
        }
    }

    /// Writes a failed or refused rendition again.
    func retry(_ message: ChatMessage, in format: ResponseFormat) {
        guard let rendition = message.renditions[format], rendition.phase.isFinished else { return }
        rendition.runtime?.dispose()
        message.setRendition(nil, for: format)
        write(message, in: format)
    }

    func startOver() {
        stop()
        for message in messages {
            message.renditions.values.forEach { $0.runtime?.dispose() }
        }
        messages.removeAll()
    }

    // MARK: - Backend

    func checkHealth() async {
        do {
            health = try await BackendClient(string: backendURL).health()
            healthError = nil
        } catch {
            health = nil
            healthError = error.localizedDescription
        }
    }

    /// Adds an answer to the latest question, in the current format.
    private func answer() {
        let message = ChatMessage.assistant()
        messages.append(message)
        write(message, in: format)
    }

    /// Streams the answer for `message` in `format`, using the conversation before it as history.
    private func write(_ message: ChatMessage, in format: ResponseFormat) {
        guard let index = messages.firstIndex(where: { $0 === message }) else { return }
        let history = messages[..<index].compactMap { $0.wireMessage(for: format) }
        let client: BackendClient
        do {
            client = try BackendClient(string: backendURL)
        } catch {
            let rendition = Rendition(format: format, runtime: nil)
            rendition.phase = .failed(error.localizedDescription)
            message.setRendition(rendition, for: format)
            return
        }

        let rendition = Rendition(format: format, runtime: format == .openUI ? makeRuntime(client: client) : nil)
        rendition.runtime?.onStateUpdate = { [weak rendition] state in rendition?.persistedState = state }
        message.setRendition(rendition, for: format)

        rendition.task = Task { [weak self] in
            do {
                for try await event in client.chat(messages: history, format: format) {
                    self?.apply(event, to: rendition)
                }
                if Task.isCancelled {
                    rendition.phase = .stopped
                } else if !rendition.phase.isFinished {
                    rendition.phase = .failed("The connection closed before the answer finished.")
                }
            } catch {
                if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                    rendition.phase = .stopped
                } else {
                    rendition.phase = .failed(Self.describe(error))
                }
            }
            self?.finish(rendition)
        }
    }

    private func makeRuntime(client: BackendClient) -> OpenUIRuntime {
        let runtime = OpenUIRuntime(library: .openUIChat, toolProvider: BackendToolProvider(baseURL: client.baseURL))
        runtime.onAction = { [weak self] event in self?.handle(event) }
        return runtime
    }

    private func apply(_ event: ChatStreamEvent, to rendition: Rendition) {
        switch event.type {
        case "meta":
            if let model = event.model { rendition.model = model }
        case "status":
            guard rendition.buffer.isEmpty else { return }
            switch event.status {
            case "tool": rendition.phase = .pending(activity: Self.activity(forTool: event.tool))
            case "writing": rendition.phase = .pending(activity: "Writing…")
            default: rendition.phase = .pending(activity: "Thinking…")
            }
        case "delta":
            rendition.buffer += event.text ?? ""
            rendition.phase = .streaming
            scheduleFlush(rendition)
        case "reset":
            // Text written before a tool call isn't part of the answer.
            rendition.buffer = ""
            rendition.phase = .pending(activity: Self.activity(forTool: nil))
            flush(rendition, isStreaming: true)
        case "fallback":
            if let to = event.to {
                rendition.model = to
                rendition.note = "Answered by \(to) after \(event.from ?? "the requested model") declined."
            }
        case "done":
            if event.stopReason == "max_tokens" { rendition.note = "The answer was cut off at the token limit." }
            if let model = event.model { rendition.model = model }
            rendition.phase = .complete
        case "refusal":
            // Whatever streamed before the refusal is discarded.
            rendition.buffer = ""
            rendition.phase = .refused(event.message ?? "The model declined to answer.")
        case "error":
            rendition.phase = .failed(event.message ?? "Something went wrong.")
        default:
            break
        }
    }

    private func scheduleFlush(_ rendition: Rendition) {
        guard rendition.flushTask == nil else { return }
        rendition.flushTask = Task { [weak self, flushInterval] in
            try? await Task.sleep(for: flushInterval)
            guard !Task.isCancelled else { return }
            rendition.flushTask = nil
            self?.flush(rendition, isStreaming: true)
        }
    }

    private func flush(_ rendition: Rendition, isStreaming: Bool) {
        if rendition.text != rendition.buffer { rendition.text = rendition.buffer }
        rendition.runtime?.update(response: rendition.buffer.isEmpty ? nil : rendition.buffer, isStreaming: isStreaming)
    }

    private func finish(_ rendition: Rendition) {
        rendition.flushTask?.cancel()
        rendition.flushTask = nil
        if case .refused = rendition.phase {
            rendition.buffer = ""
        }
        // Ending the stream lets the runtime run its queries.
        flush(rendition, isStreaming: false)
        rendition.task = nil
    }

    private static func activity(forTool tool: String?) -> String {
        switch tool {
        case "search_hotels": "Searching hotels…"
        case "get_weather": "Checking the forecast…"
        case "find_photos": "Finding photos…"
        case "scale_recipe": "Looking up the recipe…"
        case let tool?: "Calling \(tool)…"
        case nil: "Looking things up…"
        }
    }

    private static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet, .timedOut:
                return "Can't reach the backend. Start it with `npm start` in SampleBackend, or check the URL in Settings."
            default:
                break
            }
        }
        return error.localizedDescription
    }
}
