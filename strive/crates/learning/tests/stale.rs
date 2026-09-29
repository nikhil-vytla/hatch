//! Memory that may be stale: the project paths a memory file names.

#[test]
fn memory_names_project_paths_only_when_they_read_unambiguously_as_paths() {
    let memory = "- Run `bun test packages/host`, not `bun test`.\n\
                  - The parser lives in `src/parse.ts`; see `docs/ADR.md:12`.\n\
                  - Config is `.github/workflows/ci.yml`, not `/etc/ci` or `~/ci/x` or `../up/x`.\n\
                  - Globs like `src/*.ts` and URLs like `https://x.dev/a` aren't paths; `src/parse.ts` again isn't new.\n";
    assert_eq!(
        strive_learning::stale::named_paths(memory),
        vec![
            (2, "src/parse.ts".to_string()),
            (2, "docs/ADR.md".to_string()),
            (3, ".github/workflows/ci.yml".to_string()),
        ]
    );
    // Only a line number after a colon is dropped: an image tag isn't a path.
    assert_eq!(strive_learning::stale::named_paths("Deploy `ghcr.io/org/app:latest`.\n"), vec![]);
}

#[test]
fn at_most_the_first_paths_limit_of_a_memory_are_checked() {
    use strive_learning::stale::{PATHS, named_paths};
    let memory = (0..PATHS + 5).map(|i| format!("- See `src/m{i}.ts`.")).collect::<Vec<_>>().join("\n");
    let found = named_paths(&memory);
    assert_eq!(found.len(), PATHS);
    assert_eq!(found.last().map(|(_, p)| p.clone()), Some(format!("src/m{}.ts", PATHS - 1)));
}
