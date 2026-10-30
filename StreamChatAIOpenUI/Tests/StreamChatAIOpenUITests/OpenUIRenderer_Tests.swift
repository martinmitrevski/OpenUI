import OpenUI
@testable import StreamChatAIOpenUI
import StreamChatAI
import SwiftUI
import XCTest

@MainActor
final class OpenUIRenderer_Tests: XCTestCase {
    private struct PlaceCard: AIUIComponent {
        struct Arguments: Decodable {
            let title: String
        }

        let definition = AIUIComponentDefinition(
            name: "place_card",
            description: "A place.",
            parameters: [.required("title", .string, description: "Its Wikipedia title")],
            events: [.init(name: "ask_about", description: "Tapping it asks about the place.")]
        )

        func body(arguments: Arguments, context: AIUIComponentContext) -> some View {
            Text(arguments.title)
        }
    }

    private let placeCard = PlaceCard()

    private let program = """
    root = Card([kaneo, refine])
    kaneo = PlaceCard("Church of St. John at Kaneo")
    refine = Form("refine", buttons, [pace])
    pace = FormControl("Pace", Chips("pace", "single", [ChipItem("relaxed", "Relaxed")]))
    buttons = Buttons([Button("Update the plan", Action([@ToAssistant("Update the plan with my choices")]), "primary")])
    """

    func testTheAgentLearnsTheFenceAndTheAppsComponents() throws {
        let capabilities = OpenUIRenderer().capabilities(components: [placeCard])

        XCTAssertEqual(capabilities["fence"], .string("openui-lang"))
        let instructions = try XCTUnwrap(capabilities["instructions"]?.stringValue)
        XCTAssertTrue(instructions.contains("PlaceCard(title: string) — A place. title: Its Wikipedia title. Tapping it asks about the place."))
        XCTAssertTrue(instructions.contains("| PlaceCard"), "a card can hold the app's components")
    }

    func testAReplyKeepsOneRuntimeThatReadsTheAppsComponents() throws {
        let host = AIUIHost(components: [placeCard]) { OpenUIRenderer() } send: { _ in }
        let engine = try XCTUnwrap(OpenUIRenderer().makeEngine(host: host) as? OpenUIEngine)
        let document = AIUIDocument(format: .openUI, content: .string(program))

        XCTAssertNotNil(engine.view(for: document, messageID: "m1"))
        XCTAssertNotNil(engine.view(for: document, messageID: "m1"))

        XCTAssertEqual(Array(engine.runtimes.keys), ["m1"])
        let runtime = try XCTUnwrap(engine.runtimes["m1"])
        XCTAssertEqual(runtime.root?.typeName, "Card")
        XCTAssertTrue(runtime.parseResult?.meta.errors.isEmpty == true, "\(runtime.parseResult?.meta.errors ?? [])")
    }

    func testWhatThePersonDoesReachesTheHostAsAnAction() async throws {
        var sent: [AIUIAction] = []
        let host = AIUIHost(components: [placeCard]) { OpenUIRenderer() } send: { sent.append($0) }
        let engine = try XCTUnwrap(OpenUIRenderer().makeEngine(host: host) as? OpenUIEngine)
        _ = engine.view(for: AIUIDocument(format: .openUI, content: .string(program)), messageID: "m1")
        let runtime = try XCTUnwrap(engine.runtimes["m1"])

        runtime.onAction?(ActionEvent(
            type: BuiltinActionType.continueConversation,
            params: ["context": "Update the plan with my choices"],
            humanFriendlyMessage: "Update the plan",
            formState: ["pace": "relaxed"],
            formName: "refine"
        ))
        for _ in 0..<10 { await Task.yield() }

        XCTAssertEqual(sent, [AIUIAction(
            messageID: "m1",
            format: .openUI,
            name: "continue_conversation",
            label: "Update the plan",
            payload: [
                "context": .string("Update the plan with my choices"),
                "form": .string("refine"),
                "values": .dictionary(["pace": .string("relaxed")])
            ]
        )])
    }
}
