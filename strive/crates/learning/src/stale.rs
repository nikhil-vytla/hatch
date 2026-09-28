//! Memory that may be stale (ADR-0019): the project paths a memory file
//! names, so the daemon can flag a line whose path no longer exists.
//!
//! Only what reads unambiguously as a path in the project counts: a
//! backticked token with a `/`, no spaces, relative, and without glob or
//! shell characters. A command (`bun test src`) has spaces and doesn't.

/// The most paths one file is checked for.
pub const PATHS: usize = 200;

/// The project paths `text` names, with the 1-based line each is on, in order,
/// each path once.
pub fn named_paths(text: &str) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = Vec::new();
    for (n, line) in (1u32..).zip(text.lines()) {
        // Backticked spans are the odd pieces between backticks.
        for token in line.split('`').skip(1).step_by(2) {
            let path = token.trim_end_matches([':', '.', ',', ';']).trim_start_matches("./");
            // `src/a.ts:12` names src/a.ts.
            let path = match path.rsplit_once(':') {
                Some((file, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => file,
                _ => path,
            };
            if out.len() < PATHS && project_path(path) && !out.iter().any(|(_, p)| p == path) {
                out.push((n, path.to_string()));
            }
        }
    }
    out
}

fn project_path(p: &str) -> bool {
    let plain = |c: char| c.is_alphanumeric() || "/._-@+".contains(c);
    (2..=200).contains(&p.len())
        && p.contains('/')
        && !p.starts_with(['/', '~', '-'])
        && !p.contains("//")
        && !p.split('/').any(|part| part == "..")
        && p.chars().all(plain)
}
