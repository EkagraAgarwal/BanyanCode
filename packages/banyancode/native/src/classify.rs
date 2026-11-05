//! Path classification, ported verbatim from `codegraph-indexer.ts`.
//!
//! Parity matters more than elegance here: a file the TypeScript path calls an
//! `artifact` and the native path calls `config` produces a different node
//! kind, which changes the graph. Every predicate below mirrors the TypeScript
//! expression it is named after, including the odd-looking ones (the
//! Dockerfile carve-out at the end of `is_artifact`).

use once_cell::sync::Lazy;
use fancy_regex::Regex;
use std::collections::HashSet;
use std::path::Path;

pub static CODE_EXTENSIONS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw", ".zig", ".rs", ".go", ".c", ".cpp",
        ".cc", ".cxx", ".h", ".hpp", ".hh", ".java", ".kt", ".cs", ".swift", ".rb", ".php", ".sh", ".bat", ".ps1",
        ".sql", ".html", ".css", ".md",
    ]
    .into_iter()
    .collect()
});

fn lower_ext(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn is_artifact_path(file_path: &str) -> bool {
    let base = basename(file_path);
    let lower = base.to_lowercase();
    let norm = normalized(file_path);
    if lower == "package.json" {
        return true;
    }
    if lower == "dockerfile" || lower.starts_with("dockerfile.") || lower.ends_with(".dockerfile") {
        return true;
    }
    if lower == "compose.yml" || lower == "compose.yaml" {
        return true;
    }
    if lower == "docker-compose.yml" || lower == "docker-compose.yaml" {
        return true;
    }
    if lower == "jenkinsfile" {
        return true;
    }
    if lower == ".gitlab-ci.yml" {
        return true;
    }
    if lower.starts_with("azure-pipelines") && lower.ends_with(".yml") {
        return true;
    }
    if lower.starts_with("tsconfig") && lower.ends_with(".json") {
        return true;
    }
    if lower == "pnpm-workspace.yaml" || lower == "pnpm-workspace.yml" {
        return true;
    }
    if lower == "pyproject.toml" || lower == "cargo.toml" || lower == "go.mod" {
        return true;
    }
    if lower == ".envrc" || lower == ".env.example" {
        return true;
    }
    if lower.starts_with(".env") || lower.starts_with("dotenv") {
        return true;
    }
    static GITHUB_WORKFLOW: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"/\.github/workflows/.+\.(yml|yaml)$").unwrap());
    static CIRCLECI: Lazy<Regex> = Lazy::new(|| Regex::new(r"/\.circleci/.+\.(yml|yaml)$").unwrap());
    static CONFIG_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.config\.(json|js|ts)$").unwrap());
    if GITHUB_WORKFLOW.is_match(&norm).unwrap_or(false) || CIRCLECI.is_match(&norm).unwrap_or(false) {
        return true;
    }
    if CONFIG_EXT.is_match(&base).unwrap_or(false) {
        return true;
    }
    lower == "config.json"
}

/// Shared eligibility predicate: the full walk and the incremental path must
/// index exactly the same file set.
pub fn is_indexable_path(file_path: &str) -> bool {
    CODE_EXTENSIONS.contains(lower_ext(file_path).as_str()) || is_artifact_path(file_path)
}

/// `classifyFileKind` — the artifact node kind a file contributes, if any.
pub fn classify_file_kind(file_path: &str, content: &str) -> Option<&'static str> {
    let base = basename(file_path);
    let lower = base.to_lowercase();
    let norm = normalized(file_path);

    static TEST_FILE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs)$").unwrap());
    if TEST_FILE.is_match(&base).unwrap_or(false) {
        return Some("test");
    }

    if lower.ends_with(".md") {
        return Some("doc");
    }
    if lower.starts_with("readme") || lower.starts_with("changelog") || lower.starts_with("contributing") {
        return Some("doc");
    }
    if lower.starts_with("design") && lower.ends_with(".md") {
        return Some("doc");
    }
    static DOCS_MD: Lazy<Regex> = Lazy::new(|| Regex::new(r"/(?:docs|rfcs)/.*\.md$").unwrap());
    if DOCS_MD.is_match(&norm).unwrap_or(false) {
        return Some("doc");
    }

    if lower == "dockerfile" || lower.starts_with("dockerfile.") || lower.ends_with(".dockerfile") {
        return Some("docker");
    }
    if lower == "compose.yml" || lower == "compose.yaml" {
        return Some("docker");
    }
    if lower == "docker-compose.yml" || lower == "docker-compose.yaml" {
        return Some("docker");
    }

    static GITHUB_WORKFLOW: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"/\.github/workflows/.+\.(yml|yaml)$").unwrap());
    if GITHUB_WORKFLOW.is_match(&norm).unwrap_or(false) {
        return Some("ci");
    }
    if lower == ".gitlab-ci.yml" || lower == "jenkinsfile" {
        return Some("ci");
    }
    static CIRCLECI: Lazy<Regex> = Lazy::new(|| Regex::new(r"/\.circleci/.+\.(yml|yaml)$").unwrap());
    if CIRCLECI.is_match(&norm).unwrap_or(false) {
        return Some("ci");
    }
    if lower.starts_with("azure-pipelines") && lower.ends_with(".yml") {
        return Some("ci");
    }

    if lower.starts_with(".env") || lower == ".envrc" || lower.starts_with("dotenv") {
        return Some("env");
    }

    if lower == "package.json" {
        return Some("config");
    }
    if lower.starts_with("tsconfig") && lower.ends_with(".json") {
        return Some("config");
    }
    if lower == "pnpm-workspace.yaml" || lower == "pnpm-workspace.yml" {
        return Some("config");
    }
    if lower == "pyproject.toml" || lower == "cargo.toml" || lower == "go.mod" {
        return Some("config");
    }
    static CONFIG_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.config\.(json|js|ts)$").unwrap());
    if CONFIG_EXT.is_match(&base).unwrap_or(false) || lower == "config.json" {
        return Some("config");
    }

    static GENERATED_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.generated\.(ts|js)$").unwrap());
    if GENERATED_EXT.is_match(&base).unwrap_or(false) {
        return Some("generated");
    }
    static CODE_GENERATED: Lazy<Regex> = Lazy::new(|| Regex::new(r"code generated by").unwrap());
    if CODE_GENERATED.is_match(content).unwrap_or(false) {
        return Some("generated");
    }
    static ROUTE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"app\.(get|post|put|delete|patch|all|use)\s*\(").unwrap());
    if ROUTE.is_match(content).unwrap_or(false) {
        return Some("route");
    }
    None
}

/// `isArtifact` from `indexCandidateFileCore`, including the Dockerfile
/// carve-out: a Dockerfile is *parsed* (it has real docker nodes) and only gets
/// its artifact node on top, so it must not take the empty-parse branch.
pub fn is_artifact(file_path: &str) -> bool {
    let base = basename(file_path).to_lowercase();
    let norm = normalized(file_path);
    static GITHUB_WORKFLOW: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"/\.github/workflows/.+\.(yml|yaml)$").unwrap());
    static CIRCLECI: Lazy<Regex> = Lazy::new(|| Regex::new(r"/\.circleci/.+\.(yml|yaml)$").unwrap());
    static CONFIG_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.config\.(json|js|ts)$").unwrap());
    let matched = norm.ends_with("package.json")
        || norm.ends_with("dockerfile")
        || norm.contains("dockerfile.")
        || norm.ends_with(".dockerfile")
        || norm.ends_with("compose.yml")
        || norm.ends_with("compose.yaml")
        || norm.ends_with("docker-compose.yml")
        || norm.ends_with("docker-compose.yaml")
        || norm.ends_with("jenkinsfile")
        || norm.ends_with(".gitlab-ci.yml")
        || (norm.contains("azure-pipelines") && norm.ends_with(".yml"))
        || (base.starts_with("tsconfig") && base.ends_with(".json"))
        || norm.ends_with("pnpm-workspace.yaml")
        || norm.ends_with("pnpm-workspace.yml")
        || norm.ends_with("pyproject.toml")
        || norm.ends_with("cargo.toml")
        || norm.ends_with("go.mod")
        || norm.ends_with(".envrc")
        || norm.ends_with(".env.example")
        || base.starts_with(".env")
        || base.starts_with("dotenv")
        || GITHUB_WORKFLOW.is_match(&norm).unwrap_or(false)
        || CIRCLECI.is_match(&norm).unwrap_or(false)
        || CONFIG_EXT.is_match(&base).unwrap_or(false)
        || base == "config.json";
    matched
        && base != "dockerfile"
        && !base.starts_with("dockerfile.")
        && !base.ends_with(".dockerfile")
}

/// The `language` column, ported from `indexCandidateFileCore`.
pub fn language_for(file_path: &str) -> &'static str {
    let ext = lower_ext(file_path);
    match ext.as_str() {
        ".ts" | ".tsx" | ".js" | ".jsx" | ".mts" | ".cts" | ".mjs" | ".cjs" => "typescript",
        ".py" | ".pyw" => "python",
        ".zig" => "zig",
        ".rs" => "rust",
        ".go" => "go",
        ".c" | ".cpp" | ".cc" | ".cxx" | ".h" | ".hpp" | ".hh" | ".hxx" => "c_cpp",
        ".java" | ".kt" => "java",
        ".cs" => "csharp",
        ".swift" => "swift",
        ".rb" => "ruby",
        ".php" => "php",
        ".sh" | ".bash" | ".bat" | ".ps1" => "shell",
        ".sql" => "sql",
        ".html" | ".css" => "web",
        ".md" => "markdown",
        ".json" => "json",
        ".toml" => "toml",
        ".yml" | ".yaml" => "yaml",
        _ => "generic",
    }
}

pub fn is_typescript_like(file_path: &str) -> bool {
    matches!(
        lower_ext(file_path).as_str(),
        ".ts" | ".tsx" | ".js" | ".jsx" | ".mts" | ".cts" | ".mjs" | ".cjs"
    )
}

pub fn is_python_like(file_path: &str) -> bool {
    matches!(lower_ext(file_path).as_str(), ".py" | ".pyw")
}

/// `TREE_SITTER_WALK_EXTENSIONS` from `langs/adapters/index.ts`.
pub fn is_walk_extension(file_path: &str) -> bool {
    matches!(
        lower_ext(file_path).as_str(),
        ".rs" | ".go"
            | ".java"
            | ".c"
            | ".h"
            | ".cpp"
            | ".cc"
            | ".cxx"
            | ".hpp"
            | ".hh"
            | ".hxx"
            | ".cs"
            | ".rb"
            | ".php"
            | ".sh"
            | ".bash"
            | ".json"
            | ".zig"
            | ".toml"
            | ".yml"
            | ".yaml"
    )
}

pub fn is_dockerfile(file_path: &str) -> bool {
    basename(file_path).to_lowercase().contains("dockerfile")
}
