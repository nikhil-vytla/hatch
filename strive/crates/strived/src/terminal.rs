//! Text from journals as a terminal should print it.

use std::borrow::Cow;

/// `s` with its control characters but newline and tab written out
/// (`\u{1b}`), so text a model or a proposal wrote can't move the cursor,
/// erase a line or hide what follows when printed.
pub fn visible(s: &str) -> Cow<'_, str> {
    if !s.chars().any(unsafe_char) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if unsafe_char(c) {
            out.push_str(&c.escape_unicode().to_string());
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn unsafe_char(c: char) -> bool {
    c.is_control() && c != '\n' && c != '\t'
}

#[cfg(test)]
mod tests {
    use super::visible;

    #[test]
    fn control_characters_are_written_out_and_the_rest_kept() {
        assert_eq!(visible("a\u{1b}[2K\rb\tc\nd"), "a\\u{1b}[2K\\u{d}b\tc\nd");
        assert_eq!(visible("plain — ✓"), "plain — ✓");
    }
}
