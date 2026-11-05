//! Byte-offset text helpers shared by every extractor.
//!
//! The TypeScript parsers index strings with UTF-16 code units; these helpers
//! use UTF-8 byte offsets. For ASCII source (the overwhelming majority, and
//! every case where an offset lands on a delimiter or keyword) the two agree.
//! Where they can disagree — slicing `code` in the middle of a multi-byte
//! character, or the 4000-unit body caps — the difference is documented in
//! specs/banyancode/native-indexer.md.

/// JS `\s`: ASCII whitespace plus the Unicode space separators and BOM.
pub fn is_js_ws(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\u{0b}'
            | '\u{0c}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Offsets of the first byte of every line, `[0, ...]`.
pub fn line_start_offsets(content: &str) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(content.len() / 32 + 1);
    offsets.push(0);
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            offsets.push(index + 1);
        }
    }
    offsets
}

/// `content.substring(0, offset).split("\n").length`: the number of line starts
/// at or before `offset`. A newline exactly AT `offset` is not counted.
pub fn line_at_offset(offsets: &[usize], offset: usize) -> u32 {
    let mut lo = 0usize;
    let mut hi = offsets.len().saturating_sub(1);
    let mut count = 0u32;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        if offsets[mid] <= offset {
            count = mid as u32 + 1;
            lo = mid + 1;
        } else {
            if mid == 0 {
                break;
            }
            hi = mid - 1;
        }
    }
    count
}

/// `declIndexAt`: the first non-whitespace byte at or after `match_index`.
pub fn decl_index_at(content: &str, match_index: usize) -> usize {
    let mut index = match_index.min(content.len());
    while index < content.len() {
        let ch = content[index..].chars().next().unwrap();
        if !is_js_ws(ch) {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

/// 1-based line of the declaration proper (the keyword), matching
/// tree-sitter's `startPosition.row + 1`.
pub fn decl_start_line(content: &str, offsets: &[usize], match_index: usize) -> u32 {
    line_at_offset(offsets, decl_index_at(content, match_index))
}

/// `endLineFor`: the 1-based line of the last character in `[..end_offset)`.
pub fn end_line_for(offsets: &[usize], end_offset: usize) -> u32 {
    line_at_offset(offsets, end_offset.saturating_sub(1))
}

pub fn line_count(content: &str) -> u32 {
    // `content.split("\n").length`
    content.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1
}

/// Blank out `//`, `/* */`, `"..."`, `'...'` and `` `...` `` regions with
/// spaces, preserving newlines and byte offsets.
///
/// Ported byte-for-byte from `langs/typescript.ts::stripCommentsAndStrings`;
/// the TypeScript version pushes one space per UTF-16 unit, this pushes one per
/// byte, so both preserve *their* unit length. Neither ever lands a delimiter
/// scan inside a replaced region.
pub fn strip_comments_and_strings(code: &str) -> String {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut index = 0usize;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut in_string: Option<u8> = None;

    while index < len {
        let ch = bytes[index];
        let next = if index + 1 < len { bytes[index + 1] } else { 0 };
        if line_comment {
            out.push(if ch == b'\n' { b'\n' } else { b' ' });
            if ch == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_comment {
            if ch == b'*' && next == b'/' {
                out.push(b' ');
                out.push(b' ');
                index += 2;
                block_comment = false;
                continue;
            }
            out.push(if ch == b'\n' { b'\n' } else { b' ' });
            index += 1;
            continue;
        }
        if let Some(quote) = in_string {
            if ch == b'\\' {
                out.push(b' ');
                out.push(b' ');
                index += 2;
                continue;
            }
            if ch == quote {
                out.push(b' ');
                in_string = None;
                index += 1;
                continue;
            }
            if ch == b'\n' {
                out.push(b'\n');
                in_string = None;
                index += 1;
                continue;
            }
            out.push(b' ');
            index += 1;
            continue;
        }
        if ch == b'/' && next == b'/' {
            out.push(b' ');
            out.push(b' ');
            index += 2;
            line_comment = true;
            continue;
        }
        if ch == b'/' && next == b'*' {
            out.push(b' ');
            out.push(b' ');
            index += 2;
            block_comment = true;
            continue;
        }
        if ch == b'"' || ch == b'\'' || ch == b'`' {
            out.push(b' ');
            in_string = Some(ch);
            index += 1;
            continue;
        }
        out.push(ch);
        index += 1;
    }
    // Every pushed byte came from `code` or is an ASCII space/newline, so the
    // result is valid UTF-8 by construction.
    String::from_utf8(out).unwrap_or_else(|_| code.to_string())
}

/// Slice `content[start..end]`, clamped to char boundaries.
pub fn slice(content: &str, start: usize, end: usize) -> String {
    let start = floor_boundary(content, start.min(content.len()));
    let end = floor_boundary(content, end.min(content.len()));
    if end <= start {
        return String::new();
    }
    content[start..end].to_string()
}

fn floor_boundary(content: &str, index: usize) -> usize {
    if index >= content.len() {
        return content.len();
    }
    let mut index = index;
    while index > 0 && !content.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// JS `slice(0, n)` on a string: at most `n` UTF-16 units, rounded down to a
/// char boundary.
pub fn slice_units(content: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut end = 0usize;
    for (offset, ch) in content.char_indices() {
        let width = ch.len_utf16();
        if units + width > max_units {
            break;
        }
        units += width;
        end = offset + ch.len_utf8();
    }
    content[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_offsets_match_js_split() {
        let content = "a\nbb\n\nccc";
        let offsets = line_start_offsets(content);
        assert_eq!(offsets, vec![0, 2, 5, 6]);
        assert_eq!(line_count(content), 4);
        assert_eq!(line_at_offset(&offsets, 0), 1);
        assert_eq!(line_at_offset(&offsets, 1), 1);
        assert_eq!(line_at_offset(&offsets, 2), 2);
        assert_eq!(line_at_offset(&offsets, 5), 3);
        assert_eq!(line_at_offset(&offsets, 6), 4);
    }

    #[test]
    fn decl_start_line_skips_leading_newline() {
        let content = "x\n\nexport function a() {}";
        let offsets = line_start_offsets(content);
        // Match starts at the newline before `export`.
        assert_eq!(decl_start_line(content, &offsets, 1), 3);
    }

    #[test]
    fn strip_preserves_length_and_newlines() {
        let code = "a // hi\nb /* x\ny */ c \"s\"";
        let stripped = strip_comments_and_strings(code);
        assert_eq!(stripped.len(), code.len());
        assert_eq!(stripped.matches('\n').count(), code.matches('\n').count());
        assert!(!stripped.contains("hi"));
        assert!(!stripped.contains("\"s\""));
        assert!(stripped.contains('a'));
    }

    #[test]
    fn slice_units_counts_utf16() {
        assert_eq!(slice_units("abcdef", 3), "abc");
        assert_eq!(slice_units("a😀b", 3), "a😀");
    }
}
