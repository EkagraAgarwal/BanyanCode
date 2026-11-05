//! `.scm` query edge extraction for TS/JS/Python.
//!
//! The query sources are `include_str!`d from
//! `src/codegraph/langs/queries/*.scm`, so the TypeScript and Rust backends read
//! the same file: one source of truth, and editing the `.scm` rebuilds the
//! crate.

use super::tree::find_enclosing_callable;
use super::types::{ParsedEdge, SyntaxError};
use std::collections::HashMap;
use tree_sitter::{Language, Node, Query, QueryCursor, StreamingIterator};

pub const TYPESCRIPT_SCM: &str = include_str!("../../../src/codegraph/langs/queries/typescript.scm");
pub const JAVASCRIPT_SCM: &str = include_str!("../../../src/codegraph/langs/queries/javascript.scm");
pub const PYTHON_SCM: &str = include_str!("../../../src/codegraph/langs/queries/python.scm");

pub fn query_source_for(ext: &str) -> Option<&'static str> {
    match ext {
        ".ts" | ".tsx" | ".mts" | ".cts" => Some(TYPESCRIPT_SCM),
        ".js" | ".jsx" | ".mjs" | ".cjs" => Some(JAVASCRIPT_SCM),
        ".py" | ".pyw" => Some(PYTHON_SCM),
        _ => None,
    }
}

// Compiled-query cache keyed by grammar family. `Query` is not `Sync`, so each
// worker thread builds its own through `thread_local!`.
thread_local! {
    static QUERY_CACHE: std::cell::RefCell<HashMap<String, Option<Query>>> =
        std::cell::RefCell::new(HashMap::new());
}

fn with_query<R>(family: &str, language: &Language, source: &str, f: impl FnOnce(&Query) -> R) -> Option<R> {
    QUERY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let entry = cache
            .entry(family.to_string())
            .or_insert_with(|| Query::new(language, source).ok());
        entry.as_ref().map(f)
    })
}

fn quote_string_literal(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') || (first == b'`' && last == b'`') {
            return &raw[1..raw.len() - 1];
        }
    }
    raw
}

struct Capture<'tree> {
    name: String,
    node: Node<'tree>,
}

fn collect_captures<'tree>(
    query: &Query,
    query_match: &tree_sitter::QueryMatch<'tree, 'tree>,
) -> Vec<Capture<'tree>> {
    let names = query.capture_names();
    query_match
        .captures
        .iter()
        .map(|capture| Capture {
            name: names
                .get(capture.index as usize)
                .copied()
                .unwrap_or("")
                .to_string(),
            node: capture.node,
        })
        .collect()
}

fn capture_node<'tree>(captures: &[Capture<'tree>], name: &str) -> Option<Node<'tree>> {
    captures.iter().find(|capture| capture.name == name).map(|capture| capture.node)
}

fn line_of(node: Node<'_>) -> u32 {
    node.start_position().row as u32 + 1
}

pub struct QueryOutcome {
    pub edges: Vec<ParsedEdge>,
    pub syntax_error: Option<SyntaxError>,
}

/// Parse with the grammar, run the `.scm` query for edges, and detect the
/// first syntax error. `normalize` enables the TS false-positive retry.
pub fn run_query_and_extract(
    language: &Language,
    query_source: &str,
    family: &'static str,
    content: &str,
    file_id: &str,
    normalize: bool,
) -> Option<QueryOutcome> {
    let source = content.as_bytes();
    let (syntax_error, edges) = super::tree::with_parser(family, language, content, |tree| {
        let root = tree.root_node();
        let syntax_error =
            super::tree::find_syntax_error(root, source).map(|(line, message)| SyntaxError { line, message });
        let edges = extract_edges(language, query_source, family, root, source, file_id);
        (syntax_error, edges)
    })?;
    let syntax_error = if normalize {
        match syntax_error {
            Some(error) => retry_after_normalize(family, language, content, error),
            None => None,
        }
    } else {
        syntax_error
    };

    Some(QueryOutcome { edges: edges.unwrap_or_default(), syntax_error })
}

fn extract_edges(
    language: &Language,
    query_source: &str,
    family: &'static str,
    root: Node<'_>,
    source: &[u8],
    file_id: &str,
) -> Option<Vec<ParsedEdge>> {
    with_query(family, language, query_source, |query| {
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(query, root, source);
        let mut yield_edges: Vec<ParsedEdge> = Vec::new();
        let mut call_edges: Vec<ParsedEdge> = Vec::new();
        let mut service_edges: Vec<ParsedEdge> = Vec::new();
        // Single pass: `QueryMatch` is not `Clone`, and three passes would run
        // the query three times. Buckets preserve `extractEdgesFromMatches`'s
        // concatenation order (yields, calls, service).
        while let Some(query_match) = matches.next() {
            let captures = collect_captures(query, query_match);

            if let Some(captured) =
                capture_node(&captures, "yielded.arg").or_else(|| capture_node(&captures, "yielded.value"))
            {
                let from_node_id = match find_enclosing_callable(captured) {
                    Some(callable) => format!("{file_id}:function:{}", callable.start_position().row + 1),
                    None => format!("{file_id}:file"),
                };
                let arg_text = captured.utf8_text(source).unwrap_or("");
                yield_edges.push(ParsedEdge {
                    id: format!(
                        "{file_id}:yield:{arg_text}:{}:{}",
                        line_of(captured),
                        query_match.pattern_index
                    ),
                    from_node_id,
                    to_node_id: format!("service:{arg_text}"),
                    kind: "yield",
                    source: Some("tree-sitter"),
                });
            }

            let name_cap = capture_node(&captures, "callee.name");
            let object_cap = capture_node(&captures, "callee.object");
            let property_cap = capture_node(&captures, "callee.property");
            if let Some(target) = name_cap.or(property_cap) {
                if let Some(caller_node) = name_cap.or(object_cap).or(property_cap) {
                    let target_name = target.utf8_text(source).unwrap_or("");
                    let from_node_id = match find_enclosing_callable(caller_node) {
                        Some(callable) => format!("{file_id}:function:{}", callable.start_position().row + 1),
                        None => format!("{file_id}:file"),
                    };
                    call_edges.push(ParsedEdge {
                        id: format!(
                            "{file_id}:calls:{target_name}:{}:{}",
                            line_of(caller_node),
                            query_match.pattern_index
                        ),
                        from_node_id,
                        to_node_id: format!("symbol:{target_name}"),
                        kind: "calls",
                        source: Some("tree-sitter"),
                    });
                }
            }

            if let (Some(class_cap), Some(tag_cap)) = (
                capture_node(&captures, "class.name"),
                capture_node(&captures, "service.tag"),
            ) {
                let tag_text = quote_string_literal(tag_cap.utf8_text(source).unwrap_or("")).to_string();
                if !tag_text.is_empty() {
                    let class_name = class_cap.utf8_text(source).unwrap_or("");
                    service_edges.push(ParsedEdge {
                        id: format!("{file_id}:service_access:{tag_text}:{}", line_of(class_cap)),
                        from_node_id: format!("{file_id}:class:{class_name}:{}", line_of(class_cap)),
                        to_node_id: format!("service:{tag_text}"),
                        kind: "service_access",
                        source: Some("tree-sitter"),
                    });
                }
            }
        }

        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<ParsedEdge> = Vec::new();
        for edge in yield_edges.into_iter().chain(call_edges).chain(service_edges) {
            if seen.insert(edge.id.clone()) {
                out.push(edge);
            }
        }
        out
    })
}

/// Re-parse a repaired copy; suppress the error only when the repair parses
/// cleanly.
fn retry_after_normalize(
    family: &'static str,
    language: &Language,
    content: &str,
    error: SyntaxError,
) -> Option<SyntaxError> {
    let repaired = super::tree::normalize_typescript_for_syntax(content);
    if repaired == content {
        return Some(error);
    }
    let outcome = super::tree::with_parser(family, language, &repaired, |tree| {
        super::tree::find_syntax_error(tree.root_node(), repaired.as_bytes())
    })?;
    match outcome {
        Some(_) => Some(error),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    #[test]
    fn typescript_calls_edges_are_extracted() {
        let source = "export function run() {\n  helper(1)\n}\n";
        let language: Language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        let outcome = run_query_and_extract(&language, TYPESCRIPT_SCM, "typescript", source, "F", true).unwrap();
        assert!(outcome.syntax_error.is_none());
        let call = outcome.edges.iter().find(|e| e.kind == "calls").expect("calls edge");
        assert_eq!(call.to_node_id, "symbol:helper");
        assert_eq!(call.from_node_id, "F:function:1");
    }

    #[test]
    fn python_calls_edges_are_extracted() {
        let source = "def run():\n    helper(1)\n";
        let language: Language = tree_sitter_python::LANGUAGE.into();
        let outcome = run_query_and_extract(&language, PYTHON_SCM, "python", source, "F", false).unwrap();
        let call = outcome.edges.iter().find(|e| e.kind == "calls").expect("calls edge");
        assert_eq!(call.to_node_id, "symbol:helper");
    }
}
