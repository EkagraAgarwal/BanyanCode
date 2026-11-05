//! `langs/regex-fallback.ts` (`parseGeneric`) ported to Rust.
//!
//! This is the regex fallback for the 13 AST-walk languages and the only
//! parser for extensions with no grammar at all. Its nodes are replaced by the
//! AST-walked nodes when the grammar is available, but its edges survive, and
//! those edges' endpoints use the identical `${fileID}:${kind}:${name}:${line}`
//! scheme, so the id format has to match exactly.

use super::types::{ParseResult, ParsedNode};
use crate::text::{decl_index_at, line_at_offset, line_start_offsets, slice};
use fancy_regex::Regex;
use once_cell::sync::Lazy;

static FUNCTION_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)(?:export[\s\u{feff}]+|pub[\s\u{feff}]+)?(?:function|fn|func)[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*\(")
        .unwrap()
});
static CLASS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)(?:export[\s\u{feff}]+|pub[\s\u{feff}]+)?class[\s\u{feff}]+([A-Za-z0-9_]+)").unwrap()
});

const GENERIC_BODY_BOUND: usize = 4000;

fn generic_node_body(content: &str, offsets: &[usize], decl_index: usize) -> (String, u32) {
    let slice_end = (decl_index + GENERIC_BODY_BOUND).min(content.len());
    let open_brace = content[decl_index.min(content.len())..].find('{').map(|r| decl_index + r);
    if let Some(open_brace) = open_brace {
        if open_brace < slice_end {
            let mut brace_count = 1i32;
            let mut index = open_brace + 1;
            while index < slice_end {
                match content.as_bytes()[index] {
                    b'{' => brace_count += 1,
                    b'}' => {
                        brace_count -= 1;
                        if brace_count == 0 {
                            let end_offset = index + 1;
                            return (slice(content, decl_index, end_offset), line_at_offset(offsets, end_offset - 1));
                        }
                    }
                    _ => {}
                }
                index += 1;
            }
        }
    }
    let line_end = content[decl_index.min(content.len())..].find('\n').map(|r| decl_index + r);
    let end_offset = if open_brace.is_none() && line_end.is_some() {
        slice_end.min(line_end.unwrap())
    } else {
        slice_end
    };
    (slice(content, decl_index, end_offset), line_at_offset(offsets, end_offset.saturating_sub(1)))
}

pub fn parse_generic(content: &str, file_id: &str) -> ParseResult {
    let mut nodes: Vec<ParsedNode> = Vec::new();
    let offsets = line_start_offsets(content);

    let mut add = |kind: &'static str, name: &str, match_index: usize| {
        let decl_index = decl_index_at(content, match_index);
        let start_line = line_at_offset(&offsets, decl_index);
        let (code, end_line) = generic_node_body(content, &offsets, decl_index);
        nodes.push(ParsedNode {
            id: format!("{file_id}:{kind}:{name}:{start_line}"),
            kind,
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code),
        });
    };

    for caps in FUNCTION_REGEX.captures_iter(content).flatten() {
        let (Some(full), Some(name)) = (caps.get(0), caps.get(1)) else { continue };
        add("function", name.as_str(), full.start());
    }

    for caps in CLASS_REGEX.captures_iter(content).flatten() {
        let (Some(full), Some(name)) = (caps.get(0), caps.get(1)) else { continue };
        add("class", name.as_str(), full.start());
    }

    ParseResult { nodes, edges: Vec::new(), backend: "regex", syntax_error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_go_style_functions_and_classes() {
        let content = "package main\n\nfunc Add(a int) int {\n\treturn a\n}\n\ntype Thing struct{}\n";
        let result = parse_generic(content, "F");
        let add = result.nodes.iter().find(|n| n.name == "Add").unwrap();
        assert_eq!(add.id, "F:function:Add:3");
        assert_eq!(add.end_line, 5);
    }
}
