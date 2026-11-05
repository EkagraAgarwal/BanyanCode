//! Parser dispatch, mirroring `indexCandidateFileCore`'s parse block.
//!
//! The order of the branches below is load-bearing: an artifact file parses to
//! nothing, TS/JS/Python merge `.scm` query edges onto regex nodes, the 13
//! AST-walk languages replace regex *nodes* but keep regex *edges*, and
//! everything else goes straight to its registry parser.

pub mod c_lang;
pub mod generic;
pub mod markdown;
pub mod python;
pub mod queries;
pub mod tree;
pub mod typescript;
pub mod types;
pub mod walker;

use crate::classify;
use types::{ParseResult, SyntaxError};

/// Extract nodes and edges for one file. `is_artifact` comes from
/// `classify::is_artifact`, which the caller has already computed (it needs the
/// same predicate for the skip decision).
pub fn parse_file(path: &str, content: &str, file_id: &str, is_artifact: bool) -> ParseResult {
    if is_artifact {
        return ParseResult::empty();
    }
    let ext = extension(path);

    if classify::is_typescript_like(path) {
        let Some(language) = tree::language_for_ext(&ext) else {
            return typescript::parse_typescript(content, file_id);
        };
        let Some(source) = queries::query_source_for(&ext) else {
            return typescript::parse_typescript(content, file_id);
        };
        let mut result = typescript::parse_typescript(content, file_id);
        let Some(outcome) =
            queries::run_query_and_extract(&language, source, "typescript", content, file_id, true)
        else {
            return result;
        };
        result.edges.extend(outcome.edges);
        result.backend = "tree-sitter";
        // The vendored grammar is the TS grammar, not TSX: JSX makes it emit
        // ERROR nodes on valid files, so a .tsx syntax error is never reported.
        result.syntax_error = if ext == ".tsx" { None } else { outcome.syntax_error };
        return result;
    }

    if classify::is_python_like(path) {
        let mut result = python::parse_python(content, file_id);
        let Some(language) = tree::language_for_ext(&ext) else {
            return result;
        };
        let Some(source) = queries::query_source_for(&ext) else {
            return result;
        };
        let Some(outcome) = queries::run_query_and_extract(&language, source, "python", content, file_id, false)
        else {
            return result;
        };
        result.edges.extend(outcome.edges);
        result.backend = "tree-sitter";
        result.syntax_error = outcome.syntax_error;
        return result;
    }

    if classify::is_walk_extension(path) {
        return parse_with_ast_walk(&ext, content, file_id);
    }

    regex_fallback_for(path, &ext, content, file_id)
}

fn parse_with_ast_walk(ext: &str, content: &str, file_id: &str) -> ParseResult {
    let regex = regex_fallback_for("", ext, content, file_id);
    let Some(mapping) = walker::mapping_for_ext(ext) else {
        return regex;
    };
    let Some(language) = tree::language_for_ext(ext) else {
        return regex;
    };
    let source = content.as_bytes();
    let Some((walked, syntax_error)) = tree::with_parser(tree::family_key(ext), &language, content, |tree| {
        let root = tree.root_node();
        (
            walker::walk_node_tree(root, mapping, source, file_id),
            tree::find_syntax_error(root, source).map(|(line, message)| SyntaxError { line, message }),
        )
    }) else {
        return regex;
    };
    let mut result = regex;
    if !walked.is_empty() {
        result.nodes = walked;
    }
    result.backend = "tree-sitter";
    result.syntax_error = syntax_error;
    result
}

/// `getParser`/`getParserForPath` from `langs/registry.ts`.
fn regex_fallback_for(path: &str, ext: &str, content: &str, file_id: &str) -> ParseResult {
    if !path.is_empty() && classify::is_dockerfile(path) {
        return markdown::parse_docker(content, file_id);
    }
    match ext {
        ".ts" | ".tsx" | ".mts" | ".cts" | ".js" | ".jsx" | ".mjs" | ".cjs" => {
            typescript::parse_typescript(content, file_id)
        }
        ".py" | ".pyw" => python::parse_python(content, file_id),
        ".c" | ".h" | ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx" => c_lang::parse_c(content, file_id),
        ".md" => markdown::parse_markdown(content, file_id),
        _ => generic::parse_generic(content, file_id),
    }
}

pub fn extension(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_files_parse_to_nothing() {
        let result = parse_file("/r/package.json", "{\"name\":\"x\"}", "F", true);
        assert!(result.nodes.is_empty());
        assert!(result.edges.is_empty());
    }

    #[test]
    fn dockerfiles_use_the_docker_parser() {
        let result = parse_file("/r/Dockerfile", "FROM alpine\nRUN echo hi\n", "F", false);
        assert_eq!(result.nodes.len(), 2);
        assert_eq!(result.nodes[0].kind, "docker");
    }

    #[test]
    fn typescript_routes_through_tree_sitter() {
        let result = parse_file("/r/a.ts", "export function run() {}\n", "F", false);
        assert_eq!(result.backend, "tree-sitter");
        assert!(result.nodes.iter().any(|n| n.name == "run"));
    }

    #[test]
    fn unknown_extension_falls_back_to_generic() {
        let result = parse_file("/r/a.kt", "fun run() {}\n", "F", false);
        assert_eq!(result.backend, "regex");
    }
}
