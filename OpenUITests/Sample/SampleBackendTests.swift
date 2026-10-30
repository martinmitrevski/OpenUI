import Foundation
import Testing
@testable import OpenUI

/// Keeps the sample backend in sync with the library: every scripted demo answer must parse
/// cleanly with the chat library, and the system prompt the backend sends to Claude must be the
/// one the library generates.
///
/// Run `SampleBackend/scripts/export-prompt.sh` to regenerate the prompt after changing the
/// library, `tools.json` or `prompt-options.json` (it runs ``systemPromptIsUpToDate()`` with
/// `OPENUI_EXPORT` set).
@Suite("Sample backend")
struct SampleBackendTests {

    static let backend = Fixtures.repositoryRoot.appendingPathComponent("SampleBackend")
    static let scenarios = backend.appendingPathComponent("scenarios")
    static let openUIFiles = backend.appendingPathComponent("openui")

    static var scenarioNames: [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: scenarios.path)) ?? []
        return files.filter { $0.hasSuffix(".openui") }.map { String($0.dropLast(".openui".count)) }.sorted()
    }

    static func toolSpecs() throws -> [OpenUIValue] {
        let tools = try OpenUIJSON.parse(Data(contentsOf: openUIFiles.appendingPathComponent("tools.json")))
        return try #require(tools.arrayValue)
    }

    static func promptOptions() throws -> PromptOptions {
        let sample = try OpenUIJSON.parse(Data(contentsOf: openUIFiles.appendingPathComponent("prompt-options.json")))
        var options = ComponentLibrary.openUIChat.defaultPromptOptions
        options.additionalRules += sample["additionalRules"]?.arrayValue?.compactMap(\.stringValue) ?? []
        options.toolExamples = sample["toolExamples"]?.arrayValue?.compactMap(\.stringValue) ?? []
        options.tools = try toolSpecs().map { tool in
            .spec(ToolSpec(
                name: try #require(tool["name"]?.stringValue),
                description: tool["description"]?.stringValue,
                inputSchema: tool["inputSchema"] ?? [:],
                outputSchema: tool["outputSchema"] ?? [:]
            ))
        }
        return options
    }

    /// Parses a program with the chat library and checks it's complete, valid and only calls known tools.
    static func expectClean(_ program: String, _ label: String) throws {
        let result = ComponentLibrary.openUIChat.parser.parse(program)
        #expect(result.root?.typeName == "Card", "\(label): root")
        #expect(result.meta.errors.isEmpty, "\(label): \(result.meta.errors)")
        #expect(result.meta.unresolved.isEmpty, "\(label): unresolved \(result.meta.unresolved)")
        #expect(result.meta.orphaned.isEmpty, "\(label): orphaned \(result.meta.orphaned)")
        #expect(!result.meta.incomplete, "\(label): incomplete")

        let known = Set(try toolSpecs().compactMap { $0["name"]?.stringValue })
        let calls = result.queryStatements.map(\.toolAST) + result.mutationStatements.map(\.toolAST)
        for call in calls {
            guard case .str(let tool)? = call else {
                Issue.record("\(label): tool name must be a string literal")
                continue
            }
            #expect(known.contains(tool), "\(label): unknown tool \(tool)")
        }
    }

    @Test func scenariosExist() {
        #expect(Self.scenarioNames.count >= 5)
    }

    @Test(arguments: scenarioNames)
    func scenarioParsesCleanly(_ name: String) throws {
        let program = try String(contentsOf: Self.scenarios.appendingPathComponent("\(name).openui"), encoding: .utf8)
            .replacingOccurrences(of: "{{topic}}", with: OpenUIJSON.stringify(.string("Test topic")))
        try Self.expectClean(program, name)

        // Markdown mode answers with the same scenario.
        let markdown = Self.scenarios.appendingPathComponent("\(name).md")
        #expect(FileManager.default.fileExists(atPath: markdown.path), "\(name).md is missing")
    }

    @Test func toolExamplesParseCleanly() throws {
        let examples = try Self.promptOptions().toolExamples
        #expect(!examples.isEmpty)
        for example in examples {
            // "Example N — description:" followed by a blank line and the program.
            let program = try #require(example.range(of: "\n\n")).upperBound
            try Self.expectClean(String(example[program...]), String(example.prefix(40)))
        }
    }

    @Test func systemPromptIsUpToDate() throws {
        let prompt = ComponentLibrary.openUIChat.systemPrompt(try Self.promptOptions())
        let file = Self.openUIFiles.appendingPathComponent("system-prompt.md")

        if ProcessInfo.processInfo.environment["OPENUI_EXPORT"] != nil {
            try prompt.write(to: file, atomically: true, encoding: .utf8)
            return
        }
        let current = try? String(contentsOf: file, encoding: .utf8)
        #expect(current == prompt, "SampleBackend/openui/system-prompt.md is out of date. Run SampleBackend/scripts/export-prompt.sh.")
    }
}
