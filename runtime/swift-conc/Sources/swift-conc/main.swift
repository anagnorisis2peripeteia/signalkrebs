// swift-conc — the SwiftSyntax analysis engine for signalkrebs's swift-async lane.
//
// Swift's structured-concurrency bug class is invisible to ThreadSanitizer (the swift-tsan lane):
// a CheckedContinuation that some path never resumes hangs the awaiting caller forever; one resumed
// twice crashes; an AsyncStream never finished hangs its consumer; actor state mutated across an
// await is a logical race; a discarded `Task {}` outlives its owner. This analyzer reads the real
// syntax tree and emits JSON findings [{Rule, Kind, File, Line, Message}], exit 1 when any found.
//
// Precision note on continuations: the resume almost always happens INSIDE a nested callback
// closure (`api.fetch { r in cont.resume(returning: r) }`), so a naive "does the body resume?"
// check false-positives on nearly every real use. The hard rules are therefore scoped to two
// high-precision shapes and treat nested closures as opaque (they may resume):
//   SA001a  the continuation closure calls resume NOWHERE (recursively) → guaranteed hang
//   SA001b  a `guard`/`if` early-exit whose OWN exit path never resumes  → the classic forgot-to-
//           resume-on-error bug
// Advisory rules (surfaced, not hard-failing): SA002 double-resume, SA003 AsyncStream never
// finished, SA004 actor state across await, SA005 fire-and-forget Task.

import Foundation
import SwiftSyntax
import SwiftParser

struct Finding: Codable {
    let Rule: String
    let Kind: String
    let File: String
    let Line: Int
    let Message: String
}

let CONTINUATION_MAKERS: Set<String> = [
    "withCheckedContinuation", "withCheckedThrowingContinuation",
    "withUnsafeContinuation", "withUnsafeThrowingContinuation",
]
let STREAM_MAKERS: Set<String> = ["AsyncStream", "AsyncThrowingStream"]
let TERMINATORS: Set<String> = ["fatalError", "preconditionFailure", "abort", "exit"]

// ---------- small syntax helpers ----------

func calleeName(_ call: FunctionCallExprSyntax) -> String? {
    if let d = call.calledExpression.as(DeclReferenceExprSyntax.self) { return d.baseName.text }
    if let g = call.calledExpression.as(GenericSpecializationExprSyntax.self),
       let d = g.expression.as(DeclReferenceExprSyntax.self) { return d.baseName.text }
    return nil
}

/// `base.member(...)` — e.g. `cont.resume(...)` or `Task.detached { }`.
func isMemberCall(_ call: FunctionCallExprSyntax, base: String, member: String) -> Bool {
    guard let m = call.calledExpression.as(MemberAccessExprSyntax.self),
          m.declName.baseName.text == member,
          let b = m.base?.as(DeclReferenceExprSyntax.self) else { return false }
    return b.baseName.text == base
}

/// The first closure parameter's name (`{ cont in … }` → "cont"), or "$0" for the shorthand form.
func closureParamName(_ closure: ClosureExprSyntax) -> String {
    guard let sig = closure.signature, let clause = sig.parameterClause else { return "$0" }
    switch clause {
    case .simpleInput(let list):
        if let first = list.first { return first.name.text }
    case .parameterClause(let params):
        if let first = params.parameters.first { return first.firstName.text }
    }
    return "$0"
}

/// The trailing closure of a call (or a single closure argument), if any.
func continuationClosure(_ call: FunctionCallExprSyntax) -> ClosureExprSyntax? {
    if let t = call.trailingClosure { return t }
    if call.arguments.count == 1, let c = call.arguments.first?.expression.as(ClosureExprSyntax.self) { return c }
    return nil
}

// ---------- collectors (recursive, over a subtree) ----------

/// Counts `base.member(...)` calls anywhere below a node. Descends into nested closures too, so a
/// resume in a completion handler still counts for the zero-resume check.
final class MemberCallCollector: SyntaxVisitor {
    let base: String, member: String, conv: SourceLocationConverter
    var lines: [Int] = []
    init(_ base: String, _ member: String, _ conv: SourceLocationConverter) {
        self.base = base; self.member = member; self.conv = conv
        super.init(viewMode: .sourceAccurate)
    }
    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        if isMemberCall(node, base: base, member: member) {
            lines.append(conv.location(for: node.positionAfterSkippingLeadingTrivia).line)
        }
        return .visitChildren
    }
}

/// True if the block calls a never-returning terminator (`fatalError()` etc.) directly — an exit
/// that ends the process rather than leaking the continuation.
final class TerminatorFinder: SyntaxVisitor {
    var found = false
    init() { super.init(viewMode: .sourceAccurate) }
    override func visit(_ n: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        if let name = calleeName(n), TERMINATORS.contains(name) { found = true }
        return .visitChildren
    }
}
func hasTerminator(_ node: some SyntaxProtocol) -> Bool {
    let v = TerminatorFinder(); v.walk(node); return v.found
}

/// The continuation ESCAPES the closure if it is referenced as anything other than the receiver of a
/// `cont.<method>` call (`cont.resume`, `cont.yield`, `cont.finish`, `cont.onTermination = …`) —
/// i.e. passed as an argument, stored on self, appended to a queue, assigned to a var. When it
/// escapes, resume/finish happens ELSEWHERE (a waiter queue, an actor's pending map — a common and
/// correct pattern), so the in-closure resume-coverage rules (SA001/SA003) cannot conclude a leak.
final class ContinuationEscapeFinder: SyntaxVisitor {
    let cont: String; var escapes = false
    init(_ cont: String) { self.cont = cont; super.init(viewMode: .sourceAccurate) }
    override func visit(_ n: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
        guard n.baseName.text == cont else { return .visitChildren }
        // `cont` as the base of a member access (`cont.resume(...)`) is a method call on it, not an
        // escape. Every other reference hands the continuation off.
        if let member = n.parent?.as(MemberAccessExprSyntax.self),
           member.base?.as(DeclReferenceExprSyntax.self)?.baseName.text == cont {
            return .visitChildren
        }
        escapes = true
        return .visitChildren
    }
}
func continuationEscapes(_ node: some SyntaxProtocol, _ cont: String) -> Bool {
    let v = ContinuationEscapeFinder(cont); v.walk(node); return v.escapes
}

func countResumes(_ node: some SyntaxProtocol, _ cont: String, _ conv: SourceLocationConverter) -> [Int] {
    let c = MemberCallCollector(cont, "resume", conv); c.walk(node); return c.lines
}

// ---------- the analyzer ----------

final class ConcurrencyAnalyzer: SyntaxVisitor {
    let file: String
    let conv: SourceLocationConverter
    var findings: [Finding] = []

    init(file: String, tree: SourceFileSyntax) {
        self.file = file
        self.conv = SourceLocationConverter(fileName: file, tree: tree)
        super.init(viewMode: .sourceAccurate)
    }

    func line(_ node: some SyntaxProtocol) -> Int {
        conv.location(for: node.positionAfterSkippingLeadingTrivia).line
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        if let name = calleeName(node) {
            if CONTINUATION_MAKERS.contains(name), let closure = continuationClosure(node) {
                analyzeContinuation(name: name, call: node, closure: closure)
            } else if STREAM_MAKERS.contains(name), let closure = continuationClosure(node) {
                analyzeStream(name: name, call: node, closure: closure)
            }
        }
        return .visitChildren
    }

    // ---- SA001/SA002: CheckedContinuation resume coverage ----
    func analyzeContinuation(name: String, call: FunctionCallExprSyntax, closure: ClosureExprSyntax) {
        let cont = closureParamName(closure)

        // SA002 — two resumes reachable in sequence (no branch/exit between): a runtime crash. This
        // applies whether or not the continuation escapes.
        let dv = DoubleResumeVisitor(cont: cont, file: file, conv: conv, continuationName: name)
        dv.walk(closure.statements)
        findings.append(contentsOf: dv.findings)

        // SA001 resume-coverage ONLY applies when the continuation does NOT escape the closure. A
        // stored continuation (waiter queue, actor pending map, timeout task) is resumed elsewhere —
        // the common, correct pattern — and reasoning about its coverage needs cross-function
        // analysis this lane deliberately does not attempt. Suppress to stay high-precision.
        if continuationEscapes(closure.statements, cont) { return }

        let resumes = countResumes(closure.statements, cont, conv)
        // SA001a — the continuation is NEVER resumed and never stored: the awaiting caller hangs.
        if resumes.isEmpty {
            findings.append(Finding(
                Rule: "SA001", Kind: "continuation-misuse", File: file, Line: line(call),
                Message: "`\(name)` closure never calls `\(cont).resume(...)` on any path and never stores the continuation — the awaiting caller hangs forever"))
            return
        }

        // SA001b — a guard/if whose early-exit path never resumes (the forgot-to-resume-on-error
        // bug). Scope to the direct control flow: nested closures (where resume usually lives) are
        // opaque, so we never false-positive on the callback pattern.
        let gv = EarlyExitLeakVisitor(cont: cont, file: file, conv: conv, continuationName: name)
        gv.walk(closure.statements)
        findings.append(contentsOf: gv.findings)
    }

    // ---- SA003: AsyncStream never finished (advisory) ----
    func analyzeStream(name: String, call: FunctionCallExprSyntax, closure: ClosureExprSyntax) {
        let cont = closureParamName(closure)
        let finishes = MemberCallCollector(cont, "finish", conv); finishes.walk(closure.statements)
        let escapes = continuationEscapes(closure.statements, cont)
        if finishes.lines.isEmpty && !escapes {
            findings.append(Finding(
                Rule: "SA003", Kind: "continuation-misuse", File: file, Line: line(call),
                Message: "advisory: `\(name)` closure never calls `\(cont).finish()` and does not store the continuation — consumers may hang waiting for the stream to end"))
        }
    }

    // ---- SA005: fire-and-forget Task (advisory) ----
    override func visit(_ node: CodeBlockItemSyntax) -> SyntaxVisitorContinueKind {
        if case .expr(let expr) = node.item, let call = expr.as(FunctionCallExprSyntax.self) {
            // Only Task.detached is genuinely unstructured — it inherits NO priority, task-local
            // values, or cancellation from its context. A bare `Task { }` DOES inherit those and is
            // an extremely common intentional pattern (e.g. bridging into an onCancel handler), so
            // flagging every one is pure noise (63 in Tachikoma, all intentional). Scope SA005 to a
            // discarded Task.detached.
            if isMemberCall(call, base: "Task", member: "detached"), continuationClosure(call) != nil {
                findings.append(Finding(
                    Rule: "SA005", Kind: "goroutine-leak", File: file, Line: line(call),
                    Message: "advisory: discarded `Task.detached { }` — detached work inherits no cancellation, priority, or task-local context from its caller and cannot be awaited"))
            }
        }
        return .visitChildren
    }

    // ---- SA004: actor state mutated across an await (advisory) ----
    override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind {
        for member in node.memberBlock.members {
            if let fn = member.decl.as(FunctionDeclSyntax.self), let body = fn.body {
                analyzeActorMethod(body)
            }
        }
        return .visitChildren
    }

    func analyzeActorMethod(_ body: CodeBlockSyntax) {
        let awaits = FirstAwaitFinder(); awaits.walk(body)
        guard let awaitOffset = awaits.firstAwaitOffset else { return }
        let reads = PropertyRefFinder(before: awaitOffset); reads.walk(body)
        let writes = PropertyWriteFinder(after: awaitOffset, conv: conv); writes.walk(body)
        for w in writes.writes where reads.names.contains(w.name) {
            findings.append(Finding(
                Rule: "SA004", Kind: "toctou", File: file, Line: w.line,
                Message: "advisory: actor property `\(w.name)` read before an `await` and mutated after it — the earlier value may be stale across the suspension point (actor reentrancy)"))
        }
    }
}

// ---- SA001b: an early-exit whose own path never resumes ----
final class EarlyExitLeakVisitor: SyntaxVisitor {
    let cont: String, file: String, conv: SourceLocationConverter, continuationName: String
    var findings: [Finding] = []
    init(cont: String, file: String, conv: SourceLocationConverter, continuationName: String) {
        self.cont = cont; self.file = file; self.conv = conv; self.continuationName = continuationName
        super.init(viewMode: .sourceAccurate)
    }
    // Nested closures are opaque: the resume for the direct flow may live inside a callback.
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }

    override func visit(_ node: GuardStmtSyntax) -> SyntaxVisitorContinueKind {
        if countResumes(node.body, cont, conv).isEmpty && !hasTerminator(node.body) {
            findings.append(Finding(
                Rule: "SA001", Kind: "continuation-misuse", File: file,
                Line: conv.location(for: node.positionAfterSkippingLeadingTrivia).line,
                Message: "`guard` else path exits `\(continuationName)` without calling `\(cont).resume(...)` — this failure path hangs the awaiting caller"))
        }
        return .visitChildren
    }
    override func visit(_ node: IfExprSyntax) -> SyntaxVisitorContinueKind {
        if node.elseBody == nil, blockExitsWithoutResume(node.body) {
            findings.append(Finding(
                Rule: "SA001", Kind: "continuation-misuse", File: file,
                Line: conv.location(for: node.positionAfterSkippingLeadingTrivia).line,
                Message: "`if` early-return exits `\(continuationName)` without calling `\(cont).resume(...)` — this branch hangs the awaiting caller"))
        }
        return .visitChildren
    }
    func blockExitsWithoutResume(_ body: CodeBlockSyntax) -> Bool {
        guard let last = body.statements.last?.item else { return false }
        let exits = last.is(ReturnStmtSyntax.self) || last.is(ThrowStmtSyntax.self)
            || last.is(BreakStmtSyntax.self) || last.is(ContinueStmtSyntax.self)
        return exits && countResumes(body, cont, conv).isEmpty && !hasTerminator(body)
    }
}

// ---- SA002: two resumes reachable in sequence ----
final class DoubleResumeVisitor: SyntaxVisitor {
    let cont: String, file: String, conv: SourceLocationConverter, continuationName: String
    var findings: [Finding] = []
    init(cont: String, file: String, conv: SourceLocationConverter, continuationName: String) {
        self.cont = cont; self.file = file; self.conv = conv; self.continuationName = continuationName
        super.init(viewMode: .sourceAccurate)
    }
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: CodeBlockItemListSyntax) -> SyntaxVisitorContinueKind {
        var sawResume = false
        for item in node {
            if case .expr(let e) = item.item, let call = e.as(FunctionCallExprSyntax.self),
               isMemberCall(call, base: cont, member: "resume") {
                if sawResume {
                    findings.append(Finding(
                        Rule: "SA002", Kind: "continuation-misuse", File: file,
                        Line: conv.location(for: call.positionAfterSkippingLeadingTrivia).line,
                        Message: "advisory: `\(cont).resume(...)` is reached twice in sequence — resuming a continuation more than once is a fatal runtime error"))
                }
                sawResume = true
            } else if case .stmt(let s) = item.item,
                      s.is(ReturnStmtSyntax.self) || s.is(ThrowStmtSyntax.self)
                      || s.is(BreakStmtSyntax.self) || s.is(ContinueStmtSyntax.self) {
                sawResume = false
            }
        }
        return .visitChildren
    }
}

// ---- SA004 support ----
final class FirstAwaitFinder: SyntaxVisitor {
    var firstAwaitOffset: Int?
    init() { super.init(viewMode: .sourceAccurate) }
    override func visit(_ node: AwaitExprSyntax) -> SyntaxVisitorContinueKind {
        if firstAwaitOffset == nil { firstAwaitOffset = node.positionAfterSkippingLeadingTrivia.utf8Offset }
        return .visitChildren
    }
}
final class PropertyRefFinder: SyntaxVisitor {
    let before: Int; var names: Set<String> = []
    init(before: Int) { self.before = before; super.init(viewMode: .sourceAccurate) }
    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
        if let b = node.base?.as(DeclReferenceExprSyntax.self), b.baseName.text == "self",
           node.positionAfterSkippingLeadingTrivia.utf8Offset < before {
            names.insert(node.declName.baseName.text)
        }
        return .visitChildren
    }
}
final class PropertyWriteFinder: SyntaxVisitor {
    let after: Int; let conv: SourceLocationConverter
    var writes: [(name: String, line: Int)] = []
    init(after: Int, conv: SourceLocationConverter) { self.after = after; self.conv = conv; super.init(viewMode: .sourceAccurate) }
    override func visit(_ node: InfixOperatorExprSyntax) -> SyntaxVisitorContinueKind {
        guard node.operator.is(AssignmentExprSyntax.self) else { return .visitChildren }
        if let m = node.leftOperand.as(MemberAccessExprSyntax.self),
           let b = m.base?.as(DeclReferenceExprSyntax.self), b.baseName.text == "self",
           m.positionAfterSkippingLeadingTrivia.utf8Offset > after {
            writes.append((m.declName.baseName.text, conv.location(for: m.positionAfterSkippingLeadingTrivia).line))
        }
        return .visitChildren
    }
}

// ---------- driver ----------

let args = Array(CommandLine.arguments.dropFirst()).filter { $0 != "--json" }
var all: [Finding] = []
for path in args {
    guard let src = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
    let tree = Parser.parse(source: src)
    let analyzer = ConcurrencyAnalyzer(file: path, tree: tree)
    analyzer.walk(tree)
    all.append(contentsOf: analyzer.findings)
}
let data = try JSONEncoder().encode(all)
print(String(data: data, encoding: .utf8) ?? "[]")
exit(all.isEmpty ? 0 : 1)
