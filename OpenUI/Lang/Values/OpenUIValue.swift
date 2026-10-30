import Foundation

/// A dynamically typed value flowing through the OpenUI pipeline.
///
/// OpenUI Lang is evaluated with JavaScript semantics in the reference implementation, so the
/// runtime works on JSON-like values. On top of plain JSON, two kinds of values can appear in
/// component props:
/// - ``element(_:)``: a parsed component invocation (``ElementNode``).
/// - ``expression(_:)``: a runtime expression (``ASTNode``) preserved by the parser and resolved
///   by the evaluator (state references, query results, operators, action plans, ...).
public enum OpenUIValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([OpenUIValue])
    case object(OpenUIObject)
    case element(ElementNode)
    case expression(ASTNode)
}

// MARK: - Accessors

public extension OpenUIValue {
    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [OpenUIValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: OpenUIObject? {
        if case .object(let value) = self { return value }
        return nil
    }

    var elementValue: ElementNode? {
        if case .element(let value) = self { return value }
        return nil
    }

    var expressionValue: ASTNode? {
        if case .expression(let value) = self { return value }
        return nil
    }

    /// Reads a property the way JavaScript's `value[key]` would (own properties only).
    subscript(key: String) -> OpenUIValue? {
        JS.property(of: self, key: key)
    }

    /// This value with elements and expressions converted (deeply) to their plain JSON object shapes.
    var plainJSON: OpenUIValue {
        switch self {
        case .number(let number) where !number.isFinite:
            return .null
        case .null, .bool, .number, .string:
            return self
        case .array(let items):
            return .array(items.map(\.plainJSON))
        case .object(let object):
            return .object(object.mapValues(\.plainJSON))
        case .element(let element):
            return element.jsonValue
        case .expression(let node):
            return node.jsonValue
        }
    }
}

// MARK: - Literals

extension OpenUIValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) {
        self = .bool(value)
    }
}

extension OpenUIValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) {
        self = .number(Double(value))
    }
}

extension OpenUIValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) {
        self = .number(value)
    }
}

extension OpenUIValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .string(value)
    }
}

extension OpenUIValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: OpenUIValue...) {
        self = .array(elements)
    }
}

extension OpenUIValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, OpenUIValue)...) {
        self = .object(OpenUIObject(elements))
    }
}

extension OpenUIValue: CustomStringConvertible {
    public var description: String {
        JS.jsonStringify(self) ?? "undefined"
    }
}
