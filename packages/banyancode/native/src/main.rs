//! `banyan-indexer` — native parse/extract sidecar for the BanyanCode
//! codegraph indexer.
//!
//! NDJSON over stdin/stdout. The sidecar never opens SQLite: TypeScript stays
//! the single writer so the schema keeps one owner.
//!
//! Usage:
//!   banyan-indexer --version        print the version (used by verify-artifact)
//!   banyan-indexer                  run the protocol loop on stdin/stdout
//!
//! Back-pressure: files are parsed on a rayon pool and pushed through a
//! BOUNDED channel to one writer thread. When the consumer (TypeScript, writing
//! SQLite) falls behind, `send` blocks, which parks a rayon worker, which stops
//! the pool from starting more files. Nothing queues without a bound.

mod classify;
mod extract;
mod pipeline;
mod protocol;
mod text;
mod walk;

use protocol::{ErrorLine, FileInput, Hello, Request, SkipCounts, Summary, SummaryTimings, PROTOCOL_VERSION, VERSION};
use rayon::prelude::*;
use std::io::{BufRead, BufWriter, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::Instant;

/// Files in flight between the parse pool and the writer. Small enough that a
/// slow consumer stalls the parsers quickly instead of growing the heap.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Per-file skip buckets, summed across worker threads. Each bucket is
/// incremented exactly where the decision is made (see `pipeline`), never
/// derived from a total.
static COUNTS: Counts = Counts::new();
static FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Counts {
    cached: AtomicU64,
    artifact: AtomicU64,
    minified: AtomicU64,
    too_large_parse: AtomicU64,
    read_error: AtomicU64,
    parse_failure: AtomicU64,
}

impl Counts {
    const fn new() -> Self {
        Self {
            cached: AtomicU64::new(0),
            artifact: AtomicU64::new(0),
            minified: AtomicU64::new(0),
            too_large_parse: AtomicU64::new(0),
            read_error: AtomicU64::new(0),
            parse_failure: AtomicU64::new(0),
        }
    }

    fn record(&self, skip: &SkipCounts) {
        self.cached.fetch_add(skip.cached, Ordering::Relaxed);
        self.artifact.fetch_add(skip.artifact, Ordering::Relaxed);
        self.minified.fetch_add(skip.minified, Ordering::Relaxed);
        self.too_large_parse.fetch_add(skip.too_large_parse, Ordering::Relaxed);
        self.read_error.fetch_add(skip.read_error, Ordering::Relaxed);
        self.parse_failure.fetch_add(skip.parse_failure, Ordering::Relaxed);
    }

    fn snapshot(&self) -> SkipCounts {
        SkipCounts {
            gitignored: 0,
            banyanignored: 0,
            artifact: self.artifact.load(Ordering::Relaxed),
            too_large: 0,
            minified: self.minified.load(Ordering::Relaxed),
            too_large_parse: self.too_large_parse.load(Ordering::Relaxed),
            cached: self.cached.load(Ordering::Relaxed),
            read_error: self.read_error.load(Ordering::Relaxed),
            parse_failure: self.parse_failure.load(Ordering::Relaxed),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("banyan-indexer {VERSION} protocol {PROTOCOL_VERSION}");
        return;
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("banyan-indexer {VERSION}");
        println!(
            "NDJSON protocol {PROTOCOL_VERSION} over stdin/stdout. Send one request line, receive one line per file plus a summary line."
        );
        return;
    }

    let mut out = BufWriter::new(std::io::stdout());
    if writeln!(out, "{}", serde_json::to_string(&Hello::new()).unwrap()).is_err() {
        return;
    }
    if out.flush().is_err() {
        return;
    }

    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return;
    }
    let request: Request = match serde_json::from_str(line.trim()) {
        Ok(request) => request,
        Err(error) => {
            let _ = writeln!(
                out,
                "{}",
                serde_json::to_string(&ErrorLine {
                    kind: "error",
                    protocol: PROTOCOL_VERSION,
                    message: format!("malformed request: {error}"),
                })
                .unwrap()
            );
            let _ = out.flush();
            std::process::exit(2);
        }
    };

    if request.protocol != PROTOCOL_VERSION {
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string(&ErrorLine {
                kind: "error",
                protocol: PROTOCOL_VERSION,
                message: format!(
                    "protocol mismatch: client sent {}, sidecar speaks {}",
                    request.protocol, PROTOCOL_VERSION
                ),
            })
            .unwrap()
        );
        let _ = out.flush();
        std::process::exit(3);
    }

    let exit = run(request);
    let _ = out.flush();
    std::process::exit(exit);
}

fn run(request: Request) -> i32 {
    let started = Instant::now();
    let force = request.force;
    let max_file_size = request.max_file_size_bytes;
    let root = request.root.clone();

    let walk_start = Instant::now();
    let mut walk_skips = SkipCounts::default();
    let inputs: Vec<FileInput> = if request.mode == "full" {
        let mut walker =
            walk::Walker::new(std::path::Path::new(&request.root), &request.exclude_patterns, max_file_size);
        walker.walk();
        walk_skips = walker.skipped;
        walker
            .files
            .into_iter()
            .map(|(path, size, mtime)| FileInput {
                file_id: uuid_v4(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: size,
                mtime_ms: mtime,
                known_hash: None,
                known_size_bytes: None,
                known_mtime_ms: None,
            })
            .collect()
    } else {
        request.files.clone()
    };
    let walk_ms = walk_start.elapsed().as_secs_f64() * 1000.0;

    let workers = std::thread::available_parallelism().map(|value| value.get()).unwrap_or(1);
    let read_us = AtomicU64::new(0);
    let hash_us = AtomicU64::new(0);
    let parse_us = AtomicU64::new(0);
    let indexed = AtomicU64::new(0);
    let parse_errors = AtomicU64::new(0);

    let (sender, receiver) = sync_channel::<String>(OUTPUT_CHANNEL_CAPACITY);
    let writer = std::thread::spawn(move || {
        let mut out = BufWriter::new(std::io::stdout());
        for line in receiver {
            if out.write_all(line.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
                return false;
            }
        }
        out.flush().is_ok()
    });

    inputs.par_iter().for_each(|input| {
        // One bad file must not end the run. A file with no result line is
        // indexed by the TypeScript parser, which the client already does.
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pipeline::process_file(input, &root, max_file_size, force)
        }));
        let Ok(outcome) = attempt else {
            eprintln!("banyan-indexer: panicked on {}", input.path);
            return;
        };
        COUNTS.record(&outcome.skip);
        read_us.fetch_add((outcome.result.timings.read_ms * 1000.0) as u64, Ordering::Relaxed);
        hash_us.fetch_add((outcome.result.timings.hash_ms * 1000.0) as u64, Ordering::Relaxed);
        parse_us.fetch_add((outcome.result.timings.parse_ms * 1000.0) as u64, Ordering::Relaxed);
        if outcome.result.status == "indexed" {
            indexed.fetch_add(1, Ordering::Relaxed);
        }
        if outcome.result.parse_error.is_some() {
            parse_errors.fetch_add(1, Ordering::Relaxed);
        }
        let line = match serde_json::to_string(&outcome.result) {
            Ok(line) => line,
            Err(error) => serde_json::to_string(&ErrorLine {
                kind: "error",
                protocol: PROTOCOL_VERSION,
                message: format!("failed to encode {}: {error}", input.path),
            })
            .unwrap(),
        };
        // Bounded: blocks when the consumer is behind, which parks this rayon
        // worker and stops the pool from starting more files.
        let _ = sender.send(line);
    });

    drop(sender);
    let wrote_ok = writer.join().unwrap_or(false);

    let mut skipped = walk_skips;
    skipped.add(&COUNTS.snapshot());

    let summary = Summary {
        kind: "summary",
        protocol: PROTOCOL_VERSION,
        version: VERSION,
        mode: request.mode.clone(),
        files: inputs.len() as u64,
        indexed: indexed.load(Ordering::Relaxed),
        skipped: skipped.total(),
        parse_errors: parse_errors.load(Ordering::Relaxed),
        skipped_by_reason: skipped,
        timings: SummaryTimings {
            walk_ms,
            read_ms: read_us.load(Ordering::Relaxed) as f64 / 1000.0,
            hash_ms: hash_us.load(Ordering::Relaxed) as f64 / 1000.0,
            parse_ms: parse_us.load(Ordering::Relaxed) as f64 / 1000.0,
            total_ms: started.elapsed().as_secs_f64() * 1000.0,
        },
        workers,
    };
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", serde_json::to_string(&summary).unwrap());
    let _ = stdout.flush();

    if wrote_ok {
        0
    } else {
        1
    }
}

/// Minimal UUID-shaped id, only used in `full` mode where the caller does not
/// pre-assign file ids.
fn uuid_v4() -> String {
    let counter = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let mixed = nanos ^ counter.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    let a = (mixed >> 32) as u32;
    let b = ((mixed >> 16) & 0xffff) as u16;
    let c = (((mixed >> 8) & 0x0fff) as u16) | 0x4000;
    let d = (((mixed >> 4) & 0x3fff) as u16) | 0x8000;
    let e = (mixed & 0xffff_ffff_ffff) as u64;
    format!("{a:08x}-{b:04x}-{c:04x}-{d:04x}-{e:012x}")
}
