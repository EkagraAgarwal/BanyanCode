//! `langs/c.ts` (`parseC`, shared by C and C++) ported to Rust.
//!
//! Used as the regex fallback for `.c/.h/.cpp/...` when the grammar is
//! unavailable, and always for the edge pass: the AST walker replaces the
//! nodes but the `calls`/`references` edges below survive, so their ids and
//! endpoints must match the TypeScript output.

use super::types::{ParseResult, ParsedEdge, ParsedNode};
use crate::text::{decl_index_at, end_line_for, line_at_offset, line_start_offsets, slice, strip_comments_and_strings};
use fancy_regex::Regex;
use once_cell::sync::Lazy;
use std::collections::HashSet;

static INCLUDE_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:^|\n)[\s\u{feff}]*#[\s\u{feff}]*include[\s\u{feff}]*[<"]([^>"]+)[>"]"#).unwrap());
static CLASS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:template[\s\u{feff}]*<[^>]*>[\s\u{feff}]*)?class[\s\u{feff}]+([A-Za-z_][A-Za-z0-9_]*)(?:[\s\u{feff}]*:[\s\u{feff}]*[^{]*)?[\s\u{feff}]*\{").unwrap()
});
static STRUCT_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:typedef[\s\u{feff}]+)?(struct|enum|union)(?:[\s\u{feff}]+class)?[\s\u{feff}]+([A-Za-z_][A-Za-z0-9_]*)[\s\u{feff}]*\{").unwrap()
});
static TYPEDEF_ANON_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\n)[\s\u{feff}]*typedef[\s\u{feff}]+(?:struct|enum|union)[\s\u{feff}]*\{").unwrap());
static DEFINE_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\n)[\s\u{feff}]*#[\s\u{feff}]*define[\s\u{feff}]+([A-Za-z_][A-Za-z0-9_]*)").unwrap());

const C_QUALIFIERS: &str = r"(?:static|inline|extern|virtual|constexpr|consteval|constinit|const|volatile|unsigned|signed|register|thread_local|restrict|mutable|friend|explicit|noreturn|_Noreturn)[\s\u{feff}]+";
const C_TYPE_PATTERN: &str = r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?(?:[\s\u{feff}]*<[^>]*>)?(?:[\s\u{feff}]*[*&]+[\s\u{feff}]*|[\s\u{feff}]+)";
const C_FN_SUFFIX: &str = r"(?:const|noexcept[\s\u{feff}]*\([^)]*\)|noexcept|override|final|volatile|throw[\s\u{feff}]*\([^)]*\)|__attribute__[\s\u{feff}]*\([^)]*\)|[\s\u{feff}])*";

static FUNCTION_DEF_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?:^|\n)[\s\u{{feff}}]*(?:template[\s\u{{feff}}]*<[^>]*>[\s\u{{feff}}]*)?(?:{C_QUALIFIERS})*(?:{C_TYPE_PATTERN})+((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)[\s\u{{feff}}]*\(([^;{{}}]*)\)[\s\u{{feff}}]*{C_FN_SUFFIX}([{{;])"
    ))
    .unwrap()
});
static METHOD_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?:^|\n)[\s\u{{feff}}]+(?:{C_QUALIFIERS})*(?:{C_TYPE_PATTERN})*([A-Za-z_][A-Za-z0-9_]*)[\s\u{{feff}}]*\(([^;{{}}]*)\)[\s\u{{feff}}]*{C_FN_SUFFIX}\{{"
    ))
    .unwrap()
});
static GLOBAL_VAR_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?:^|\n)[\s\u{{feff}}]*(?:{C_QUALIFIERS})*(?:{C_TYPE_PATTERN})+([A-Za-z_][A-Za-z0-9_]*)[\s\u{{feff}}]*(?:=|\[|;)"
    ))
    .unwrap()
});

static C_KEYWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "if", "for", "while", "switch", "case", "default", "return", "goto", "do", "else", "sizeof", "typeof", "alignof",
        "typeid", "decltype", "catch", "try", "throw", "delete", "new", "using", "namespace", "typedef", "struct",
        "enum", "union", "class", "template", "typename", "static_cast", "dynamic_cast", "const_cast",
        "reinterpret_cast", "static_assert", "alignas", "noexcept", "friend", "explicit", "virtual", "inline", "extern",
        "volatile", "register", "signed", "unsigned", "mutable", "thread_local", "restrict", "const", "constexpr",
        "consteval", "constinit", "operator", "public", "private", "protected", "true", "false", "nullptr", "NULL",
        "std",
    ]
    .into_iter()
    .collect()
});

const BRACE_SCAN_BOUND: usize = 65536;

fn scan_brace_body(
    content: &str,
    stripped: &str,
    offsets: &[usize],
    match_index: usize,
    brace_index: usize,
) -> (String, u32) {
    let stripped_bytes = stripped.as_bytes();
    let brace_limit = (brace_index + BRACE_SCAN_BOUND).min(stripped_bytes.len());
    let mut brace_count = 1i32;
    let mut index = brace_index + 1;
    while index < brace_limit {
        match stripped_bytes[index] {
            b'{' => brace_count += 1,
            b'}' => {
                brace_count -= 1;
                if brace_count == 0 {
                    return (slice(content, match_index, index + 1), end_line_for(offsets, index + 1));
                }
            }
            _ => {}
        }
        index += 1;
    }
    (slice(content, match_index, brace_limit), end_line_for(offsets, brace_limit))
}

static TRAILING_ALIAS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[\s\u{feff}]*([A-Za-z_][A-Za-z0-9_]*)[\s\u{feff}]*;").unwrap());

fn trailing_type_alias(content: &str, close_index: usize) -> Option<(String, usize)> {
    let start = close_index + 1;
    if start > content.len() {
        return None;
    }
    let window = slice(content, start, start + 256);
    let caps = TRAILING_ALIAS.captures(&window).ok().flatten()?;
    let full = caps.get(0)?;
    let name = caps.get(1)?.as_str().to_string();
    Some((name, start + full.end()))
}

fn extract_class_methods(
    class_code: &str,
    stripped_class_code: &str,
    class_start_line: u32,
    file_id: &str,
    class_name: &str,
) -> Vec<ParsedNode> {
    let local_offsets = line_start_offsets(class_code);
    let mut methods = Vec::new();
    for caps in METHOD_REGEX.captures_iter(class_code).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        if name.is_empty() || name == class_name || C_KEYWORDS.contains(name) {
            continue;
        }
        if full.as_str().trim_start().starts_with("operator") {
            continue;
        }
        let local_start = line_at_offset(&local_offsets, decl_index_at(class_code, full.start()));
        let start_line = class_start_line + local_start - 1;
        let brace_index = full.start() + full.as_str().len() - 1;
        let (code, local_end) =
            scan_brace_body(class_code, stripped_class_code, &local_offsets, full.start(), brace_index);
        let end_line = class_start_line + local_end - 1;
        methods.push(ParsedNode {
            id: format!("{file_id}:method:{class_name}:{name}:{start_line}"),
            kind: "method",
            name: name.to_string(),
            signature: Some(full.as_str().trim().to_string()),
            start_line,
            end_line,
            code: Some(code),
        });
    }
    methods
}

pub fn parse_c(content: &str, file_id: &str) -> ParseResult {
    let mut nodes: Vec<ParsedNode> = Vec::new();
    let mut edges: Vec<ParsedEdge> = Vec::new();
    let offsets = line_start_offsets(content);
    let stripped = strip_comments_and_strings(content);

    for caps in INCLUDE_REGEX.captures_iter(content).flatten() {
        let Some(symbol) = caps.get(1) else { continue };
        let symbol = symbol.as_str();
        edges.push(ParsedEdge {
            id: format!("{file_id}:include:{symbol}"),
            from_node_id: format!("{file_id}:file"),
            to_node_id: format!("module:{symbol}"),
            kind: "imports",
            source: None,
        });
    }

    let mut body_ranges: Vec<(u32, u32)> = Vec::new();

    for caps in CLASS_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        let brace_index = full.start() + full.as_str().len() - 1;
        let (code, end_line) = scan_brace_body(content, &stripped, &offsets, decl_index, brace_index);
        nodes.push(ParsedNode {
            id: format!("{file_id}:class:{name}:{start_line}"),
            kind: "class",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code.clone()),
        });
        let stripped_class = slice(&stripped, decl_index, decl_index + code.len());
        nodes.extend(extract_class_methods(&code, &stripped_class, start_line, file_id, name));
        body_ranges.push((start_line, end_line));
    }

    let mut function_nodes: Vec<ParsedNode> = Vec::new();
    let mut seen_function_ids: HashSet<String> = HashSet::new();
    for caps in FUNCTION_DEF_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(qualified) = caps.get(1) else { continue };
        let name = qualified.as_str().split("::").last().unwrap_or("").to_string();
        if name.is_empty() || C_KEYWORDS.contains(name.as_str()) {
            continue;
        }
        let Some(brace) = caps.get(3) else { continue };
        if brace.as_str() != "{" {
            continue;
        }
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        if body_ranges.iter().any(|(start, end)| start_line >= *start && start_line <= *end) {
            continue;
        }
        let brace_index = full.start() + full.as_str().len() - 1;
        let (code, end_line) = scan_brace_body(content, &stripped, &offsets, decl_index, brace_index);
        let id = format!("{file_id}:function:{name}:{start_line}");
        if !seen_function_ids.insert(id.clone()) {
            continue;
        }
        let node = ParsedNode {
            id,
            kind: "function",
            name,
            signature: Some(full.as_str().trim().to_string()),
            start_line,
            end_line,
            code: Some(code),
        };
        function_nodes.push(node.clone());
        nodes.push(node);
        body_ranges.push((start_line, end_line));
    }

    for caps in STRUCT_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(2) else { continue };
        let name = name.as_str();
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        let brace_index = full.start() + full.as_str().len() - 1;
        let (code, end_line) = scan_brace_body(content, &stripped, &offsets, decl_index, brace_index);
        nodes.push(ParsedNode {
            id: format!("{file_id}:type:{name}:{start_line}"),
            kind: "type",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code.clone()),
        });
        body_ranges.push((start_line, end_line));
        if full.as_str().trim_start().starts_with("typedef") {
            if let Some((alias, alias_end)) = trailing_type_alias(content, decl_index + code.len() - 1) {
                nodes.push(ParsedNode {
                    id: format!("{file_id}:type:{alias}:{start_line}"),
                    kind: "type",
                    name: alias,
                    signature: None,
                    start_line,
                    end_line: line_at_offset(&offsets, alias_end.saturating_sub(1)),
                    code: Some(code),
                });
            }
        }
    }

    for caps in TYPEDEF_ANON_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        let brace_index = full.start() + full.as_str().len() - 1;
        let (code, end_line) = scan_brace_body(content, &stripped, &offsets, decl_index, brace_index);
        let Some((alias, alias_end)) = trailing_type_alias(content, decl_index + code.len() - 1) else {
            continue;
        };
        nodes.push(ParsedNode {
            id: format!("{file_id}:type:{alias}:{start_line}"),
            kind: "type",
            name: alias,
            signature: None,
            start_line,
            end_line: line_at_offset(&offsets, alias_end.saturating_sub(1)),
            code: Some(code),
        });
        body_ranges.push((start_line, end_line));
    }

    for caps in DEFINE_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        let fn_like = content.as_bytes().get(full.start() + full.as_str().len()) == Some(&b'(');
        let line_end = content[decl_index.min(content.len())..].find('\n').map(|r| decl_index + r);
        let code = slice(content, decl_index, line_end.unwrap_or(content.len()));
        nodes.push(ParsedNode {
            id: format!("{file_id}:{}:{name}:{start_line}", if fn_like { "function" } else { "variable" }),
            kind: if fn_like { "function" } else { "variable" },
            name: name.to_string(),
            signature: None,
            start_line,
            end_line: start_line,
            code: Some(code),
        });
    }

    static NAMESPACE_LIKE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\b(?:using|namespace|typedef|struct|enum|union|class|template|return)\b").unwrap());
    for caps in GLOBAL_VAR_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        if name.is_empty() || C_KEYWORDS.contains(name) {
            continue;
        }
        if NAMESPACE_LIKE.is_match(full.as_str()).unwrap_or(false) {
            continue;
        }
        let decl_index = decl_index_at(content, full.start());
        let start_line = line_at_offset(&offsets, decl_index);
        if body_ranges.iter().any(|(start, end)| start_line >= *start && start_line <= *end) {
            continue;
        }
        let line_end = content[decl_index.min(content.len())..].find('\n').map(|r| decl_index + r);
        let code = slice(content, decl_index, line_end.unwrap_or(content.len()));
        nodes.push(ParsedNode {
            id: format!("{file_id}:variable:{name}:{start_line}"),
            kind: "variable",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line: start_line,
            code: Some(code),
        });
    }

    // Best-effort same-file call edges from identifier + `(` scans.
    let mut function_by_name: std::collections::HashMap<&str, &ParsedNode> = std::collections::HashMap::new();
    for node in &function_nodes {
        function_by_name.insert(node.name.as_str(), node);
    }
    let mut edge_ids: HashSet<String> = HashSet::new();
    let add_edge = |edges: &mut Vec<ParsedEdge>, edge_ids: &mut HashSet<String>, id: String, from: String, to: String, kind: &'static str| {
        if edge_ids.contains(&id) {
            return;
        }
        edge_ids.insert(id.clone());
        edges.push(ParsedEdge { id, from_node_id: from, to_node_id: to, kind, source: None });
    };
    static CALL_SITE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)[\s\u{feff}]*\(").unwrap());
    for node in &function_nodes {
        let Some(code) = node.code.as_deref() else { continue };
        if code.is_empty() {
            continue;
        }
        let stripped_code = strip_comments_and_strings(code);
        for caps in CALL_SITE.captures_iter(&stripped_code).flatten() {
            let Some(callee) = caps.get(1) else { continue };
            let callee = callee.as_str();
            if callee == node.name || C_KEYWORDS.contains(callee) {
                continue;
            }
            if let Some(target) = function_by_name.get(callee) {
                if target.id != node.id {
                    add_edge(
                        &mut edges,
                        &mut edge_ids,
                        format!("{}->{}:calls", node.id, target.id),
                        node.id.clone(),
                        target.id.clone(),
                        "calls",
                    );
                }
            }
        }
    }

    let file_node_id = format!("{file_id}:file");
    for node in &nodes {
        add_edge(
            &mut edges,
            &mut edge_ids,
            format!("{}->{}:references", node.id, file_node_id),
            node.id.clone(),
            file_node_id.clone(),
            "references",
        );
    }

    ParseResult { nodes, edges, backend: "regex", syntax_error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_c_function_struct_and_define() {
        let content = "#include <stdio.h>\n#define MAX 10\n\nstruct Point {\n  int x;\n};\n\nint add(int a, int b) {\n  return a + b;\n}\n";
        let result = parse_c(content, "F");
        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"add"), "{names:?}");
        assert!(names.contains(&"Point"), "{names:?}");
        assert!(names.contains(&"MAX"), "{names:?}");
        assert!(result.edges.iter().any(|e| e.to_node_id == "module:stdio.h"));
    }
}
