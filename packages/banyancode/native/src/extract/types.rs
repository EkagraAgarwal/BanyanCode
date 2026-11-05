//! The parser-facing result types, mirroring `langs/types.ts`.

pub use crate::protocol::{Edge as ParsedEdge, Node as ParsedNode};

#[derive(Debug, Clone)]
pub struct SyntaxError {
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParseResult {
    pub nodes: Vec<ParsedNode>,
    pub edges: Vec<ParsedEdge>,
    /// `"tree-sitter"` when the AST pass ran, `"regex"` when only the regex
    /// parser produced the result.
    pub backend: &'static str,
    pub syntax_error: Option<SyntaxError>,
}

impl ParseResult {
    pub fn empty() -> Self {
        Self { nodes: Vec::new(), edges: Vec::new(), backend: "regex", syntax_error: None }
    }
}
