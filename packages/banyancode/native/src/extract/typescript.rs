//! `langs/typescript.ts` ported to Rust.
//!
//! Node extraction for TS/JS is regex-driven in the TypeScript implementation
//! (tree-sitter only contributes `calls`/`yield`/`service_access` edges and
//! syntax-error detection), so this module ports the regexes rather than
//! re-deriving nodes from the AST. That keeps ids, kinds, names and line
//! numbers identical: `parseTypeScript` is the single source of truth for what
//! a TS symbol node is, and both backends must agree.
//!
//! Divergences (documented in specs/banyancode/native-indexer.md):
//! - offsets are UTF-8 bytes, not UTF-16 units;
//! - `\b` uses Unicode word boundaries instead of ASCII;
//! - `\s` additionally matches U+FEFF (JS treats a BOM as whitespace too).

use super::types::{ParseResult, ParsedEdge, ParsedNode};
use crate::text::{decl_start_line, end_line_for, line_start_offsets, slice, slice_units};
use fancy_regex::Regex;
use once_cell::sync::Lazy;

static IMPORTS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"import[\s\u{feff}]+(?:(?:\{[^}]*\}|\*[\s\u{feff}]+as[\s\u{feff}]+[A-Za-z0-9_]+|[A-Za-z0-9_]+)[\s\u{feff}]+from[\s\u{feff}]+)?["']([^"']+)["']"#)
        .unwrap()
});
static EXPORT_CLASS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"export[\s\u{feff}]+class[\s\u{feff}]+([A-Za-z0-9_]+)(?:[\s\u{feff}]+extends[\s\u{feff}]+([A-Za-z0-9_]+))?").unwrap()
});
static CLASS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)(?!export[\s\u{feff}]+)class[\s\u{feff}]+([A-Za-z0-9_]+)(?:[\s\u{feff}]+extends[\s\u{feff}]+([A-Za-z0-9_]+))?").unwrap()
});
static FUNCTION_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?(?:async[\s\u{feff}]+)?function[\s\u{feff}]+([A-Za-z0-9_]+)").unwrap()
});
static ARROW_CONST_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?const[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*=[\s\u{feff}]*(async[\s\u{feff}]+)?(?:\([^)]*\)(?:[\s\u{feff}]*:[^=;]{1,500}?)?|[^=>\n]+)[\s\u{feff}]*=>").unwrap()
});
static GENERIC_ARROW_CONST_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?const[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*=[\s\u{feff}]*(async[\s\u{feff}]+)?<[^<>\n]{0,300}(?:<[^<>\n]{0,300}>[^<>\n]{0,300})?>[\s\u{feff}]*\([^)]*\)(?:[\s\u{feff}]*:[^=;\n]{1,500}?)?[\s\u{feff}]*=>").unwrap()
});
static FACTORY_EXPORT_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?const[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*(?::[^=\n]{1,300})?[\s\u{feff}]*=[\s\u{feff}]*((?:Tool\.define|Layer\.effect|Layer\.succeed|Layer\.scoped|Context\.Service|Context\.Tag|Layer\.mergeAll|Effect\.fnUntraced)(?:<[^>]+>)?)[\s\u{feff}]*\(").unwrap()
});
static INTERFACE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?interface[\s\u{feff}]+([A-Za-z0-9_]+)").unwrap()
});
static TYPE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:export[\s\u{feff}]+)?type[\s\u{feff}]+([A-Za-z0-9_]+)(?:<[^=]*?>)?[\s\u{feff}]*=").unwrap()
});
static EFFECT_FN_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"Effect\.fn[\s\u{feff}]*\([\s\u{feff}]*["']([^"']+)["'][\s\u{feff}]*\)"#).unwrap());
static NAMESPACE_EXPORT_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?:^|\n)[\s\u{feff}]*export[\s\u{feff}]+\*[\s\u{feff}]+as[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]+from[\s\u{feff}]+["'][^"']+["']"#).unwrap()
});
static EFFECT_FN_CONST_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"const[\s\u{feff}]+([A-Za-z0-9_]+)[\s\u{feff}]*=[\s\u{feff}]*Effect\.fn[\s\u{feff}]*\([\s\u{feff}]*["']([^"']+)["'][\s\u{feff}]*\)"#).unwrap()
});
static INTERFACE_MEMBER_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]*(?:readonly[\s\u{feff}]+)?([A-Za-z0-9_]+)[\s\u{feff}]*[:\s][\s\u{feff}]*\(([^)]*)\)[\s\u{feff}]*[:=][\s\u{feff}]*([^\n;]+)").unwrap()
});
static CLASS_METHOD_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|\n)[\s\u{feff}]+(?:async[\s\u{feff}]+)?([A-Za-z0-9_]+)[\s\u{feff}]*\([^)]*\)[\s\u{feff}]*(?::[\s\u{feff}]*[^{;]+)?[\s\u{feff}]*\{").unwrap()
});

const OPEN_SCAN_BOUND: usize = 8192;
const BRACE_SCAN_BOUND: usize = 65536;

fn is_ws(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// Byte index of the first non-ASCII-whitespace byte at or after `start`.
fn skip_ws_bytes(content: &str, start: usize) -> usize {
    let bytes = content.as_bytes();
    let mut index = start;
    while index < bytes.len() && is_ws(bytes[index]) {
        index += 1;
    }
    index
}

/// `skipFunctionSignature`: skip the balanced parameter list, then any
/// return-type annotation, and return where the body scan should start.
fn skip_function_signature(content: &str, after_open_paren: usize) -> usize {
    let bytes = content.as_bytes();
    let paren_limit = (after_open_paren + OPEN_SCAN_BOUND).min(bytes.len());
    let mut index = after_open_paren;
    let mut depth = 1i32;
    while index < paren_limit && depth > 0 {
        match bytes[index] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        index += 1;
    }
    if depth > 0 {
        return after_open_paren;
    }
    let mut cursor = skip_ws_bytes(content, index);
    if bytes.get(cursor) != Some(&b':') {
        return index;
    }
    let mut nest = 0i32;
    let limit = (cursor + 1 + OPEN_SCAN_BOUND).min(bytes.len());
    cursor += 1;
    while cursor < limit {
        let ch = bytes[cursor];
        if ch == b'\n' && nest <= 0 {
            let next = skip_ws_bytes(content, cursor + 1).min(content.len());
            let tail = slice_units(&content[next..], 12);
            if ["export", "function", "const", "let", "var", "class", "interface", "type", "declare", "async", "@", "//", "/*"]
                .iter()
                .any(|prefix| tail.starts_with(prefix))
            {
                return cursor;
            }
        }
        if ch == b'<' || ch == b'(' || ch == b'[' {
            nest += 1;
        } else if ch == b'>' && bytes.get(cursor.wrapping_sub(1)) != Some(&b'=') {
            nest -= 1;
        } else if ch == b')' || ch == b']' {
            nest -= 1;
        } else if ch == b'{' {
            if nest > 0 {
                nest += 1;
                cursor += 1;
                continue;
            }
            let mut probe = cursor;
            while probe > 0 && is_ws(bytes[probe - 1]) {
                probe -= 1;
            }
            let previous = if probe > 0 { bytes[probe - 1] } else { 0 };
            if !matches!(previous, b'|' | b'&' | b':' | b',' | b'<') {
                return cursor;
            }
            nest += 1;
        } else if ch == b'}' {
            nest -= 1;
        } else if ch == b';' && nest <= 0 {
            return cursor;
        }
        cursor += 1;
    }
    index
}

/// `getTSNodeBody`: capture from `match_index` to the matching close brace (or
/// the statement terminator), bounded.
fn get_ts_node_body(
    content: &str,
    offsets: &[usize],
    match_index: usize,
    match_text: &str,
    body_scan_start: Option<usize>,
) -> (String, u32) {
    let bytes = content.as_bytes();
    let after_match = body_scan_start.unwrap_or(match_index + match_text.len());
    let open_limit = (after_match + OPEN_SCAN_BOUND).min(bytes.len());
    let mut first_brace: isize = -1;
    let mut first_semicolon: isize = -1;
    let mut index = after_match;
    while index < open_limit {
        let ch = bytes[index];
        if ch == b'{' {
            first_brace = index as isize;
            break;
        }
        if ch == b';' {
            first_semicolon = index as isize;
            break;
        }
        if (ch == b'f' && content[index..].starts_with("function "))
            || (ch == b'c' && content[index..].starts_with("class "))
        {
            break;
        }
        index += 1;
    }
    if first_brace != -1 {
        let first_brace = first_brace as usize;
        let brace_limit = (first_brace + BRACE_SCAN_BOUND).min(bytes.len());
        let mut brace_count = 1i32;
        let mut index = first_brace + 1;
        while index < brace_limit {
            match bytes[index] {
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
        return (slice(content, match_index, brace_limit), end_line_for(offsets, brace_limit));
    }
    let end_offset = if first_semicolon != -1 {
        first_semicolon as usize + 1
    } else {
        after_match
    };
    (slice(content, match_index, end_offset), end_line_for(offsets, end_offset))
}

/// `scanExpressionEnd`: the first `;`, `,` or depth-0 newline, unless the next
/// line continues the expression.
fn scan_expression_end(content: &str, start: usize) -> usize {
    let bytes = content.as_bytes();
    let limit = (start + BRACE_SCAN_BOUND).min(bytes.len());
    let mut depth = 0i32;
    let mut index = start;
    while index < limit {
        let ch = bytes[index];
        if ch == b'(' || ch == b'[' || ch == b'{' {
            depth += 1;
        } else if ch == b')' || ch == b']' || ch == b'}' {
            if depth == 0 {
                return index;
            }
            depth -= 1;
        } else if (ch == b';' || ch == b',') && depth == 0 {
            return index;
        } else if ch == b'\n' && depth == 0 {
            let mut probe = index + 1;
            while probe < limit && matches!(bytes[probe], b' ' | b'\t' | b'\r') {
                probe += 1;
            }
            let next = bytes.get(probe).copied().unwrap_or(0);
            if !matches!(next, b'|' | b'&' | b'.' | b'?' | b':') {
                return index;
            }
        }
        index += 1;
    }
    limit
}

/// `getArrowBody`.
fn get_arrow_body(content: &str, offsets: &[usize], match_index: usize, match_text: &str) -> (String, u32) {
    let search_from = match_index + match_text.len().saturating_sub(2);
    let arrow_index = match content[search_from.min(content.len())..].find("=>") {
        Some(relative) => search_from + relative,
        None => return get_ts_node_body(content, offsets, match_index, match_text, None),
    };
    let after_arrow = arrow_index + 2;
    let slice_end = (after_arrow + OPEN_SCAN_BOUND).min(content.len());
    let slice_text = slice(content, after_arrow, slice_end);
    let trimmed_len = slice_text.len() - slice_text.trim_start().len();
    let rest_start = after_arrow + trimmed_len;
    if content[rest_start..].starts_with('{') {
        let prefix = slice(content, match_index, rest_start);
        return get_ts_node_body(content, offsets, match_index, &prefix, None);
    }
    let end_offset = scan_expression_end(content, rest_start);
    (slice(content, match_index, end_offset), end_line_for(offsets, end_offset))
}

/// `getFactoryBody`.
fn get_factory_body(content: &str, offsets: &[usize], match_index: usize, match_text: &str) -> (String, u32) {
    let bytes = content.as_bytes();
    let after_match = match_index + match_text.len();
    let open_paren = match content[after_match.min(content.len())..].find('(') {
        Some(relative) => after_match + relative,
        None => return get_ts_node_body(content, offsets, match_index, match_text, None),
    };
    let paren_limit = (open_paren + BRACE_SCAN_BOUND).min(bytes.len());
    let mut paren_count = 1i32;
    let mut index = open_paren + 1;
    while index < paren_limit && paren_count > 0 {
        match bytes[index] {
            b'(' => paren_count += 1,
            b')' => paren_count -= 1,
            _ => {}
        }
        index += 1;
    }
    let close_paren = index - 1;
    (slice(content, match_index, close_paren + 1), end_line_for(offsets, close_paren + 1))
}

/// `extractClassMethods`.
fn extract_class_methods(class_code: &str, class_start_line: u32, file_id: &str, class_name: &str) -> Vec<ParsedNode> {
    let local_offsets = line_start_offsets(class_code);
    let mut methods = Vec::new();
    for caps in CLASS_METHOD_REGEX.captures_iter(class_code).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name_match) = caps.get(1) else { continue };
        let name = name_match.as_str();
        if name == "constructor" {
            continue;
        }
        let local_start = decl_start_line(class_code, &local_offsets, full.start());
        let start_line = class_start_line + local_start - 1;
        let (code, local_end) = get_ts_node_body(class_code, &local_offsets, full.start(), full.as_str(), None);
        let end_line = class_start_line + local_end - 1;
        let signature = match EFFECT_FN_REGEX.captures(&code).ok().flatten() {
            Some(effect) => effect.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            None => full.as_str().trim().to_string(),
        };
        methods.push(ParsedNode {
            id: format!("{file_id}:method:{class_name}:{name}:{start_line}"),
            kind: "method",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }
    methods
}

/// `extractInterfaceMembers`.
fn extract_interface_members(
    interface_code: &str,
    interface_start_line: u32,
    file_id: &str,
    interface_name: &str,
) -> Vec<ParsedNode> {
    let local_offsets = line_start_offsets(interface_code);
    let mut members = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for caps in INTERFACE_MEMBER_REGEX.captures_iter(interface_code).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name_match) = caps.get(1) else { continue };
        let name = name_match.as_str();
        if name.is_empty() || name == interface_name {
            continue;
        }
        let params = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let return_type = caps
            .get(3)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let return_type = return_type.strip_suffix('{').map(|t| t.trim_end().to_string()).unwrap_or(return_type);
        let local_start = decl_start_line(interface_code, &local_offsets, full.start());
        let start_line = interface_start_line + local_start - 1;
        let signature = format!("{name}({}): {return_type}", params.trim())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let id = format!("{file_id}:method:{interface_name}:{name}:{start_line}");
        if !seen.insert(id.clone()) {
            continue;
        }
        members.push(ParsedNode {
            id,
            kind: "method",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line: start_line,
            code: None,
        });
    }
    members
}

/// `skipTypeParameters`: skip whitespace and an optional balanced `<...>`.
fn skip_type_parameters(content: &str, start: usize) -> usize {
    let bytes = content.as_bytes();
    let mut index = skip_ws_bytes(content, start);
    if bytes.get(index) != Some(&b'<') {
        return index;
    }
    let limit = (index + 4000).min(bytes.len());
    let mut depth = 0i32;
    while index < limit {
        match bytes[index] {
            b'<' => depth += 1,
            b'>' => {
                depth -= 1;
                if depth == 0 {
                    index += 1;
                    break;
                }
            }
            _ => {}
        }
        index += 1;
    }
    skip_ws_bytes(content, index)
}

pub fn parse_typescript(content: &str, file_id: &str) -> ParseResult {
    let mut nodes: Vec<ParsedNode> = Vec::new();
    let mut edges: Vec<ParsedEdge> = Vec::new();
    let offsets = line_start_offsets(content);

    for caps in IMPORTS_REGEX.captures_iter(content).flatten() {
        let Some(symbol) = caps.get(1) else { continue };
        let symbol = symbol.as_str();
        edges.push(ParsedEdge {
            id: format!("{file_id}:import:{symbol}"),
            from_node_id: format!("{file_id}:file"),
            to_node_id: format!("module:{symbol}"),
            kind: "imports",
            source: None,
        });
    }

    for caps in EXPORT_CLASS_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_ts_node_body(content, &offsets, full.start(), full.as_str(), None);
        nodes.push(ParsedNode {
            id: format!("{file_id}:class:{name}:{start_line}"),
            kind: "class",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code.clone()),
        });
        nodes.extend(extract_class_methods(&code, start_line, file_id, name));
    }

    for caps in CLASS_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_ts_node_body(content, &offsets, full.start(), full.as_str(), None);
        nodes.push(ParsedNode {
            id: format!("{file_id}:class:{name}:{start_line}"),
            kind: "class",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code.clone()),
        });
        nodes.extend(extract_class_methods(&code, start_line, file_id, name));
    }

    for caps in FUNCTION_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let after_name = skip_type_parameters(content, full.end());
        if content.as_bytes().get(after_name) != Some(&b'(') {
            continue;
        }
        let declaration = slice(content, full.start(), after_name + 1);
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_ts_node_body(
            content,
            &offsets,
            full.start(),
            &declaration,
            Some(skip_function_signature(content, after_name + 1)),
        );
        let signature = match EFFECT_FN_REGEX.captures(&code).ok().flatten() {
            Some(effect) => effect.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            None => declaration.trim().to_string(),
        };
        nodes.push(ParsedNode {
            id: format!("{file_id}:function:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in FACTORY_EXPORT_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let factory_call = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let signature = factory_call.trim_end_matches('(').trim_end().to_string();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_factory_body(content, &offsets, full.start(), full.as_str());
        nodes.push(ParsedNode {
            id: format!("{file_id}:factory:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in ARROW_CONST_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_arrow_body(content, &offsets, full.start(), full.as_str());
        let signature = match EFFECT_FN_REGEX.captures(&code).ok().flatten() {
            Some(effect) => effect.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            None => full.as_str().trim().to_string(),
        };
        nodes.push(ParsedNode {
            id: format!("{file_id}:function:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in GENERIC_ARROW_CONST_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_arrow_body(content, &offsets, full.start(), full.as_str());
        let signature = match EFFECT_FN_REGEX.captures(&code).ok().flatten() {
            Some(effect) => effect.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            None => full.as_str().trim().to_string(),
        };
        nodes.push(ParsedNode {
            id: format!("{file_id}:function:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in EFFECT_FN_CONST_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let signature = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
        let start_line = decl_start_line(content, &offsets, full.start());
        let after_match = full.end();
        let open_limit = (after_match + OPEN_SCAN_BOUND).min(content.len());
        let mut first_brace: isize = -1;
        let mut index = after_match;
        while index < open_limit {
            if content.as_bytes()[index] == b'{' {
                first_brace = index as isize;
                break;
            }
            index += 1;
        }
        let mut code = full.as_str().to_string();
        let mut end_line = end_line_for(&offsets, full.end());
        if first_brace != -1 {
            let first_brace = first_brace as usize;
            let brace_limit = (first_brace + BRACE_SCAN_BOUND).min(content.len());
            let mut brace_count = 1i32;
            let mut index = first_brace + 1;
            while index < brace_limit {
                match content.as_bytes()[index] {
                    b'{' => brace_count += 1,
                    b'}' => {
                        brace_count -= 1;
                        if brace_count == 0 {
                            code = slice(content, full.start(), index + 1);
                            end_line = end_line_for(&offsets, index + 1);
                            break;
                        }
                    }
                    _ => {}
                }
                index += 1;
            }
            if code == full.as_str() {
                code = slice(content, full.start(), brace_limit);
                end_line = end_line_for(&offsets, brace_limit);
            }
        }
        nodes.push(ParsedNode {
            id: format!("{file_id}:function:{name}:{start_line}"),
            kind: "function",
            name: name.to_string(),
            signature: Some(signature),
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in INTERFACE_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let (code, end_line) = get_ts_node_body(content, &offsets, full.start(), full.as_str(), None);
        nodes.push(ParsedNode {
            id: format!("{file_id}:type:{name}:{start_line}"),
            kind: "type",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code.clone()),
        });
        nodes.extend(extract_interface_members(&code, start_line, file_id, name));
    }

    for caps in TYPE_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        let end_offset = scan_expression_end(content, full.end());
        let code = slice(content, full.start(), end_offset);
        let end_line = end_line_for(&offsets, end_offset);
        nodes.push(ParsedNode {
            id: format!("{file_id}:type:{name}:{start_line}"),
            kind: "type",
            name: name.to_string(),
            signature: None,
            start_line,
            end_line,
            code: Some(code),
        });
    }

    for caps in NAMESPACE_EXPORT_REGEX.captures_iter(content).flatten() {
        let Some(full) = caps.get(0) else { continue };
        let Some(name) = caps.get(1) else { continue };
        let name = name.as_str();
        let start_line = decl_start_line(content, &offsets, full.start());
        nodes.push(ParsedNode {
            id: format!("{file_id}:variable:{name}:{start_line}"),
            kind: "variable",
            name: name.to_string(),
            signature: Some(format!("export * as {name}")),
            start_line,
            end_line: start_line,
            code: Some(full.as_str().trim().to_string()),
        });
    }

    ParseResult { nodes, edges, backend: "regex", syntax_error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_function_and_arrow_nodes() {
        let content = "export function add(a: number) {\n  return a\n}\n\nexport const mul = (a: number) => {\n  return a\n}\n";
        let result = parse_typescript(content, "F");
        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"add"), "{names:?}");
        assert!(names.contains(&"mul"), "{names:?}");
        let add = result.nodes.iter().find(|n| n.name == "add").unwrap();
        assert_eq!(add.id, "F:function:add:1");
        assert_eq!(add.start_line, 1);
        assert_eq!(add.end_line, 3);
    }

    #[test]
    fn extracts_class_and_methods() {
        let content = "class Widget {\n  draw(x: number) {\n    return x\n  }\n}\n";
        let result = parse_typescript(content, "F");
        assert!(result.nodes.iter().any(|n| n.kind == "class" && n.name == "Widget"));
        let method = result.nodes.iter().find(|n| n.kind == "method").unwrap();
        assert_eq!(method.name, "draw");
        assert_eq!(method.start_line, 2);
    }

    #[test]
    fn extracts_imports_as_module_edges() {
        let content = "import { a } from \"./a\"\nimport b from \"./b\"\n";
        let result = parse_typescript(content, "F");
        assert_eq!(result.edges.len(), 2);
        assert_eq!(result.edges[0].to_node_id, "module:./a");
        assert_eq!(result.edges[0].kind, "imports");
    }

    #[test]
    fn non_exported_class_is_not_matched_twice() {
        let content = "export class A {}\nclass B {}\n";
        let result = parse_typescript(content, "F");
        let classes: Vec<&str> = result
            .nodes
            .iter()
            .filter(|n| n.kind == "class")
            .map(|n| n.name.as_str())
            .collect();
        assert_eq!(classes, vec!["A", "B"]);
    }
}
