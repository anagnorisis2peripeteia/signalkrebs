using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;

// csharp-conc — the C#/.NET concurrency detector for signalkrebs's Roslyn lane.
//
// Static, semantic, high-precision detectors (resolved through a real compilation, so they
// never mis-fire on same-named non-Task types):
//   CC001 sync-over-async — `.Result` / `.Wait()` / `.GetAwaiter().GetResult()` on a Task/ValueTask
//         blocks the calling thread on an async operation; in a captured sync context this deadlocks.
//   CC002 async-void      — an `async` method returning `void` (not Task): its exceptions are
//         unobservable and crash the process. (Event handlers `(object, EventArgs)` are excluded.)
//   CC003 fire-and-forget — a bare Task-returning call as a statement, never awaited or assigned:
//         its exceptions are swallowed and completion is never observed.

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: csharp-conc <path-to-.csproj-or-.sln> [--json]");
    return 2;
}

var target = args[0];
var asJson = args.Contains("--json");

var instance = MSBuildLocator.RegisterDefaults();
Console.Error.WriteLine($"[conc] MSBuild {instance.Version}");

using var workspace = MSBuildWorkspace.Create();
workspace.WorkspaceFailed += (_, e) =>
{
    if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
        Console.Error.WriteLine($"[conc][ws] {e.Diagnostic.Message}");
};

var projects = new List<Project>();
if (target.EndsWith(".sln") || target.EndsWith(".slnx") || target.EndsWith(".slnf"))
    projects.AddRange((await workspace.OpenSolutionAsync(target)).Projects);
else
    projects.Add(await workspace.OpenProjectAsync(target));

Console.Error.WriteLine($"[conc] loaded {projects.Count} project(s)");

var findings = new List<Finding>();

foreach (var project in projects)
{
    var compilation = await project.GetCompilationAsync();
    if (compilation is null) continue;

    var task = compilation.GetTypeByMetadataName("System.Threading.Tasks.Task");
    var taskT = compilation.GetTypeByMetadataName("System.Threading.Tasks.Task`1");
    var valueTask = compilation.GetTypeByMetadataName("System.Threading.Tasks.ValueTask");
    var valueTaskT = compilation.GetTypeByMetadataName("System.Threading.Tasks.ValueTask`1");
    var eventArgs = compilation.GetTypeByMetadataName("System.EventArgs");

    bool IsAwaitable(ITypeSymbol? t)
    {
        if (t is null) return false;
        foreach (var known in new[] { task, valueTask })
            if (known is not null && SymbolEqualityComparer.Default.Equals(t, known)) return true;
        if (t is INamedTypeSymbol nt && nt.IsGenericType)
            foreach (var known in new[] { taskT, valueTaskT })
                if (known is not null && SymbolEqualityComparer.Default.Equals(nt.OriginalDefinition, known)) return true;
        return false;
    }

    foreach (var tree in compilation.SyntaxTrees)
    {
        if (tree.FilePath.Contains("/obj/") || tree.FilePath.Contains("\\obj\\")) continue;
        var model = compilation.GetSemanticModel(tree);
        var root = await tree.GetRootAsync();

        // CC001 sync-over-async — .Result / .Wait() / .GetAwaiter().GetResult()
        foreach (var ma in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
        {
            var name = ma.Name.Identifier.Text;
            if (name == "Result" && IsAwaitable(model.GetTypeInfo(ma.Expression).Type) && !IsCompletionGuarded(ma))
                Add(findings, "CC001-sync-over-async", "channel-misuse", tree, ma.GetLocation(),
                    "blocking '.Result' on a Task — this blocks the thread on an async operation and deadlocks under a captured sync context; await it instead");
            else if (ma.Parent is InvocationExpressionSyntax { ArgumentList.Arguments.Count: 0 } && name == "Wait" && IsAwaitable(model.GetTypeInfo(ma.Expression).Type))
                Add(findings, "CC001-sync-over-async", "channel-misuse", tree, ma.GetLocation(),
                    "blocking '.Wait()' on a Task — blocks the thread and deadlocks under a captured sync context; await it instead");
            else if (ma.Parent is InvocationExpressionSyntax && name == "GetResult"
                     && ma.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "GetAwaiter" } gi }
                     && IsAwaitable(model.GetTypeInfo(gi.Expression).Type))
                Add(findings, "CC001-sync-over-async", "channel-misuse", tree, ma.GetLocation(),
                    "blocking '.GetAwaiter().GetResult()' on a Task — synchronously waits on an async operation; await it instead");
        }

        // CC002 async-void (non event-handler)
        foreach (var m in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            if (!m.Modifiers.Any(t => t.IsKind(SyntaxKind.AsyncKeyword))) continue;
            if (m.ReturnType is not PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.VoidKeyword }) continue;
            if (IsEventHandler(m, model, eventArgs)) continue;
            Add(findings, "CC002-async-void", "goroutine-leak", tree, m.Identifier.GetLocation(),
                $"async void method '{m.Identifier.Text}' — an exception in it cannot be observed by any caller and crashes the process; return Task");
        }

        // CC003 fire-and-forget Task (a bare Task-returning call as a statement, not awaited/assigned)
        foreach (var es in root.DescendantNodes().OfType<ExpressionStatementSyntax>())
        {
            if (es.Expression is not InvocationExpressionSyntax inv) continue; // `await x` is an AwaitExpression, not this
            if (!IsAwaitable(model.GetTypeInfo(inv).Type)) continue;
            Add(findings, "CC003-fire-and-forget", "goroutine-leak", tree, inv.GetLocation(),
                "a Task-returning call is discarded as a statement (never awaited or assigned) — its exceptions are swallowed and completion is never observed; await it or assign to '_ =' deliberately");
        }

        // CC004 field-mutated-across-await — a field read into a local BEFORE an await, then the
        // same field written AFTER it: another task can change the field during the await, so the
        // write clobbers a concurrent update (C#'s require-atomic-updates / check-then-act). Advisory
        // (over-fires on lock/SemaphoreSlim-serialized sections) — the adapter marks it non-hard-fail.
        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            SyntaxNode? body = (SyntaxNode?)method.Body ?? method.ExpressionBody;
            if (body is null) continue;
            var awaits = body.DescendantNodes().OfType<AwaitExpressionSyntax>().Select(a => a.SpanStart).ToList();
            if (awaits.Count == 0) continue;
            var firstAwait = awaits.Min();

            var readBefore = new HashSet<string>();
            foreach (var node in body.DescendantNodes())
            {
                if (node.SpanStart >= firstAwait) continue;
                ExpressionSyntax? rhs = node switch
                {
                    EqualsValueClauseSyntax ev => ev.Value,          // var v = this.x
                    AssignmentExpressionSyntax a => a.Right,          // v = this.x
                    _ => null,
                };
                var fn = FieldNameOf(rhs, model);
                if (fn is not null) readBefore.Add(fn);
            }
            if (readBefore.Count == 0) continue;

            foreach (var asg in body.DescendantNodes().OfType<AssignmentExpressionSyntax>())
            {
                if (asg.SpanStart <= firstAwait) continue;
                var fn = FieldNameOf(asg.Left, model);
                if (fn is not null && readBefore.Contains(fn))
                    Add(findings, "CC004-field-across-await", "toctou", tree, asg.GetLocation(),
                        $"field '{fn}' is read before an await and written after it — a check-then-act across the await; another task can change '{fn}' during the await and this write clobbers it (guard the section or make the update atomic)");
            }
        }
    }
}

var ordered = findings
    .GroupBy(f => (f.File, f.Line, f.Rule))
    .Select(g => g.First())
    .OrderBy(f => f.File).ThenBy(f => f.Line)
    .ToList();

if (asJson)
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(ordered,
        new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
else
{
    foreach (var f in ordered) Console.WriteLine($"{f.Rule}  {Short(f.File)}:{f.Line}  {f.Message}");
    Console.WriteLine();
    Console.WriteLine($"[conc] {ordered.Count} finding(s): "
        + $"{ordered.Count(f => f.Rule.StartsWith("CC001"))} sync-over-async, "
        + $"{ordered.Count(f => f.Rule.StartsWith("CC002"))} async-void, "
        + $"{ordered.Count(f => f.Rule.StartsWith("CC003"))} fire-and-forget, "
        + $"{ordered.Count(f => f.Rule.StartsWith("CC004"))} field-across-await.");
}

return ordered.Count == 0 ? 0 : 1;

static void Add(List<Finding> findings, string rule, string kind, SyntaxTree tree, Location loc, string message)
    => findings.Add(new Finding(rule, kind, tree.FilePath, loc.GetLineSpan().StartLinePosition.Line + 1, message));

// `.Result` inside a conditional that first checks the SAME task's completion (`t.Status ==
// RanToCompletion`, `t.IsCompleted`, `t.IsCompletedSuccessfully`) never blocks — the task is
// already done — so it is not sync-over-async.
static bool IsCompletionGuarded(MemberAccessExpressionSyntax resultAccess)
{
    var taskText = resultAccess.Expression.ToString();
    foreach (var anc in resultAccess.Ancestors())
    {
        ExpressionSyntax? cond = anc switch
        {
            ConditionalExpressionSyntax c => c.Condition,
            IfStatementSyntax f => f.Condition,
            WhileStatementSyntax w => w.Condition,
            _ => null,
        };
        if (cond is null) continue;
        var t = cond.ToString();
        if (t.Contains(taskText + ".Status") || t.Contains(taskText + ".IsCompleted")) return true;
    }
    return false;
}

// An event handler is `void M(object sender, EventArgs e)` — async void there is the sanctioned form.
static bool IsEventHandler(MethodDeclarationSyntax m, SemanticModel model, INamedTypeSymbol? eventArgs)
{
    var ps = m.ParameterList.Parameters;
    if (ps.Count != 2 || eventArgs is null) return false;
    var second = ps[1].Type is null ? null : model.GetTypeInfo(ps[1].Type!).Type;
    for (var t = second; t is not null; t = t.BaseType)
        if (SymbolEqualityComparer.Default.Equals(t, eventArgs)) return true;
    return false;
}

// The mutable instance field a read/write expression resolves to (this.x / bare field / _x), else
// null. Used by CC004 to correlate a pre-await read with a post-await write of the same field.
static string? FieldNameOf(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? expr, SemanticModel model)
{
    if (expr is null) return null;
    if (model.GetSymbolInfo(expr).Symbol is IFieldSymbol { IsConst: false, IsStatic: false } f)
        return f.Name;
    return null;
}

static string Short(string path)
{
    var i = path.IndexOf("/src/", StringComparison.Ordinal);
    if (i >= 0) return path[(i + 1)..];
    i = path.IndexOf("\\src\\", StringComparison.Ordinal);
    return i >= 0 ? path[(i + 1)..] : path;
}

record Finding(string Rule, string Kind, string File, int Line, string Message);
