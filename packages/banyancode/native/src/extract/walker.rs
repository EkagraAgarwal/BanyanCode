//! The 13 adapter-driven AST walkers (`langs/adapters/*` + `walkNodeTree`).
//!
//! Each language's mapping is a direct port of its TypeScript adapter. The node
//! type and field names were verified against the bundled wasm grammars; the
//! crates.io grammars are the same upstream grammars, and the parity test
//! indexes a fixture per language to prove the names still resolve.

use super::types::ParsedNode;
use crate::text::slice_units;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use tree_sitter::Node;

#[derive(Clone, Copy)]
pub struct Entry {
    pub kind: &'static str,
    pub name_field: Option<&'static str>,
    pub name_sub_field: Option<&'static str>,
    pub method_only: bool,
    pub method_ancestors: &'static [&'static str],
    pub method_name_types: &'static [&'static str],
    /// `(child type, kind)` pairs, first match wins.
    pub kind_by_child: &'static [(&'static str, &'static str)],
    pub default_kind: Option<&'static str>,
    pub only_when_parent: &'static [&'static str],
    pub name_kinds: &'static [&'static str],
    pub name_depth: usize,
}

impl Entry {
    const fn new(kind: &'static str) -> Self {
        Self {
            kind,
            name_field: None,
            name_sub_field: None,
            method_only: false,
            method_ancestors: &[],
            method_name_types: &[],
            kind_by_child: &[],
            default_kind: None,
            only_when_parent: &[],
            name_kinds: &[],
            name_depth: 0,
        }
    }
    const fn name(mut self, field: &'static str) -> Self {
        self.name_field = Some(field);
        self
    }
    const fn sub_field(mut self, field: &'static str) -> Self {
        self.name_sub_field = Some(field);
        self
    }
    const fn method_only(mut self) -> Self {
        self.method_only = true;
        self
    }
    const fn method_ancestors(mut self, types: &'static [&'static str]) -> Self {
        self.method_ancestors = types;
        self
    }
    const fn method_name_types(mut self, types: &'static [&'static str]) -> Self {
        self.method_name_types = types;
        self
    }
    const fn kind_by_child(mut self, pairs: &'static [(&'static str, &'static str)]) -> Self {
        self.kind_by_child = pairs;
        self
    }
    const fn only_when_parent(mut self, types: &'static [&'static str]) -> Self {
        self.only_when_parent = types;
        self
    }
    const fn name_kinds(mut self, types: &'static [&'static str]) -> Self {
        self.name_kinds = types;
        self
    }
    const fn name_depth(mut self, depth: usize) -> Self {
        self.name_depth = depth;
        self
    }
}

fn table(entries: &[(&'static str, Entry)]) -> HashMap<&'static str, Entry> {
    entries.iter().copied().collect()
}

pub static RUST_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("function_item", Entry::new("function").name("name").method_ancestors(&["impl_item", "trait_item"])),
        (
            "function_signature_item",
            Entry::new("function").name("name").method_ancestors(&["impl_item", "trait_item"]),
        ),
        ("struct_item", Entry::new("class").name("name")),
        ("union_item", Entry::new("class").name("name")),
        ("enum_item", Entry::new("type").name("name")),
        ("trait_item", Entry::new("type").name("name")),
        ("type_item", Entry::new("type").name("name")),
    ])
});

pub static GO_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("function_declaration", Entry::new("function").name("name")),
        ("method_declaration", Entry::new("method").name("name").method_only()),
        (
            "type_spec",
            Entry::new("type")
                .name("name")
                .kind_by_child(&[("struct_type", "class"), ("interface_type", "type")]),
        ),
        ("var_spec", Entry::new("variable").name("name")),
        ("const_spec", Entry::new("variable").name("name")),
    ])
});

pub static JAVA_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("class_declaration", Entry::new("class").name("name")),
        ("record_declaration", Entry::new("class").name("name")),
        ("interface_declaration", Entry::new("type").name("name")),
        ("enum_declaration", Entry::new("type").name("name")),
        ("annotation_type_declaration", Entry::new("type").name("name")),
        ("method_declaration", Entry::new("method").name("name").method_only()),
    ])
});

pub static C_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("function_definition", Entry::new("function").name("declarator").sub_field("declarator")),
        ("struct_specifier", Entry::new("class").name("name")),
        ("union_specifier", Entry::new("class").name("name")),
        ("enum_specifier", Entry::new("type").name("name")),
        ("type_definition", Entry::new("type").name("declarator")),
        ("preproc_function_def", Entry::new("function").name("name")),
        ("preproc_def", Entry::new("variable").name("name")),
        (
            "declaration",
            Entry::new("variable")
                .name("declarator")
                .sub_field("declarator")
                .name_kinds(&["identifier", "init_declarator"])
                .only_when_parent(&["translation_unit"]),
        ),
    ])
});

pub static CPP_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        (
            "function_definition",
            Entry::new("function")
                .name("declarator")
                .sub_field("declarator")
                .method_ancestors(&["class_specifier", "struct_specifier"])
                .method_name_types(&["qualified_identifier"]),
        ),
        ("class_specifier", Entry::new("class").name("name")),
        ("struct_specifier", Entry::new("class").name("name")),
        ("union_specifier", Entry::new("class").name("name")),
        ("enum_specifier", Entry::new("type").name("name")),
        ("type_definition", Entry::new("type").name("declarator")),
        (
            "declaration",
            Entry::new("variable")
                .name("declarator")
                .sub_field("declarator")
                .name_kinds(&["identifier", "init_declarator"])
                .only_when_parent(&["translation_unit"]),
        ),
    ])
});

pub static CSHARP_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("class_declaration", Entry::new("class").name("name")),
        ("record_declaration", Entry::new("class").name("name")),
        ("struct_declaration", Entry::new("class").name("name")),
        ("interface_declaration", Entry::new("type").name("name")),
        ("enum_declaration", Entry::new("type").name("name")),
        ("delegate_declaration", Entry::new("type").name("name")),
        ("method_declaration", Entry::new("method").name("name").method_only()),
        ("property_declaration", Entry::new("variable").name("name")),
    ])
});

pub static RUBY_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("class", Entry::new("class").name("name")),
        ("module", Entry::new("type").name("name")),
        ("method", Entry::new("function").name("name").method_ancestors(&["class", "module"])),
        ("singleton_method", Entry::new("method").name("name").method_only()),
    ])
});

pub static PHP_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("class_declaration", Entry::new("class").name("name")),
        ("interface_declaration", Entry::new("type").name("name")),
        ("trait_declaration", Entry::new("type").name("name")),
        ("enum_declaration", Entry::new("type").name("name")),
        ("function_definition", Entry::new("function").name("name")),
        ("method_declaration", Entry::new("method").name("name").method_only()),
    ])
});

pub static BASH_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("function_definition", Entry::new("function").name("name")),
        ("variable_assignment", Entry::new("variable").name("name")),
    ])
});

pub static JSON_MAPPING: Lazy<HashMap<&'static str, Entry>> =
    Lazy::new(|| table(&[("pair", Entry::new("variable").name("key"))]));

pub static ZIG_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[
        ("function_declaration", Entry::new("function").name("name")),
        ("variable_declaration", Entry::new("variable").kind_by_child(&[("struct_declaration", "class")])),
    ])
});

pub static TOML_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[("table", Entry::new("type")), ("pair", Entry::new("variable"))])
});

pub static YAML_MAPPING: Lazy<HashMap<&'static str, Entry>> = Lazy::new(|| {
    table(&[("block_mapping_pair", Entry::new("variable").name("key").name_depth(2))])
});

pub fn mapping_for_ext(ext: &str) -> Option<&'static HashMap<&'static str, Entry>> {
    Some(match ext {
        ".rs" => &RUST_MAPPING,
        ".go" => &GO_MAPPING,
        ".java" => &JAVA_MAPPING,
        ".c" | ".h" => &C_MAPPING,
        ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx" => &CPP_MAPPING,
        ".cs" => &CSHARP_MAPPING,
        ".rb" => &RUBY_MAPPING,
        ".php" => &PHP_MAPPING,
        ".sh" | ".bash" => &BASH_MAPPING,
        ".json" => &JSON_MAPPING,
        ".zig" => &ZIG_MAPPING,
        ".toml" => &TOML_MAPPING,
        ".yml" | ".yaml" => &YAML_MAPPING,
        _ => return None,
    })
}

const WALKED_NODE_BODY_CAP: usize = 4000;
const METHOD_ANCESTOR_DEPTH: usize = 10;

const DECLARATOR_WRAPPERS: &[&str] = &[
    "pointer_declarator",
    "function_declarator",
    "init_declarator",
    "array_declarator",
    "parenthesized_declarator",
];

fn strip_walked_name(raw: &str) -> String {
    let mut trimmed = raw.trim().to_string();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = trimmed.as_bytes()[trimmed.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            trimmed = trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed
        .split("::")
        .last()
        .map(|segment| segment.to_string())
        .unwrap_or(trimmed)
}

fn resolve_walked_name_node<'tree>(node: Node<'tree>, entry: &Entry) -> Option<Node<'tree>> {
    let mut name_node = match entry.name_field {
        Some(field) => node.child_by_field_name(field)?,
        None => node.named_child(0)?,
    };
    if !entry.name_kinds.is_empty() && !entry.name_kinds.contains(&name_node.kind()) {
        return None;
    }
    if let Some(sub_field) = entry.name_sub_field {
        let mut sub = name_node.child_by_field_name(sub_field);
        while let Some(candidate) = sub {
            if !DECLARATOR_WRAPPERS.contains(&candidate.kind()) {
                break;
            }
            name_node = candidate;
            sub = name_node.child_by_field_name(sub_field);
        }
        if let Some(candidate) = sub {
            name_node = candidate;
        }
    }
    for _ in 0..entry.name_depth {
        match name_node.named_child(0) {
            Some(deeper) => name_node = deeper,
            None => break,
        }
    }
    Some(name_node)
}

fn has_ancestor_type(node: Node<'_>, types: &[&str]) -> bool {
    let mut current = node.parent();
    let mut depth = 0usize;
    while let Some(candidate) = current {
        if depth >= METHOD_ANCESTOR_DEPTH {
            break;
        }
        if types.contains(&candidate.kind()) {
            return true;
        }
        current = candidate.parent();
        depth += 1;
    }
    false
}

fn build_walked_node(node: Node<'_>, entry: &Entry, source: &[u8], file_id: &str) -> Option<ParsedNode> {
    if !entry.only_when_parent.is_empty() {
        let parent_kind = node.parent().map(|parent| parent.kind()).unwrap_or("");
        if !entry.only_when_parent.contains(&parent_kind) {
            return None;
        }
    }
    let mut kind = entry.kind;
    if !entry.kind_by_child.is_empty() {
        kind = entry.default_kind.unwrap_or(entry.kind);
        for index in 0..node.named_child_count() {
            let Some(child) = node.named_child(index) else { continue };
            if let Some((_, mapped)) = entry.kind_by_child.iter().find(|(child_type, _)| *child_type == child.kind()) {
                kind = mapped;
                break;
            }
        }
    }
    let name_node = resolve_walked_name_node(node, entry)?;
    if entry.method_only {
        kind = "method";
    } else if !entry.method_ancestors.is_empty() && has_ancestor_type(node, entry.method_ancestors) {
        kind = "method";
    } else if entry.method_name_types.contains(&name_node.kind()) {
        kind = "method";
    }
    let name = strip_walked_name(name_node.utf8_text(source).unwrap_or(""));
    if name.is_empty() {
        return None;
    }
    let start_line = node.start_position().row as u32 + 1;
    let end_line = node.end_position().row as u32 + 1;
    let text = node.utf8_text(source).unwrap_or("");
    let code = slice_units(text, WALKED_NODE_BODY_CAP);
    let first_line = text.split('\n').next().unwrap_or("").trim();
    let signature = slice_units(first_line, 200);
    Some(ParsedNode {
        id: format!("{file_id}:{kind}:{name}:{start_line}"),
        kind,
        name,
        signature: if signature.is_empty() { None } else { Some(signature) },
        start_line,
        end_line,
        code: Some(code),
    })
}

/// Iterative AST walk; one node per mapped tree-sitter node type, deduped by
/// id, in document order.
pub fn walk_node_tree(root: Node<'_>, mapping: &HashMap<&'static str, Entry>, source: &[u8], file_id: &str) -> Vec<ParsedNode> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if let Some(entry) = mapping.get(node.kind()) {
            if let Some(built) = build_walked_node(node, entry, source, file_id) {
                if seen.insert(built.id.clone()) {
                    out.push(built);
                }
            }
        }
        let count = node.named_child_count();
        for index in (0..count).rev() {
            if let Some(child) = node.named_child(index) {
                stack.push(child);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn walk(ext: &str, language: tree_sitter::Language, source: &str) -> Vec<ParsedNode> {
        let mut parser = Parser::new();
        parser.set_language(&language).unwrap();
        let tree = parser.parse(source, None).unwrap();
        walk_node_tree(tree.root_node(), mapping_for_ext(ext).unwrap(), source.as_bytes(), "F")
    }

    #[test]
    fn rust_walker_finds_functions_structs_and_methods() {
        let source = "pub struct Point { x: i32 }\n\npub fn add(a: i32) -> i32 { a }\n\nimpl Point {\n  pub fn draw(&self) {}\n}\n";
        let nodes = walk(".rs", tree_sitter_rust::LANGUAGE.into(), source);
        let by_name = |name: &str| nodes.iter().find(|n| n.name == name).unwrap();
        assert_eq!(by_name("Point").kind, "class");
        assert_eq!(by_name("add").kind, "function");
        assert_eq!(by_name("draw").kind, "method");
        assert_eq!(by_name("add").start_line, 3);
    }

    #[test]
    fn go_walker_distinguishes_struct_from_interface() {
        let source = "package main\n\ntype Point struct {\n  X int\n}\n\ntype Shape interface {\n  Area() int\n}\n\nfunc Area() int { return 0 }\n";
        let nodes = walk(".go", tree_sitter_go::LANGUAGE.into(), source);
        assert_eq!(nodes.iter().find(|n| n.name == "Point").unwrap().kind, "class");
        assert_eq!(nodes.iter().find(|n| n.name == "Shape").unwrap().kind, "type");
        assert_eq!(nodes.iter().find(|n| n.name == "Area").unwrap().kind, "function");
    }

    #[test]
    fn json_walker_emits_one_node_per_key() {
        let source = "{\n  \"name\": \"x\",\n  \"nested\": { \"inner\": 1 }\n}\n";
        let nodes = walk(".json", tree_sitter_json::LANGUAGE.into(), source);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"name"), "{names:?}");
        assert!(names.contains(&"inner"), "{names:?}");
        assert!(nodes.iter().all(|n| n.kind == "variable"));
    }

    #[test]
    fn yaml_walker_strips_quotes_from_keys() {
        let source = "name: x\n\"quoted\": 1\n";
        let nodes = walk(".yaml", tree_sitter_yaml::LANGUAGE.into(), source);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"name"), "{names:?}");
        assert!(names.contains(&"quoted"), "{names:?}");
    }
}
