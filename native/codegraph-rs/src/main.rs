//! banyancode-codegraph-rs: tree-sitter-based codegraph parse binary for BanyanCode.
//!
//! Protocol: reads JSON-lines requests from stdin until EOF, writes one JSON-line
//! response per request to stdout, exits 0.
//!
//! Request (one per line):  `{"op":"parse","fileID":"<id>","lang":"ts|py","content":"<source>"}`
//! Response (one per line): `{"fileID":"<id>","nodes":[...],"edges":[...],"imports":[...]}`
//! Per-file failure:        `{"fileID":"<id>","error":"<msg>"}` (process never crashes).
//!
//! Node id scheme (critical — the JS side keys on it): `${fileID}:${kind}:${name}:${startLine}`.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};

use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node, Parser as TSParser};

// Bounds so a pathological source can't balloon memory on the wire.
const MAX_NODES: usize = 5_000;
const MAX_EDGES: usize = 20_000;
const MAX_CODE_CHARS: usize = 2_000;

// ---------- CLI ----------

#[derive(Parser)]
#[command(
    name = "banyancode-codegraph-rs",
    version,
    about = "Tree-sitter codegraph parse binary for BanyanCode"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read JSON-lines parse requests from stdin; write one JSON-line response per request to stdout.
    ParseBatch {
        /// Source language to parse (ts|py). Selects the tree-sitter grammar.
        #[arg(long, value_enum)]
        lang: Lang,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum Lang {
    Ts,
    Py,
}

// ---------- wire types (must round-trip into the JS ParseResult shape) ----------

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "fileID", default)]
    file_id: String,
    #[serde(default)]
    content: String,
}

#[derive(Serialize)]
struct NodeOut {
    id: String,
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(rename = "startLine")]
    start_line: usize,
    #[serde(rename = "endLine")]
    end_line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

#[derive(Serialize)]
struct EdgeOut {
    id: String,
    #[serde(rename = "fromNodeID")]
    from_node_id: String,
    #[serde(rename = "toNodeID")]
    to_node_id: String,
    kind: String,
}

#[derive(Serialize)]
struct Response {
    #[serde(rename = "fileID")]
    file_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nodes: Option<Vec<NodeOut>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edges: Option<Vec<EdgeOut>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imports: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------- parse state ----------

struct ParseOut {
    nodes: Vec<NodeOut>,
    edges: Vec<EdgeOut>,
    imports: Vec<String>,
    node_ids: HashSet<String>,
    edge_ids: HashSet<String>,
    import_seen: HashSet<String>,
    by_name: HashMap<String, String>,
    skip_starts: HashSet<usize>,
    capped: bool,
    edge_capped: bool,
}

impl Default for ParseOut {
    fn default() -> Self {
        ParseOut {
            nodes: Vec::new(),
            edges: Vec::new(),
            imports: Vec::new(),
            node_ids: HashSet::new(),
            edge_ids: HashSet::new(),
            import_seen: HashSet::new(),
            by_name: HashMap::new(),
            skip_starts: HashSet::new(),
            capped: false,
            edge_capped: false,
        }
    }
}

// ---------- generic helpers ----------

/// Safe byte-range slice of a node's source text (never panics on non-char boundaries).
fn node_text(node: Node, content: &str) -> String {
    content.get(node.start_byte()..node.end_byte()).unwrap_or("").to_string()
}

/// All named children of a node.
fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    let mut out = Vec::new();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            if child.is_named() {
                out.push(child);
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    out
}

/// Value of a named field, or "".
fn field_name(node: Node, field: &str, content: &str) -> String {
    match node.child_by_field_name(field) {
        Some(n) => node_text(n, content).trim().to_string(),
        None => String::new(),
    }
}

/// The `name` field of a declaration node (function/class/method/type/declarator).
fn decl_name(node: Node, content: &str) -> String {
    field_name(node, "name", content)
}

/// Collapse whitespace so ids stay single-line JSON-safe; empty names become `<anonymous>`.
fn sanitize_name(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "<anonymous>".to_string()
    } else {
        collapsed
    }
}

/// Reconstructed call signature, e.g. `export function foo(a: number): number`.
/// Cuts the declaration text at the body (`{`) or arrow (`=>`); python cuts at the
/// first line (its body is indentation-based, not brace-based).
fn fn_signature(node: Node, content: &str, python: bool) -> String {
    let text = node_text(node, content);
    if python {
        return text.lines().next().unwrap_or("").trim().to_string();
    }
    let cut = text
        .find('{')
        .or_else(|| text.find("=>").map(|i| i + 2))
        .unwrap_or(text.len());
    sanitize_name(&text[..cut])
}

/// Strip surrounding quotes from a string-literal source text.
fn strip_quotes(s: &str) -> String {
    let s = s.trim();
    let bytes = s.as_bytes();
    if s.len() >= 2 {
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if first == last && (first == b'"' || first == b'\'') {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

fn emit_node(
    out: &mut ParseOut,
    file_id: &str,
    kind: &str,
    raw_name: String,
    node: Node,
    content: &str,
    with_signature: bool,
    python: bool,
) {
    if out.capped {
        return;
    }
    let name = sanitize_name(&raw_name);
    let start_line = node.start_position().row + 1;
    let end_line = node.end_position().row + 1;
    let id = format!("{file_id}:{kind}:{name}:{start_line}");
    if out.node_ids.contains(&id) {
        return;
    }
    let signature = if with_signature {
        let sig = fn_signature(node, content, python);
        (!sig.is_empty()).then_some(sig)
    } else {
        None
    };
    let full = node_text(node, content);
    let code = (full.chars().count() > MAX_CODE_CHARS)
        .then(|| full.chars().take(MAX_CODE_CHARS).collect());
    out.node_ids.insert(id.clone());
    out.by_name.entry(name.clone()).or_insert_with(|| id.clone());
    out.nodes.push(NodeOut {
        id,
        kind: kind.to_string(),
        name,
        signature,
        start_line,
        end_line,
        code,
    });
    if out.nodes.len() >= MAX_NODES {
        out.capped = true;
    }
}

fn push_edge(out: &mut ParseOut, from: &str, to: &str, kind: &str) {
    if out.edge_capped {
        return;
    }
    let id = format!("{from}->{to}:{kind}");
    if out.edge_ids.contains(&id) {
        return;
    }
    out.edge_ids.insert(id.clone());
    out.edges.push(EdgeOut {
        id,
        from_node_id: from.to_string(),
        to_node_id: to.to_string(),
        kind: kind.to_string(),
    });
    if out.edges.len() >= MAX_EDGES {
        out.edge_capped = true;
    }
}

fn push_import(out: &mut ParseOut, spec: &str) {
    if out.import_seen.contains(spec) {
        return;
    }
    out.import_seen.insert(spec.to_string());
    out.imports.push(spec.to_string());
}

fn push_import_edge(out: &mut ParseOut, file_id: &str, spec: &str, line: usize) {
    let from = format!("{file_id}:import:{spec}:{line}");
    let to = format!("module:{spec}");
    push_edge(out, &from, &to, "imports");
    push_import(out, spec);
}

/// True when a node is the inline fn value of a declaration/assignment — those are
/// emitted as variable/method nodes at the declaration site instead of standalone fns.
fn is_inline_fn_value(node: Node) -> bool {
    match node.parent() {
        Some(parent) => match parent.kind() {
            "variable_declarator" | "public_field" | "public_field_definition" => {
                matches!(parent.child_by_field_name("value"), Some(v) if v.id() == node.id())
            }
            "assignment_expression" => {
                matches!(parent.child_by_field_name("right"), Some(v) if v.id() == node.id())
            }
            _ => false,
        },
        None => false,
    }
}

/// Test heuristic: name-based only (kept simple per contract). `it`/`describe` are
/// calls in real test files, but a top-level fn literally named that is test-y too.
fn kind_for_fn_name(name: &str) -> &'static str {
    if name == "it" || name == "describe" || name.starts_with("test") || name.ends_with("Test") {
        "test"
    } else {
        "function"
    }
}

/// True when the identifier is the declared name of some enclosing declaration.
fn is_decl_name(node: Node) -> bool {
    match node.parent() {
        Some(p) => match p.child_by_field_name("name") {
            Some(n) => n.id() == node.id(),
            None => false,
        },
        None => false,
    }
}

/// True when the identifier lives inside an import clause (skip reference edges there).
fn is_import_context(node: Node) -> bool {
    let mut cur = node.parent();
    let mut depth = 0;
    while let Some(p) = cur {
        let kind = p.kind();
        if kind == "import_statement"
            || kind == "import_clause"
            || kind == "named_imports"
            || kind == "import_specifier"
            || kind == "namespace_import"
            || kind == "import_from_statement"
        {
            return true;
        }
        depth += 1;
        if depth > 8 {
            return false;
        }
        cur = p.parent();
    }
    false
}

/// Resolve a referenced name to a real in-file node id when possible, else a synthetic id.
fn resolve_target(out: &ParseOut, file_id: &str, kind: &str, name: &str, line: usize) -> String {
    match out.by_name.get(name) {
        Some(id) => id.clone(),
        None => format!("{file_id}:{kind}:{name}:{line}"),
    }
}

// ---------- TypeScript ----------

/// JSX heuristic: TSX grammar is a superset of TS, so only switch to it when the
/// content actually looks like JSX. Otherwise plain TS avoids generic/cmp ambiguity.
fn looks_like_tsx(content: &str) -> bool {
    (content.contains("return (") || content.contains("=> (")) && content.contains("</")
}

fn parse_ts(content: &str, file_id: &str, out: &mut ParseOut) -> Result<(), String> {
    let lang: Language = if looks_like_tsx(content) {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    let mut parser = TSParser::new();
    parser
        .set_language(&lang)
        .map_err(|e| format!("failed to load typescript grammar: {e}"))?;
    let tree = parser
        .parse(content, None)
        .ok_or_else(|| "typescript parse produced no tree".to_string())?;
    let root = tree.root_node();
    collect_decls_ts(root, content, file_id, out);
    collect_edges_ts(root, content, file_id, out);
    Ok(())
}

fn collect_decls_ts(node: Node, content: &str, file_id: &str, out: &mut ParseOut) {
    if out.capped {
        return;
    }
    if !out.skip_starts.contains(&node.start_byte()) {
        match node.kind() {
            "function_declaration" | "generator_function_declaration" => {
                let name = decl_name(node, content);
                emit_node(out, file_id, kind_for_fn_name(&name), name, node, content, true, false);
            }
            "arrow_function" | "function_expression" => {
                if !is_inline_fn_value(node) {
                    let name = decl_name(node, content);
                    emit_node(out, file_id, "function", name, node, content, true, false);
                }
            }
            "class_declaration" | "abstract_class_declaration" => {
                emit_node(out, file_id, "class", decl_name(node, content), node, content, false, false);
            }
            "method_definition" => {
                let name = decl_name(node, content);
                if name != "constructor" {
                    emit_node(out, file_id, "method", name, node, content, true, false);
                }
            }
            "public_field" | "public_field_definition" => {
                let is_arrow = matches!(
                    node.child_by_field_name("value"),
                    Some(v) if v.kind() == "arrow_function"
                );
                if is_arrow {
                    emit_node(out, file_id, "method", decl_name(node, content), node, content, true, false);
                }
            }
            "lexical_declaration" => {
                for child in named_children(node) {
                    if child.kind() == "variable_declarator" {
                        let name = decl_name(child, content);
                        if !name.is_empty() {
                            emit_node(out, file_id, "variable", name, child, content, false, false);
                        }
                    }
                }
            }
            "assignment_expression" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        let name = node_text(left, content).trim().to_string();
                        if !name.is_empty() {
                            emit_node(out, file_id, "variable", name, left, content, false, false);
                        }
                    }
                }
            }
            "type_alias_declaration" | "interface_declaration" | "enum_declaration" => {
                emit_node(out, file_id, "type", decl_name(node, content), node, content, false, false);
            }
            _ => {}
        }
    }
    for child in named_children(node) {
        collect_decls_ts(child, content, file_id, out);
    }
}

fn collect_edges_ts(node: Node, content: &str, file_id: &str, out: &mut ParseOut) {
    if out.edge_capped {
        return;
    }
    match node.kind() {
        "import_statement" | "export_statement" => {
            // export_statement with a `source` is a re-export — same edge shape.
            if let Some(src) = node.child_by_field_name("source") {
                let spec = strip_quotes(&node_text(src, content));
                if !spec.is_empty() {
                    let line = node.start_position().row + 1;
                    push_import_edge(out, file_id, &spec, line);
                }
            }
        }
        "class_declaration" | "abstract_class_declaration" => {
            if let Some(superclass) = node.child_by_field_name("superclass") {
                let name = sanitize_name(&node_text(superclass, content));
                if name != "<anonymous>" {
                    let cls_name = sanitize_name(&decl_name(node, content));
                    let line = node.start_position().row + 1;
                    let from = format!("{file_id}:class:{cls_name}:{line}");
                    let to = resolve_target(out, file_id, "class", &name, line);
                    push_edge(out, &from, &to, "extends");
                }
            }
        }
        "call_expression" => {
            let callee = match node.child_by_field_name("function") {
                Some(c) => c,
                None => return,
            };
            let name = match callee.kind() {
                "identifier" => node_text(callee, content).trim().to_string(),
                "member_expression" => match callee.child_by_field_name("property") {
                    Some(p) if p.is_named() => node_text(p, content).trim().to_string(),
                    _ => return,
                },
                _ => return,
            };
            if name.is_empty() {
                return;
            }
            let line = node.start_position().row + 1;
            let from = format!("{file_id}:call:{name}:{line}");
            let to = resolve_target(out, file_id, "function", &name, line);
            push_edge(out, &from, &to, "calls");
        }
        "identifier" => {
            let name = node_text(node, content).trim().to_string();
            if name.is_empty() || !out.by_name.contains_key(&name) {
                return;
            }
            if is_decl_name(node) || is_import_context(node) {
                return;
            }
            let line = node.start_position().row + 1;
            let from = format!("{file_id}:ref:{name}:{line}");
            let to = out.by_name[&name].clone();
            push_edge(out, &from, &to, "references");
        }
        _ => {}
    }
    for child in named_children(node) {
        collect_edges_ts(child, content, file_id, out);
    }
}

// ---------- Python ----------

fn parse_py(content: &str, file_id: &str, out: &mut ParseOut) -> Result<(), String> {
    let lang: Language = tree_sitter_python::LANGUAGE.into();
    let mut parser = TSParser::new();
    parser
        .set_language(&lang)
        .map_err(|e| format!("failed to load python grammar: {e}"))?;
    let tree = parser
        .parse(content, None)
        .ok_or_else(|| "python parse produced no tree".to_string())?;
    let root = tree.root_node();
    collect_decls_py(root, content, file_id, out);
    collect_edges_py(root, content, file_id, out);
    Ok(())
}

/// True when a decorated_definition carries a `@test` / `@pytest.*` decorator.
fn is_test_definition(node: Node, content: &str) -> bool {
    for child in named_children(node) {
        if child.kind() == "decorator" {
            let raw = node_text(child, content);
            let t = raw.trim().trim_start_matches('@');
            if t.starts_with("test") || t.starts_with("pytest") {
                return true;
            }
        }
    }
    false
}

fn collect_decls_py(node: Node, content: &str, file_id: &str, out: &mut ParseOut) {
    if out.capped {
        return;
    }
    let kind = node.kind();
    if !out.skip_starts.contains(&node.start_byte()) {
        match kind {
            "function_definition" => {
                emit_node(out, file_id, "function", decl_name(node, content), node, content, true, true);
            }
            "class_definition" => {
                emit_node(out, file_id, "class", decl_name(node, content), node, content, false, true);
            }
            "decorated_definition" => {
                if is_test_definition(node, content) {
                    if let Some(inner) = named_children(node)
                        .into_iter()
                        .find(|c| c.kind() == "function_definition" || c.kind() == "class_definition")
                    {
                        let name = decl_name(inner, content);
                        emit_node(out, file_id, "test", name, node, content, false, true);
                        out.skip_starts.insert(inner.start_byte());
                    }
                }
            }
            "assignment" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        let name = node_text(left, content).trim().to_string();
                        if !name.is_empty() {
                            emit_node(out, file_id, "variable", name, left, content, false, true);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for child in named_children(node) {
        collect_decls_py(child, content, file_id, out);
    }
}

fn collect_edges_py(node: Node, content: &str, file_id: &str, out: &mut ParseOut) {
    if out.edge_capped {
        return;
    }
    match node.kind() {
        "import_statement" => {
            // `import a, a.b as c` — every dotted_name is a module specifier.
            let line = node.start_position().row + 1;
            let mut specs: Vec<String> = Vec::new();
            collect_py_dotted_names(node, content, &mut specs);
            for spec in specs {
                if !spec.is_empty() {
                    push_import_edge(out, file_id, &spec, line);
                }
            }
        }
        "import_from_statement" => {
            if let Some(module) = node.child_by_field_name("module_name") {
                let spec = node_text(module, content).trim().to_string();
                if !spec.is_empty() {
                    let line = node.start_position().row + 1;
                    push_import_edge(out, file_id, &spec, line);
                }
            }
        }
        "class_definition" => {
            if let Some(supers) = node.child_by_field_name("superclasses") {
                let cls_name = sanitize_name(&decl_name(node, content));
                let line = node.start_position().row + 1;
                let from = format!("{file_id}:class:{cls_name}:{line}");
                for child in named_children(supers) {
                    if child.kind() == "argument_list" {
                        continue;
                    }
                    let name = sanitize_name(&node_text(child, content));
                    if name != "<anonymous>" {
                        let to = resolve_target(out, file_id, "class", &name, line);
                        push_edge(out, &from, &to, "extends");
                    }
                }
            }
        }
        "call" => {
            let callee = match node.child_by_field_name("function") {
                Some(c) => c,
                None => return,
            };
            let name = match callee.kind() {
                "identifier" => node_text(callee, content).trim().to_string(),
                "attribute" => match callee.child_by_field_name("attribute") {
                    Some(a) => node_text(a, content).trim().to_string(),
                    None => return,
                },
                _ => return,
            };
            if name.is_empty() {
                return;
            }
            let line = node.start_position().row + 1;
            let from = format!("{file_id}:call:{name}:{line}");
            let to = resolve_target(out, file_id, "function", &name, line);
            push_edge(out, &from, &to, "calls");
        }
        "identifier" => {
            let name = node_text(node, content).trim().to_string();
            if name.is_empty() || !out.by_name.contains_key(&name) {
                return;
            }
            if is_decl_name(node) || is_import_context(node) {
                return;
            }
            let line = node.start_position().row + 1;
            let from = format!("{file_id}:ref:{name}:{line}");
            let to = out.by_name[&name].clone();
            push_edge(out, &from, &to, "references");
        }
        _ => {}
    }
    for child in named_children(node) {
        collect_edges_py(child, content, file_id, out);
    }
}

/// Collect every `dotted_name` in a python import statement (unwraps aliased imports).
fn collect_py_dotted_names(node: Node, content: &str, specs: &mut Vec<String>) {
    for child in named_children(node) {
        match child.kind() {
            "dotted_name" => {
                let text = node_text(child, content).trim().to_string();
                if !text.is_empty() {
                    specs.push(text);
                }
            }
            "aliased_import" => collect_py_dotted_names(child, content, specs),
            _ => {}
        }
    }
}

// ---------- main loop ----------

fn main() {
    let cli = Cli::parse();
    let Command::ParseBatch { lang } = cli.command;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        // Read error ≈ EOF: stop.
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Malformed JSON line: ignore it, keep the process alive.
        let Ok(req) = serde_json::from_str::<Request>(trimmed) else {
            continue;
        };
        let resp = process(&req, lang);
        if serde_json::to_writer(&mut writer, &resp).is_err() {
            break;
        }
        if writer.write_all(b"\n").is_err() || writer.flush().is_err() {
            break;
        }
    }
}

fn process(req: &Request, lang: Lang) -> Response {
    let file_id = req.file_id.clone();
    if file_id.is_empty() {
        return error_response(file_id, "missing fileID");
    }
    let mut out = ParseOut::default();
    let result = match lang {
        Lang::Ts => parse_ts(&req.content, &file_id, &mut out),
        Lang::Py => parse_py(&req.content, &file_id, &mut out),
    };
    match result {
        Ok(()) => Response {
            file_id,
            nodes: Some(std::mem::take(&mut out.nodes)),
            edges: Some(std::mem::take(&mut out.edges)),
            imports: Some(std::mem::take(&mut out.imports)),
            error: None,
        },
        Err(e) => error_response(file_id, &e),
    }
}

fn error_response(file_id: String, msg: &str) -> Response {
    Response {
        file_id,
        nodes: None,
        edges: None,
        imports: None,
        error: Some(msg.to_string()),
    }
}
