//! `langs/python.ts` ported to Rust.

use super::types::{ParseResult, ParsedEdge, ParsedNode};
use crate::text::{decl_start_line, line_at_offset, line_start_offsets, slice};
use fancy_regex::Regex;
use once_cell::sync::Lazy;

static FROM_IMPORT_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"from[\s\u{feff}]+(["'])([^"']+)\1[\s\u{feff}]+import[\s\u{feff}]+"#).unwrap());
// NOTE: the TypeScript parser reads `match[3]` here, but this pattern only has
// two capture groups, so `match[3]` is always undefined and the loop never
// emits an edge. Kept as-is (and asserted by the parity test) rather than
// "fixed": changing it would add imports edges the TypeScript backend does not
// produce, which is a graph change, not a bug fix.
#[allow(dead_code)]
static IMPORT_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)^import[\s\u{feff}]+(?:\{[^}]*\}|[A-Za-z0-9_]+|\*[\s\u{feff}]+as[\s\u{feff}]+[A-Za-z0-9_]+)[\s\u{feff}]+from[\s\u{feff}]+(["'])([^"']+)\2"#).unwrap()
});
static CLASS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)class[\s\u{feff}]+([A-Za-z0-9_]+)(?:[\s\u{feff}]*\([\s\u{feff}]*([A-Za-z0-9_]+)[\s\u{feff}]*\))?").unwrap()
});
static DEF_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\n)def[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*\(").unwrap());

const PY_BODY_CHAR_BOUND: usize = 16384;
const PY_BODY_LINE_BOUND: u32 = 2048;

fn leading_ws_len(content: &str, from: usize, to: usize) -> usize {
    let mut count = 0usize;
    while from + count < to {
        let ch = content[from + count..].chars().next().unwrap();
        if !crate::text::is_js_ws(ch) {
            break;
        }
        count += ch.len_utf8();
    }
    count
}

/// `getPythonNodeBody`: indent-driven block capture.
fn get_python_node_body(content: &str, offsets: &[usize], match_index: usize) -> (String, u32) {
    let decl_index = crate::text::decl_index_at(content, match_index);
    let mut next_newline = content[decl_index.min(content.len())..].find('\n').map(|r| decl_index + r);
    let decl_indent = leading_ws_len(content, decl_index, next_newline.unwrap_or(content.len()));

    let start_offset = match_index;
    let mut end_offset = next_newline.unwrap_or(content.len());
    let mut lines = 1u32;
    let mut block_indent: Option<usize> = None;

    while let Some(newline) = next_newline {
        if end_offset - start_offset >= PY_BODY_CHAR_BOUND || lines >= PY_BODY_LINE_BOUND {
            break;
        }
        let line_start = newline + 1;
        let line_end_newline = content[line_start.min(content.len())..].find('\n').map(|r| line_start + r);
        let line_end = line_end_newline.unwrap_or(content.len());
        let indent = leading_ws_len(content, line_start, line_end);
        let first_code = line_start + indent;
        if first_code == line_end || content[first_code..].starts_with('#') {
            end_offset = line_end;
            lines += 1;
        } else if block_indent.is_none() {
            if indent > decl_indent {
                block_indent = Some(indent);
                end_offset = line_end;
                lines += 1;
            } else {
                break;
            }
        } else if indent >= block_indent.unwrap_or(0) || indent > decl_indent {
            end_offset = line_end;
            lines += 1;
        } else {
            break;
        }
        next_newline = line_end_newline;
    }

    (slice(content, match_index, end_offset), line_at_offset(offsets, end_offset.saturating_sub(1)))
}

pub fn parse_python(content: &str, file_id: &str) -> ParseResult {
    let mut nodes: Vec<ParsedNode> = Vec::new();
    let mut edges: Vec<ParsedEdge> = Vec::new();
    let offsets = line_start_offsets(content);

    for caps in FROM_IMPORT_REGEX.captures_iter(content).flatten() {
        let Some(symbol) = caps.get(2) else { continue };
        let symbol = symbol.as_str();
        edges.push(ParsedEdge {
            id: format!("{file_id}:import:{symbol}"),
            from_node_id: format!("{file_id}:file"),
            to_node_id: format!("module:{symbol}"),
            kind: "imports",
            source: None,
        });
    }

    for caps in CLASS_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_python_node_body(content, &offsets, full.start());
        nodes.push(ParsedNode {
            id: format!("{file_id}:class:{name}:{start_line}"),
            kind: "class",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in DEF_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_python_node_body(content, &offsets, full.start());
        nodes.push(ParsedNode {
            id: format!("{file_id}:function:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code),
        });
    }

    ParseResult { nodes, edges, backend: "regex", syntax_error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_def_and_class_bodies() {
        let content = "def greet(name):\n    return 'hi ' + name\n\nclass Greeter:\n    def run(self):\n        return greet('x')\n";
        let result = parse_python(content, "F");
        let greet = result.nodes.iter().find(|n| n.name == "greet").unwrap();
        assert_eq!(greet.id, "F:function:greet:1");
        assert_eq!(greet.start_line, 1);
        assert_eq!(greet.end_line, 2);
        let class = result.nodes.iter().find(|n| n.name == "Greeter").unwrap();
        assert_eq!(class.kind, "class");
        assert_eq!(class.start_line, 4);
        assert!(class.code.as_deref().unwrap().contains("def run"));
    }

    #[test]
    fn python_emits_no_import_edges() {
        // Both TypeScript patterns are effectively dead: FROM_IMPORT requires a
        // quoted module (`from "x" import y`, not valid Python) and IMPORT
        // reads an undefined capture group. Parity means zero edges here.
        let content = "from os import path
import json
";
        let result = parse_python(content, "F");
        assert!(result.edges.is_empty(), "{:?}", result.edges);
    }
}
