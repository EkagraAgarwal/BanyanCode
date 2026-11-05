//! Per-file pipeline: read → hash → skip decisions → parse.
//!
//! The decision order is a direct port of `indexCandidateFileCore` so the skip
//! buckets match the TypeScript backend one-for-one. Each bucket is incremented
//! at its own `return`, never derived from a total.

use crate::classify;
use crate::extract;
use crate::protocol::{FileInput, FileResult, FileTimings, ParseError, SkipCounts};
use crate::text;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Instant;

/// A single line longer than this is a minified/compiled bundle.
const MINIFIED_LINE_LIMIT: usize = 5000;

pub struct Outcome {
    pub result: FileResult,
    pub skip: SkipCounts,
}

fn relative_path(root: &str, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.replace('\\', "/"))
}

pub fn process_file(input: &FileInput, root: &str, max_file_size: u64, force: bool) -> Outcome {
    let rel = relative_path(root, &input.path);
    let mut skip = SkipCounts::default();
    let mut timings = FileTimings { read_ms: 0.0, hash_ms: 0.0, parse_ms: 0.0 };

    // Stage 1: (size, mtime) cache — the cheap check that avoids a read.
    if !force {
        if let (Some(known_size), Some(known_mtime)) = (input.known_size_bytes, input.known_mtime_ms) {
            if known_size == input.size_bytes && (known_mtime - input.mtime_ms).abs() < 0.5 {
                skip.cached = 1;
                return Outcome {
                    result: FileResult::skipped(
                        input.path.clone(),
                        rel,
                        input.file_id.clone(),
                        "cached",
                        input.size_bytes,
                        input.mtime_ms,
                        timings,
                    ),
                    skip,
                };
            }
        }
    }

    // Stage 2: read.
    let read_start = Instant::now();
    let content = match std::fs::read(&input.path) {
        Ok(bytes) => bytes,
        Err(_) => {
            timings.read_ms = read_start.elapsed().as_secs_f64() * 1000.0;
            skip.read_error = 1;
            return Outcome {
                result: FileResult::skipped(
                    input.path.clone(),
                    rel,
                    input.file_id.clone(),
                    "readError",
                    input.size_bytes,
                    input.mtime_ms,
                    timings,
                ),
                skip,
            };
        }
    };
    timings.read_ms = read_start.elapsed().as_secs_f64() * 1000.0;

    // Stage 3: the read is bigger than the parse budget.
    if content.len() as u64 > max_file_size {
        skip.too_large_parse = 1;
        return Outcome {
            result: FileResult::skipped(
                input.path.clone(),
                rel,
                input.file_id.clone(),
                "tooLargeParse",
                input.size_bytes,
                input.mtime_ms,
                timings,
            ),
            skip,
        };
    }

    // Stage 4: content hash — catches same-size edits with an unchanged mtime.
    let hash_start = Instant::now();
    let hash = format!("{:x}", Sha256::digest(&content));
    timings.hash_ms = hash_start.elapsed().as_secs_f64() * 1000.0;
    if !force {
        if let Some(known) = input.known_hash.as_deref() {
            if known == hash {
                skip.cached = 1;
                return Outcome {
                    result: FileResult::skipped(
                        input.path.clone(),
                        rel,
                        input.file_id.clone(),
                        "cached",
                        input.size_bytes,
                        input.mtime_ms,
                        timings,
                    ),
                    skip,
                };
            }
        }
    }

    // Files that are not valid UTF-8 cannot be parsed. The TypeScript path
    // reads with `utf8` and gets `undefined` from a decode failure, which lands
    // in the readError bucket; mirror that.
    let Ok(text) = std::str::from_utf8(&content) else {
        skip.read_error = 1;
        return Outcome {
            result: FileResult::skipped(
                input.path.clone(),
                rel,
                input.file_id.clone(),
                "readError",
                input.size_bytes,
                input.mtime_ms,
                timings,
            ),
            skip,
        };
    };

    let lines = text::line_count(text);
    if text.split('\n').any(|line| line.len() > MINIFIED_LINE_LIMIT) {
        skip.minified = 1;
        return Outcome {
            result: FileResult::skipped(
                input.path.clone(),
                rel,
                input.file_id.clone(),
                "minified",
                input.size_bytes,
                input.mtime_ms,
                timings,
            ),
            skip,
        };
    }

    let file_kind = classify::classify_file_kind(&input.path, text);
    let is_artifact = classify::is_artifact(&input.path);
    if is_artifact && file_kind.is_none() {
        skip.artifact = 1;
        return Outcome {
            result: FileResult::skipped(
                input.path.clone(),
                rel,
                input.file_id.clone(),
                "artifact",
                input.size_bytes,
                input.mtime_ms,
                timings,
            ),
            skip,
        };
    }

    // Stage 5: parse. A syntax error is recorded AND the file still indexes.
    let parse_start = Instant::now();
    let parsed = extract::parse_file(&input.path, text, &input.file_id, is_artifact);
    timings.parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;

    let parse_error = parsed.syntax_error.as_ref().map(|error| ParseError {
        message: format!("tree-sitter syntax error at line {}: {}", error.line, error.message),
    });
    if parse_error.is_some() {
        skip.parse_failure = 1;
    }

    Outcome {
        result: FileResult {
            kind: "file",
            path: input.path.clone(),
            relative_path: rel,
            file_id: input.file_id.clone(),
            status: "indexed",
            skip_reason: None,
            hash,
            language: classify::language_for(&input.path).to_string(),
            size_bytes: input.size_bytes,
            mtime_ms: input.mtime_ms,
            line_count: lines,
            file_code: text::slice_units(text, 4000),
            file_kind,
            nodes: parsed.nodes,
            edges: parsed.edges,
            parse_error,
            backend: parsed.backend,
            timings,
        },
        skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, body: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }

    fn input(path: &str, file_id: &str) -> FileInput {
        let meta = std::fs::metadata(path).unwrap();
        FileInput {
            path: path.to_string(),
            file_id: file_id.to_string(),
            size_bytes: meta.len(),
            mtime_ms: meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as f64)
                .unwrap_or(0.0),
            known_hash: None,
            known_size_bytes: None,
            known_mtime_ms: None,
        }
    }

    #[test]
    fn indexes_a_typescript_file() {
        let (dir, path) = write_temp("a.ts", "export function run() {}\n");
        let outcome = process_file(&input(&path, "F"), &dir.path().to_string_lossy(), 1_048_576, true);
        assert_eq!(outcome.result.status, "indexed");
        assert_eq!(outcome.result.language, "typescript");
        assert!(outcome.result.nodes.iter().any(|node| node.name == "run"));
        assert!(outcome.result.hash.len() == 64);
    }

    #[test]
    fn unchanged_size_and_mtime_hits_the_cached_bucket() {
        let (dir, path) = write_temp("a.ts", "export function run() {}\n");
        let mut file = input(&path, "F");
        file.known_size_bytes = Some(file.size_bytes);
        file.known_mtime_ms = Some(file.mtime_ms);
        let outcome = process_file(&file, &dir.path().to_string_lossy(), 1_048_576, false);
        assert_eq!(outcome.result.skip_reason, Some("cached"));
        assert_eq!(outcome.skip.cached, 1);
    }

    #[test]
    fn unchanged_hash_hits_the_cached_bucket() {
        let (dir, path) = write_temp("a.ts", "export function run() {}\n");
        let hash = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
        let mut file = input(&path, "F");
        file.known_hash = Some(hash);
        let outcome = process_file(&file, &dir.path().to_string_lossy(), 1_048_576, false);
        assert_eq!(outcome.result.skip_reason, Some("cached"));
        assert_eq!(outcome.skip.cached, 1);
    }

    #[test]
    fn oversized_file_hits_the_too_large_parse_bucket() {
        let (dir, path) = write_temp("a.ts", &"x".repeat(64));
        let outcome = process_file(&input(&path, "F"), &dir.path().to_string_lossy(), 8, true);
        assert_eq!(outcome.result.skip_reason, Some("tooLargeParse"));
        assert_eq!(outcome.skip.too_large_parse, 1);
    }

    #[test]
    fn long_line_hits_the_minified_bucket() {
        let body = format!("export const blob = \"{}\"\n", "x".repeat(MINIFIED_LINE_LIMIT + 1));
        let (dir, path) = write_temp("a.ts", &body);
        let outcome = process_file(&input(&path, "F"), &dir.path().to_string_lossy(), 1_048_576, true);
        assert_eq!(outcome.result.skip_reason, Some("minified"));
        assert_eq!(outcome.skip.minified, 1);
    }

    #[test]
    fn missing_file_hits_the_read_error_bucket() {
        let mut file = input(&write_temp("a.ts", "x").1, "F");
        file.path = "/definitely/not/here.ts".to_string();
        let outcome = process_file(&file, "/", 1_048_576, true);
        assert_eq!(outcome.result.skip_reason, Some("readError"));
        assert_eq!(outcome.skip.read_error, 1);
    }

    #[test]
    fn syntax_error_is_recorded_and_the_file_still_indexes() {
        let (dir, path) = write_temp("broken.ts", "export function run() {\n  return 1\n");
        let outcome = process_file(&input(&path, "F"), &dir.path().to_string_lossy(), 1_048_576, true);
        assert_eq!(outcome.result.status, "indexed");
        assert!(outcome.result.parse_error.is_some());
        assert_eq!(outcome.skip.parse_failure, 1);
    }
}
