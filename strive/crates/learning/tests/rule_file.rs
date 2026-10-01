//! A rule's file (ADR-0025), and which files its paths match.

use strive_learning::rule_file::{matches, parse};
use strive_learning::{Rule, check, relative_path};
use strive_proto::{Artifact, Change, Evidence, Proposal};

#[test]
fn paths_are_inline_or_a_yaml_list_and_a_rule_without_them_is_for_every_session() {
    let inline =
        parse("---\ndescription: API\npaths: src/api/**, \"src/routes.ts\"\n---\nValidate input.\n", true).unwrap();
    assert_eq!(inline.paths, ["src/api/**", "src/routes.ts"]);
    assert_eq!((inline.description.as_deref(), inline.body.as_str()), (Some("API"), "Validate input."));
    let listed = parse("---\npaths:\n  - \"tests/**/*.py\"\n  - conftest.py\n---\nUse fixtures.\n", true).unwrap();
    assert_eq!(listed.paths, ["tests/**/*.py", "conftest.py"]);
    assert_eq!(parse("Prefer small functions.\n", true).unwrap().paths, Vec::<String>::new());
}

#[test]
fn strict_reading_refuses_what_strive_doesnt_read_and_paths_stay_in_the_workspace() {
    let claude = "---\npaths: src/**\nglobs: x\n---\nDo it.\n";
    assert!(parse(claude, false).is_ok());
    assert!(parse(claude, true).unwrap_err().iter().any(|p| p.contains("unknown field \"globs\"")));
    assert!(parse("---\n  - stray\n---\nDo it.\n", true).unwrap_err().iter().any(|p| p.contains("doesn't belong")));
    for bad in ["../x/**", "/etc/**"] {
        assert!(!parse(&format!("---\npaths: {bad}\n---\nDo it.\n"), false).unwrap_err().is_empty(), "{bad}");
    }
    assert!(parse("---\npaths: src/[a\n---\nDo it.\n", false).unwrap_err().iter().any(|p| p.contains("isn't a glob")));
    assert!(parse("---\npaths: src/**\n---\n\n", false).unwrap_err().iter().any(|p| p.contains("no guidance")));
}

#[test]
fn a_star_stays_in_its_component_and_two_cross_them() {
    let globs = |g: &[&str]| g.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
    assert!(matches(&globs(&["src/*.ts"]), "src/a.ts"));
    assert!(!matches(&globs(&["src/*.ts"]), "src/api/a.ts"));
    assert!(matches(&globs(&["src/**/*.ts"]), "src/api/users/a.ts"));
    assert!(matches(&globs(&["src/**/*.ts"]), "src/a.ts"));
    assert!(matches(&globs(&["src/{api,ui}/*"]), "src/ui/x"));
    assert!(!matches(&globs(&["src/{api,ui}/*"]), "src/db/x"));
    assert!(!matches(&globs(&["src/[a"]), "src/[a"), "a glob that doesn't parse matches nothing");
}

#[test]
fn a_rule_proposal_is_gated_on_its_file_as_strict_loading_reads_it() {
    assert_eq!(relative_path(&Artifact::Rule { name: "api".into() }).unwrap(), ".strive/rules/api.md");
    assert!(relative_path(&Artifact::Rule { name: "../api".into() }).is_err());
    let proposal = |content: &str| Proposal {
        change: Change::Rule { name: "api".into(), content: content.into() },
        summary: "Validate API input".into(),
        rationale: "the user corrected it twice".into(),
        evidence: vec![Evidence { session: "S".into(), seqs: vec![4], note: "corrected".into() }],
        prediction: "API changes validate their input".into(),
    };
    let rules = |c: &str| check(&proposal(c), &[], None).into_iter().map(|f| f.rule).collect::<Vec<_>>();
    assert_eq!(rules("---\npaths: src/api/**\n---\nValidate input.\n"), Vec::<Rule>::new());
    assert!(rules("---\nglobs: src/**\n---\nValidate.\n").contains(&Rule::Form));
    let sized = |n: usize| format!("Use {}.", "x".repeat(n - "Use .".len()));
    assert!(!rules(&sized(16 * 1024)).contains(&Rule::Size));
    assert!(rules(&sized(16 * 1024 + 1)).contains(&Rule::Size));
}
