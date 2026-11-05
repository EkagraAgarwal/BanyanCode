//! tree-sitter grammar registry and syntax-error detection.
//!
//! Mirrors `langs/tree-sitter.ts` (`GRAMMAR_EXTENSIONS`) and the
//! `findSyntaxError` / `isVarianceModifierError` / `isKeywordMemberError`
//! helpers from `langs/query-executor.ts`, including the exact traversal
//! order: the TypeScript version pushes children in document order and pops
//! from the end, so it reports the *rightmost* first offending node. Matching
//! that order is what makes the two backends agree on which error a file with
//! several reports.

use fancy_regex::Regex;
use once_cell::sync::Lazy;
use tree_sitter::{Language, Node};

/// Grammar family → language, keyed by the extensions the TypeScript loader
/// groups together.
pub fn language_for_ext(ext: &str) -> Option<Language> {
    Some(match ext {
        ".ts" | ".tsx" | ".mts" | ".cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        ".js" | ".jsx" | ".mjs" | ".cjs" => tree_sitter_javascript::LANGUAGE.into(),
        ".py" | ".pyw" => tree_sitter_python::LANGUAGE.into(),
        ".rs" => tree_sitter_rust::LANGUAGE.into(),
        ".go" => tree_sitter_go::LANGUAGE.into(),
        ".java" => tree_sitter_java::LANGUAGE.into(),
        ".c" | ".h" => tree_sitter_c::LANGUAGE.into(),
        ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx" => tree_sitter_cpp::LANGUAGE.into(),
        ".cs" => tree_sitter_c_sharp::LANGUAGE.into(),
        ".rb" => tree_sitter_ruby::LANGUAGE.into(),
        ".php" => tree_sitter_php::LANGUAGE_PHP_ONLY.into(),
        ".sh" | ".bash" => tree_sitter_bash::LANGUAGE.into(),
        ".json" => tree_sitter_json::LANGUAGE.into(),
        ".zig" => tree_sitter_zig::LANGUAGE.into(),
        ".toml" => tree_sitter_toml_ng::LANGUAGE.into(),
        ".yml" | ".yaml" => tree_sitter_yaml::LANGUAGE.into(),
        _ => return None,
    })
}

/// A `'static` cache key for a grammar family. `with_parser` stores one
/// parser per key per thread, so the key must not borrow the caller's string.
pub fn family_key(ext: &str) -> &'static str {
    match ext {
        ".ts" | ".tsx" | ".mts" | ".cts" => "typescript",
        ".js" | ".jsx" | ".mjs" | ".cjs" => "javascript",
        ".py" | ".pyw" => "python",
        ".rs" => "rust",
        ".go" => "go",
        ".java" => "java",
        ".c" | ".h" => "c",
        ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx" => "cpp",
        ".cs" => "csharp",
        ".rb" => "ruby",
        ".php" => "php",
        ".sh" | ".bash" => "bash",
        ".json" => "json",
        ".zig" => "zig",
        ".toml" => "toml",
        ".yml" | ".yaml" => "yaml",
        _ => "unknown",
    }
}

// One parser per grammar per worker thread. `Parser::new()` + `set_language`
// costs ~40ms for a grammar the first time and several hundred microseconds
// after that; doing it per file on a 5k-file tree is pure waste.
thread_local! {
    static PARSERS: std::cell::RefCell<std::collections::HashMap<&'static str, tree_sitter::Parser>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Parse `content` with the cached parser for `family`, creating it on first
/// use in this thread.
pub fn with_parser<R>(
    family: &'static str,
    language: &Language,
    content: &str,
    f: impl FnOnce(tree_sitter::Tree) -> R,
) -> Option<R> {
    PARSERS.with(|parsers| {
        let mut parsers = parsers.borrow_mut();
        if !parsers.contains_key(family) {
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(language).ok()?;
            parsers.insert(family, parser);
        }
        let parser = parsers.get_mut(family)?;
        let tree = parser.parse(content, None)?;
        Some(f(tree))
    })
}

/// The callable node kinds `findEnclosingCallable` walks up to.
const CALLABLE_KINDS: &[&str] = &[
    "function_declaration",
    "function",
    "method_definition",
    "arrow_function",
    "generator_function_declaration",
    "function_definition",
];

pub fn find_enclosing_callable(node: Node<'_>) -> Option<Node<'_>> {
    let mut current = node.parent();
    while let Some(candidate) = current {
        if CALLABLE_KINDS.contains(&candidate.kind()) {
            return Some(candidate);
        }
        current = candidate.parent();
    }
    None
}

/// The vendored TS grammar predates variance annotations, so a valid
/// `interface KeyedMutex<in Key>` produces an ERROR node. Reporting that would
/// flag valid source.
fn is_variance_modifier_error(node: Node<'_>, source: &[u8]) -> bool {
    if node.kind() != "ERROR" {
        return false;
    }
    let Some(parent) = node.parent() else { return false };
    if parent.kind() != "type_parameters" {
        return false;
    }
    let text = node.utf8_text(source).unwrap_or("");
    let trimmed = text.trim();
    if trimmed == "in" || trimmed == "out" {
        return true;
    }
    match node.prev_sibling() {
        Some(previous) if previous.kind() == "type_parameter" => {
            let previous_text = previous.utf8_text(source).unwrap_or("").trim().to_string();
            previous_text == "in" || previous_text == "out"
        }
        _ => false,
    }
}

static KEYWORD_MEMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)(?:in|instanceof)\??\s*:").unwrap());

/// The grammar inserts no semicolon before a line starting with `in` or
/// `instanceof`, so a member with that name after a semicolon-less member comes
/// back as an error in valid code.
fn is_keyword_member_error(node: Node<'_>, source: &[u8]) -> bool {
    let text = node.utf8_text(source).unwrap_or("");
    if !KEYWORD_MEMBER.is_match(text).unwrap_or(false) {
        return false;
    }
    match node.parent() {
        Some(parent) => matches!(parent.kind(), "object_type" | "interface_body" | "ERROR"),
        None => false,
    }
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out
}

fn snippet(text: &str) -> String {
    let collapsed = collapse_whitespace(text);
    let mut units = 0usize;
    let mut end = 0usize;
    for (offset, ch) in collapsed.char_indices() {
        let width = ch.len_utf16();
        if units + width > 60 {
            break;
        }
        units += width;
        end = offset + ch.len_utf8();
    }
    collapsed[..end].to_string()
}

/// `findSyntaxError`: iterative DFS, children pushed in document order so the
/// last pushed (rightmost) subtree is visited first.
pub fn find_syntax_error(root: Node<'_>, source: &[u8]) -> Option<(u32, String)> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "ERROR" {
            if !is_variance_modifier_error(node, source) && !is_keyword_member_error(node, source) {
                let text = node.utf8_text(source).unwrap_or("");
                let text = snippet(text);
                let message = if text.is_empty() {
                    "syntax error near 'unexpected token'".to_string()
                } else {
                    format!("syntax error near '{text}'")
                };
                return Some((node.start_position().row as u32 + 1, message));
            }
            continue;
        }
        if node.is_missing() {
            return Some((node.start_position().row as u32 + 1, format!("missing '{}'", node.kind())));
        }
        for index in 0..node.child_count() {
            if let Some(child) = node.child(index) {
                stack.push(child);
            }
        }
    }
    None
}

/// `normalizeTypeScriptForSyntax`: neutralise the constructs the vendored
/// grammar cannot parse, so a false positive is not reported as a real error.
pub fn normalize_typescript_for_syntax(input: &str) -> String {
    static EXPORT_TYPE_STAR: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(\bexport\s+)type(\s+\*\s+from\b)").unwrap());
    static VARIANCE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"\b(in\s+out|out\s+in|in|out)\b(\s+)(?=[A-Za-z0-9_][A-Za-z0-9_]*\s*(?:[,>=]|\bextends\b))").unwrap()
    });

    let mut text = EXPORT_TYPE_STAR
        .replace_all(input, |caps: &fancy_regex::Captures<'_>| {
            format!("{}    {}", &caps[1], &caps[2])
        })
        .into_owned();

    // Variance annotations inside a generic parameter list.
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(open) = text[cursor..].find('<').map(|r| cursor + r) else { break };
        let mut before_start = open.saturating_sub(160);
        while !text.is_char_boundary(before_start) {
            before_start -= 1;
        }
        let before = &text[before_start..open];
        if !(before.ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$') || before.trim_end().is_empty()) {
            cursor = open + 1;
            continue;
        }
        let Some(close) = find_matching(&text, open, b'<', b'>') else {
            cursor = open + 1;
            continue;
        };
        let interior = &text[open + 1..close];
        let stripped = VARIANCE.replace_all(interior, |caps: &fancy_regex::Captures<'_>| {
            " ".repeat(caps[1].len())
        });
        if stripped != interior {
            text = format!("{}{}{}", &text[..open + 1], stripped, &text[close..]);
        }
        cursor = close + 1;
    }

    // `sql<T>\`...\``: blank the type arguments when a template literal
    // follows, because the grammar inserts a missing `!` otherwise.
    cursor = 0;
    while cursor < text.len() {
        let Some(open) = text[cursor..].find('<').map(|r| cursor + r) else { break };
        let mut before_start = open.saturating_sub(160);
        while !text.is_char_boundary(before_start) {
            before_start -= 1;
        }
        let before = &text[before_start..open];
        let before_ok = {
            let trimmed = before.trim_end();
            let mut chars = trimmed.chars().rev();
            match chars.next() {
                Some(ch) if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || ch == '.' => true,
                _ => false,
            }
        };
        if !before_ok {
            cursor = open + 1;
            continue;
        }
        let Some(close) = find_matching(&text, open, b'<', b'>') else {
            cursor = open + 1;
            continue;
        };
        let mut next = close + 1;
        let bytes = text.as_bytes();
        while next < bytes.len() && crate::text::is_js_ws(bytes[next] as char) {
            next += 1;
        }
        if bytes.get(next) != Some(&b'`') {
            cursor = open + 1;
            continue;
        }
        text = blank_out(&text, open, close + 1);
        cursor = close + 1;
    }

    // Generic call signatures on their own line: the grammar only recovers
    // cleanly from one per interface.
    // Offsets are into the whole text, and blanking keeps its length and line
    // breaks, so the line split stays valid while the text is rewritten. A
    // signature may span several lines: it must be blanked in the whole text.
    let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut offset = 0usize;
    for line in &lines {
        let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
        if line[indent..].starts_with('<') {
            let open = offset + indent;
            if let Some(close) = find_matching(&text, open, b'<', b'>') {
                let bytes = text.as_bytes();
                let mut next = close + 1;
                while next < bytes.len() && crate::text::is_js_ws(bytes[next] as char) {
                    next += 1;
                }
                if bytes.get(next) == Some(&b'(') {
                    text = blank_out(&text, open, close + 1);
                }
            }
        }
        offset += line.len() + 1;
    }
    text
}

fn find_matching(text: &str, open: usize, open_char: u8, close_char: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let limit = (open + 8000).min(bytes.len());
    let mut depth = 0i32;
    let mut index = open;
    while index < limit {
        if bytes[index] == open_char {
            depth += 1;
        } else if bytes[index] == close_char {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

fn blank_out(text: &str, start: usize, end: usize) -> String {
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..start]);
    for byte in text.as_bytes()[start..end].iter() {
        out.push(if *byte == b'\n' { '\n' } else { ' ' });
    }
    out.push_str(&text[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generic_signature_spanning_lines_is_blanked_without_panicking() {
        let source = "interface F {
  <T,
    U extends string>(value: T): U
  é(): void
}
";
        let out = normalize_typescript_for_syntax(source);
        assert_eq!(out.len(), source.len());
        assert!(!out.contains("<T"));
        assert!(!out.contains("U extends"));
        assert!(out.contains("(value: T): U"));
    }

    fn parse(ext: &str, source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language_for_ext(ext).unwrap()).unwrap();
        parser.parse(source, None).unwrap()
    }

    #[test]
    fn clean_source_has_no_syntax_error() {
        let source = "export function add(a: number) { return a }\n";
        let tree = parse(".ts", source);
        assert!(find_syntax_error(tree.root_node(), source.as_bytes()).is_none());
    }

    #[test]
    fn broken_source_reports_a_syntax_error() {
        let source = "export function add(a: number) { return a\n";
        let tree = parse(".ts", source);
        let error = find_syntax_error(tree.root_node(), source.as_bytes());
        assert!(error.is_some(), "expected a syntax error");
    }

    #[test]
    fn variance_annotation_is_not_reported() {
        let source = "export interface Keyed<in K, out V> { get(k: K): V }\n";
        let tree = parse(".ts", source);
        assert!(find_syntax_error(tree.root_node(), source.as_bytes()).is_none());
    }

    #[test]
    fn export_type_star_is_normalized() {
        let source = "export type * from \"./x\"\n";
        assert_ne!(normalize_typescript_for_syntax(source), source);
    }
}
