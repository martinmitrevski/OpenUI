import Foundation
import OpenUI

/// A chat message in the backend's wire format.
nonisolated struct WireMessage: Codable, Sendable, Equatable {
    let role: String
    let content: String
}

/// Events streamed by the backend's `POST /chat` endpoint.
nonisolated struct ChatStreamEvent: Decodable, Sendable {
    /// `meta`, `status`, `delta`, `reset`, `fallback`, `done`, `refusal` or `error`.
    let type: String
    var text: String?
    /// `thinking`, `writing` or `tool`.
    var status: String?
    var tool: String?
    var mode: String?
    var model: String?
    var message: String?
    var stopReason: String?
    var from: String?
    var to: String?
}

/// `GET /health`.
nonisolated struct BackendHealth: Decodable, Sendable, Equatable {
    let ok: Bool
    /// `demo` (scripted answers) or `llm` (live answers from Claude).
    let mode: String
    let model: String?
}

nonisolated enum BackendError: LocalizedError {
    case invalidURL(String)
    case http(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): "“\(url)” isn't a valid backend URL."
        case .http(let status, let message): "The backend returned \(status): \(message)"
        }
    }
}

/// Talks to the sample backend in `SampleBackend/`.
nonisolated struct BackendClient: Sendable {
    let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    init(string: String) throws {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host() != nil else {
            throw BackendError.invalidURL(trimmed)
        }
        self.baseURL = url
    }

    func health() async throws -> BackendHealth {
        var request = URLRequest(url: baseURL.appending(path: "health"))
        request.timeoutInterval = 5
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BackendHealth.self, from: data)
    }

    /// Streams the answer to `messages`. Cancelling the consuming task closes the connection, which
    /// stops generation on the backend.
    func chat(messages: [WireMessage], format: ResponseFormat) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: baseURL.appending(path: "chat"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    // The model may think for a while before the first token; the backend pings every 10s.
                    request.timeoutInterval = 120
                    request.httpBody = try JSONEncoder().encode(ChatRequest(messages: messages, format: format.rawValue))

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if (response as? HTTPURLResponse)?.statusCode != 200 {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        try Self.check(response, data: data)
                    }
                    let decoder = JSONDecoder()
                    for try await line in bytes.lines where line.hasPrefix("data: ") {
                        let event = try decoder.decode(ChatStreamEvent.self, from: Data(line.dropFirst(6).utf8))
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private struct ChatRequest: Encodable {
        let messages: [WireMessage]
        let format: String
    }

    static func check(_ response: URLResponse, data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard !(200..<300).contains(status) else { return }
        let message = (try? OpenUIJSON.parse(data))?["error"]?.stringValue
            ?? HTTPURLResponse.localizedString(forStatusCode: status)
        throw BackendError.http(status: status, message: message)
    }
}

/// Runs `Query()`/`Mutation()` tools by calling the backend's `POST /tools/<name>`.
nonisolated struct BackendToolProvider: OpenUIToolProvider {
    let baseURL: URL

    func callTool(_ name: String, arguments: OpenUIObject) async throws -> OpenUIValue {
        var request = URLRequest(url: baseURL.appending(path: "tools").appending(path: name))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = Data(OpenUIJSON.stringify(.object(arguments)).utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        try BackendClient.check(response, data: data)
        return try OpenUIJSON.parse(data)
    }
}
