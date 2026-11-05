//! NDJSON wire protocol shared with `codegraph-indexer.ts`.
//!
//! One request, one line per file, one final summary line. The sidecar never
//! opens SQLite: TypeScript stays the single writer, so the schema keeps one
//! owner.
//!
//! Startup handshake:
//!   sidecar -> {"type":"hello","protocol":1,"version":"0.1.0","backends":[...]}
//!   client  -> {"type":"request","protocol":1,...}
//! A protocol mismatch is a hard error on both sides: the client kills the
//! child and falls back to the TypeScript parser.

use serde::{Deserialize, Serialize};

/// Bumped whenever the request or response shape changes incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol: u32,
    pub version: &'static str,
    pub backends: &'static [&'static str],
}

impl Hello {
    pub fn new() -> Self {
        Self {
            kind: "hello",
            protocol: PROTOCOL_VERSION,
            version: VERSION,
            backends: &["tree-sitter"],
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(rename = "type")]
    pub kind: String,
    pub protocol: u32,
    pub root: String,
    /// `"files"` processes `files` as given (the caller owns the walk and the
    /// gitignored/banyanignored/tooLarge buckets). `"full"` walks `root`
    /// itself with the `ignore` crate, for standalone/benchmark use.
    pub mode: String,
    #[serde(default)]
    pub files: Vec<FileInput>,
    #[serde(default)]
    pub force: bool,
    #[serde(default = "default_max_file_size")]
    pub max_file_size_bytes: u64,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
}

fn default_max_file_size() -> u64 {
    1_048_576
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInput {
    /// Absolute path on disk.
    pub path: String,
    /// Pre-assigned file id. Node ids are `${fileID}:${kind}:${name}:${line}`,
    /// so the caller must mint it before parsing to keep ids identical to the
    /// TypeScript path. `"full"` mode mints its own.
    // `ID` is an initialism: camelCase would emit `fileId`, but the
    // TypeScript side reads `fileID` (matching `CodegraphFile.id`'s spelling in
    // the rest of the codebase).
    #[serde(default, rename = "fileID")]
    pub file_id: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub mtime_ms: f64,
    /// Content hash of the row already in the graph, when there is one.
    #[serde(default)]
    pub known_hash: Option<String>,
    #[serde(default)]
    pub known_size_bytes: Option<u64>,
    #[serde(default)]
    pub known_mtime_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    #[serde(rename = "fromNodeID")]
    pub from_node_id: String,
    #[serde(rename = "toNodeID")]
    pub to_node_id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseError {
    pub message: String,
}

/// Every skip bucket the indexer reports. Each one is incremented at its own
/// decision site — never computed as `scanned - indexed`.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipCounts {
    pub gitignored: u64,
    pub banyanignored: u64,
    pub artifact: u64,
    pub too_large: u64,
    pub minified: u64,
    pub too_large_parse: u64,
    pub cached: u64,
    pub read_error: u64,
    pub parse_failure: u64,
}

impl SkipCounts {
    pub fn add(&mut self, other: &SkipCounts) {
        self.gitignored += other.gitignored;
        self.banyanignored += other.banyanignored;
        self.artifact += other.artifact;
        self.too_large += other.too_large;
        self.minified += other.minified;
        self.too_large_parse += other.too_large_parse;
        self.cached += other.cached;
        self.read_error += other.read_error;
        self.parse_failure += other.parse_failure;
    }

    pub fn total(&self) -> u64 {
        self.gitignored
            + self.banyanignored
            + self.artifact
            + self.too_large
            + self.minified
            + self.too_large_parse
            + self.cached
            + self.read_error
            + self.parse_failure
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTimings {
    pub read_ms: f64,
    pub hash_ms: f64,
    pub parse_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub path: String,
    pub relative_path: String,
    #[serde(rename = "fileID")]
    pub file_id: String,
    /// `"indexed"` or `"skipped"`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<&'static str>,
    pub hash: String,
    pub language: String,
    pub size_bytes: u64,
    pub mtime_ms: f64,
    pub line_count: u32,
    /// First 4000 UTF-16 units of the file. The indexer owns the file-level
    /// node (and the artifact node), and both carry this slice as `code`; the
    /// derived-edge pass reads it back for import scanning, so the caller must
    /// not have to read the file a second time.
    pub file_code: String,
    /// `classifyFileKind` result, when the file contributes an artifact node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_kind: Option<&'static str>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<ParseError>,
    pub backend: &'static str,
    pub timings: FileTimings,
}

impl FileResult {
    pub fn skipped(
        path: String,
        relative_path: String,
        file_id: String,
        reason: &'static str,
        size_bytes: u64,
        mtime_ms: f64,
        timings: FileTimings,
    ) -> Self {
        Self {
            kind: "file",
            path,
            relative_path,
            file_id,
            status: "skipped",
            skip_reason: Some(reason),
            hash: String::new(),
            language: String::new(),
            size_bytes,
            mtime_ms,
            line_count: 0,
            file_code: String::new(),
            file_kind: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            parse_error: None,
            backend: "regex",
            timings,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryTimings {
    pub walk_ms: f64,
    pub read_ms: f64,
    pub hash_ms: f64,
    pub parse_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol: u32,
    pub version: &'static str,
    pub mode: String,
    pub files: u64,
    pub indexed: u64,
    pub skipped: u64,
    pub parse_errors: u64,
    pub skipped_by_reason: SkipCounts,
    pub timings: SummaryTimings,
    pub workers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorLine {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol: u32,
    pub message: String,
}
