//! `langs/markdown.ts` and `langs/docker.ts` ported to Rust.

use super::types::{ParseResult, ParsedNode};
use crate::text::{line_at_offset, line_start_offsets};
use fancy_regex::Regex;
use once_cell::sync::Lazy;

static HEADING_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^(#{1,6})[\s\u{feff}]+(.+?)[\s\u{feff}]*#*[\s\u{feff}]*$").unwrap());

pub fn parse_markdown(content: &str, file_id: &str) -> ParseResult {
    let mut nodes = Vec::new();
    let offsets = line_start_offsets(content);
    for caps in HEADING_REGEX.captures_iter(content).flatten() {
        let (Some(full), Some(hashes), Some(heading)) = (caps.get(0), caps.get(1), caps.get(2)) else {
            continue;
        };
        let heading = heading.as_str().trim();
        if heading.is_empty() {
            continue;
        }
        let start_line = line_at_offset(&offsets, full.start());
        nodes.push(ParsedNode {
            id: format!("{file_id}:doc:{start_line}:{heading}"),
            kind: "doc",
            name: heading.to_string(),
            signature: Some(format!("{} {heading}", hashes.as_str())),
            start_line,
            end_line: start_line,
            code: Some(full.as_str().to_string()),
        });
    }
    ParseResult { nodes, edges: Vec::new(), backend: "regex", syntax_error: None }
}

static DOCKER_INSTRUCTION_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?im)^(FROM|RUN|CMD|COPY|ENV|WORKDIR|ENTRYPOINT|EXPOSE|VOLUME|USER|ARG|ADD|LABEL|MAINTAINER|STOPSIGNAL|HEALTHCHECK|SHELL|ONBUILD|CMD)\b([^\n]*)$")
        .unwrap()
});

pub fn parse_docker(content: &str, file_id: &str) -> ParseResult {
    let mut nodes = Vec::new();
    let offsets = line_start_offsets(content);
    for caps in DOCKER_INSTRUCTION_REGEX.captures_iter(content).flatten() {
        let (Some(full), Some(instruction)) = (caps.get(0), caps.get(1)) else { continue };
        let instruction = instruction.as_str().to_uppercase();
        let rest = caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let start_line = line_at_offset(&offsets, full.start());
        let full_line = full.as_str().trim_end().to_string();
        nodes.push(ParsedNode {
            id: format!("{file_id}:docker:{instruction}:{start_line}"),
            kind: "docker",
            name: format!("{instruction} {rest}").trim().to_string(),
            signature: Some(full_line.clone()),
            start_line,
            end_line: start_line,
            code: Some(full_line),
        });
    }
    ParseResult { nodes, edges: Vec::new(), backend: "regex", syntax_error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_headings_become_doc_nodes() {
        let content = "# Title\n\ntext\n\n## Sub #\n";
        let result = parse_markdown(content, "F");
        assert_eq!(result.nodes.len(), 2);
        assert_eq!(result.nodes[0].name, "Title");
        assert_eq!(result.nodes[0].id, "F:doc:1:Title");
        assert_eq!(result.nodes[1].name, "Sub");
        assert_eq!(result.nodes[1].start_line, 5);
    }

    #[test]
    fn docker_instructions_become_docker_nodes() {
        let content = "FROM alpine:3\nRUN echo hi\n";
        let result = parse_docker(content, "F");
        assert_eq!(result.nodes.len(), 2);
        assert_eq!(result.nodes[0].id, "F:docker:FROM:1");
        assert_eq!(result.nodes[1].name, "RUN echo hi");
    }
}
