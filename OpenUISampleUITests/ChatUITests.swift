import XCTest

/// End-to-end tests of the chat against the sample backend's scripted demo mode. Start the backend
/// first (`cd SampleBackend && npm run start:demo`); the tests are skipped when it isn't running.
final class ChatUITests: XCTestCase {
    private let backendURL = "http://localhost:8787"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(backendURL)/health")!)
        request.timeoutInterval = 2
        let mode: String?
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            mode = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["mode"] as? String
        } catch {
            throw XCTSkip("The sample backend isn't running. Start it with `npm run start:demo` in SampleBackend.")
        }
        guard mode == "demo" else {
            throw XCTSkip("These tests need the backend's scripted answers. Start it with `npm run start:demo`.")
        }
    }

    @MainActor
    private func launch(format: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ChatFormat", format, "-BackendURL", backendURL, "-SelectedTab", "chat"]
        app.launch()
        return app
    }

    @MainActor
    private func button(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Scrolls the conversation until `element` is in the middle of the screen, clear of the toolbar
    /// and the composer that content scrolls under (answers are taller than the screen).
    @MainActor
    private func scrollIntoView(_ element: XCUIElement, in app: XCUIApplication) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "\(element) exists")
        let window = app.windows.firstMatch.frame
        let middle = window.insetBy(dx: 0, dy: window.height * 0.25)
        for _ in 0..<12 {
            let y = element.frame.midY
            guard y < middle.minY || y > middle.maxY else { break }
            let down = y > middle.maxY
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.65 : 0.35))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.4 : 0.6))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        return element
    }

    /// Waits until the answer has finished streaming (the composer shows Send instead of Stop).
    @MainActor
    private func waitForAnswer(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Stop"].waitForNonExistence(timeout: 30), "the answer finishes")
    }

    /// An OpenUI answer runs a Mutation through the backend, persists its UI state and continues the
    /// conversation from a follow-up.
    @MainActor
    func testOpenUIAnswerIsInteractive() {
        let app = launch(format: "openui")
        button(app, containing: "Give me a quick pasta recipe").tap()
        XCTAssertTrue(app.staticTexts["Spaghetti Carbonara"].waitForExistence(timeout: 15))
        waitForAnswer(app)

        // Tabs follow the content while it streams (as upstream does), so pick the first tab again.
        scrollIntoView(app.buttons["Ingredients"], in: app).tap()
        // @Run(addToList) calls POST /tools/add_to_shopping_list, then @Set($added, true) shows the callout.
        scrollIntoView(button(app, containing: "Add to shopping list"), in: app).tap()
        let confirmation = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Added 6 ingredients")).firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))

        // The state the user left the UI in is kept with the message and shown in its source.
        scrollIntoView(app.buttons["Source"].firstMatch, in: app).tap()
        XCTAssertTrue(app.staticTexts["UI state (sent back with the conversation)"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()

        scrollIntoView(button(app, containing: "Make it vegetarian"), in: app).tap()
        XCTAssertTrue(app.staticTexts["Shakshuka"].waitForExistence(timeout: 15))
        waitForAnswer(app)
    }

    /// The toolbar switch shows answers as plain Markdown.
    @MainActor
    func testMarkdownSwitch() {
        let app = launch(format: "openui")
        app.buttons["Markdown"].tap()
        button(app, containing: "Find hotels in Ohrid under €70").tap()
        XCTAssertTrue(app.staticTexts["Hotels in Ohrid under €70"].waitForExistence(timeout: 15))
        waitForAnswer(app)
        XCTAssertFalse(app.staticTexts["Hotels in Ohrid"].exists, "no OpenUI card header")
    }

    /// Switching formats after an answer shows the other version of the same answer, and switching
    /// back shows the original again without asking again.
    @MainActor
    func testSwitchingFormatsShowsBothVersionsOfAnAnswer() {
        let app = launch(format: "openui")
        button(app, containing: "Plan a 3-day trip to Ohrid").tap()
        let openUIOnly = app.staticTexts["Tap a photo to ask about it"]
        XCTAssertTrue(openUIOnly.waitForExistence(timeout: 15))
        waitForAnswer(app)

        app.buttons["Markdown"].tap()
        let markdownOnly = app.staticTexts["Want more detail? Ask for the St. Naum day trip or the top sights."]
        XCTAssertTrue(markdownOnly.waitForExistence(timeout: 15))
        XCTAssertFalse(openUIOnly.exists)
        waitForAnswer(app)

        app.buttons["OpenUI"].tap()
        XCTAssertTrue(openUIOnly.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["Stop"].exists, "the OpenUI version is kept, not written again")
    }
}
