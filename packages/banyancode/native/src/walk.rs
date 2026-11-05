//! `full`-mode directory walk.
//!
//! Production indexing uses the `files` mode: TypeScript owns the walk because
//! it also owns the nested-`.gitignore` semantics and the skip-bucket
//! accounting the staleness/readiness logic depends on. This module exists so
//! the sidecar can stand alone (benchmarks, future callers, `--walk` probing)
//! and so the `ignore` crate has a single, testable user.
//!
//! Bucket attribution mirrors `decideIgnored`: deepest nested `.gitignore`
//! first, then the root `.gitignore`, then the built-in defaults, then
//! `.banyancode/ignore` plus caller exclude patterns. Each decision is counted
//! at the point it is made.

use crate::classify;
use crate::protocol::SkipCounts;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Same defaults as `DEFAULT_IGNORED` + `DEFAULT_PRODUCT_EXCLUDES` +
/// `DEFAULT_GENERATED_EXCLUDES` in `codegraph-indexer.ts`.
pub const DEFAULT_IGNORED: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".cache",
    "target",
    "vendor",
    "out",
    "temp",
    ".sst",
    ".turbo",
    ".drizzle",
    ".git",
    ".opencode",
    ".banyancode",
    ".bun",
    ".bun-cache",
    ".worktrees",
    ".claude/worktrees",
    "*.db",
    "*.db-wal",
    "*.db-shm",
    "*.lock",
    "packages/web",
    "packages/app",
    "packages/desktop",
    "packages/storybook",
    "packages/sdk/js/src/gen",
    "packages/sdk/js/src/v2/gen",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoreDecision {
    Git,
    Banyan,
    None,
}

pub struct Walker {
    root: PathBuf,
    defaults: Gitignore,
    banyan: Gitignore,
    nested: HashMap<PathBuf, Option<Gitignore>>,
    max_file_size: u64,
    pub skipped: SkipCounts,
    pub files: Vec<(PathBuf, u64, f64)>,
}

impl Walker {
    pub fn new(root: &Path, exclude_patterns: &[String], max_file_size: u64) -> Self {
        let mut defaults_builder = GitignoreBuilder::new(root);
        for pattern in DEFAULT_IGNORED {
            let _ = defaults_builder.add_line(None, pattern);
        }
        let defaults = defaults_builder.build().unwrap_or_else(|_| Gitignore::empty());

        let mut banyan_builder = GitignoreBuilder::new(root);
        if let Ok(content) = std::fs::read_to_string(root.join(".banyancode").join("ignore")) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                let _ = banyan_builder.add_line(None, trimmed);
            }
        }
        for pattern in exclude_patterns {
            let _ = banyan_builder.add_line(None, pattern);
        }
        let banyan = banyan_builder.build().unwrap_or_else(|_| Gitignore::empty());

        Self {
            root: root.to_path_buf(),
            defaults,
            banyan,
            nested: HashMap::new(),
            max_file_size,
            skipped: SkipCounts::default(),
            files: Vec::new(),
        }
    }

    fn nested_gitignore(&mut self, dir: &Path) -> Option<&Gitignore> {
        if !self.nested.contains_key(dir) {
            let path = dir.join(".gitignore");
            let built = if path.is_file() {
                let mut builder = GitignoreBuilder::new(dir);
                builder.add(&path);
                builder.build().ok()
            } else {
                None
            };
            self.nested.insert(dir.to_path_buf(), built);
        }
        self.nested.get(dir).and_then(|entry| entry.as_ref())
    }

    fn decide(&mut self, path: &Path, is_dir: bool) -> IgnoreDecision {
        let mut dir = path.parent().map(|parent| parent.to_path_buf());
        while let Some(current) = dir {
            if current == self.root || current.as_os_str().len() <= self.root.as_os_str().len() {
                break;
            }
            if let Some(gitignore) = self.nested_gitignore(&current) {
                match gitignore.matched(path, is_dir) {
                    ignore::Match::Ignore(_) => return IgnoreDecision::Git,
                    ignore::Match::Whitelist(_) => return IgnoreDecision::None,
                    ignore::Match::None => {}
                }
            }
            dir = current.parent().map(|parent| parent.to_path_buf());
        }
        match self.defaults.matched(path, is_dir) {
            ignore::Match::Ignore(_) => return IgnoreDecision::Git,
            ignore::Match::Whitelist(_) => return IgnoreDecision::None,
            ignore::Match::None => {}
        }
        match self.banyan.matched(path, is_dir) {
            ignore::Match::Ignore(_) => IgnoreDecision::Banyan,
            _ => IgnoreDecision::None,
        }
    }

    pub fn walk(&mut self) {
        let root = self.root.clone();
        self.walk_dir(&root);
    }

    fn walk_dir(&mut self, dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut children: Vec<PathBuf> = entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).collect();
        children.sort();
        for path in children {
            let Ok(metadata) = std::fs::metadata(&path) else { continue };
            let is_dir = metadata.is_dir();
            match self.decide(&path, is_dir) {
                IgnoreDecision::Git => {
                    if is_dir {
                        self.skipped.gitignored += 1;
                    } else {
                        self.skipped.gitignored += 1;
                    }
                    continue;
                }
                IgnoreDecision::Banyan => {
                    self.skipped.banyanignored += 1;
                    continue;
                }
                IgnoreDecision::None => {}
            }
            if is_dir {
                self.walk_dir(&path);
                continue;
            }
            if !metadata.is_file() || !classify::is_indexable_path(&path.to_string_lossy()) {
                continue;
            }
            if metadata.len() > self.max_file_size {
                self.skipped.too_large += 1;
                continue;
            }
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as f64)
                .unwrap_or(0.0);
            self.files.push((path, metadata.len(), mtime));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn counts_each_skip_bucket_at_its_own_decision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/a.ts", "export function a() {}\n");
        write(root, "node_modules/pkg/index.ts", "export function b() {}\n");
        write(root, "notes.txt", "ignored by extension\n");
        write(root, "src/vendor.ts", "export function c() {}\n");
        write(root, ".banyancode/ignore", "src/vendor.ts\n");
        write(root, ".gitignore", "*.log\n");
        write(root, "build.log", "x\n");

        let mut walker = Walker::new(root, &[], 1_048_576);
        walker.walk();
        let paths: Vec<String> = walker
            .files
            .iter()
            .map(|(path, _, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(paths, vec!["a.ts"], "{paths:?}");
        assert_eq!(walker.skipped.banyanignored, 1);
        assert!(walker.skipped.gitignored >= 2, "{:?}", walker.skipped);
    }
}
