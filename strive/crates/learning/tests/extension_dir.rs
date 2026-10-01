//! An extension's directory (ADR-0027), as the loader and the static gate read it.

use strive_learning::extension_dir::{File, canonical, parse, valid_tool_name};

fn file(path: &str, content: &str) -> File {
    File { path: path.into(), content: content.into() }
}

fn manifest(tools: &str) -> String {
    format!("{{\"name\": \"shout\", \"description\": \"Says things loudly\", \"tools\": [{tools}]}}")
}

const LOUD: &str = r#"{"name": "loud", "description": "Capitals", "parameters": {"type": "object"}}"#;

fn ext(tools: &str) -> Vec<File> {
    vec![file("extension.json", &manifest(tools)), file("index.ts", "export const tools = {};\n")]
}

fn problems(name: &str, files: &[File]) -> Vec<String> {
    parse(name, files).err().unwrap_or_default()
}

fn has(p: &[String], needle: &str) -> bool {
    p.iter().any(|p| p.contains(needle))
}

#[test]
fn an_extension_declares_its_tools_in_its_manifest() {
    let m = parse("shout", &ext(LOUD)).unwrap();
    assert_eq!((m.name.as_str(), m.tools.len(), m.tools[0].name.as_str()), ("shout", 1, "loud"));
}

#[test]
fn the_manifest_names_the_extension_and_describes_each_tool() {
    assert!(has(&problems("other", &ext(LOUD)), "names it \"shout\", not \"other\""));
    assert!(has(&problems("shout", &ext("")), "declares no tools"));
    let twice = format!("{LOUD}, {LOUD}");
    assert!(has(&problems("shout", &ext(&twice)), "declared twice"));
    let bare = r#"{"name": "loud", "description": " ", "parameters": {"type": "object"}}"#;
    assert!(has(&problems("shout", &ext(bare)), "has no description"));
    let array = r#"{"name": "loud", "description": "x", "parameters": {"type": "array"}}"#;
    assert!(has(&problems("shout", &ext(array)), "\"type\": \"object\""));
    let named = r#"{"name": "Loud", "description": "x", "parameters": {"type": "object"}}"#;
    assert!(has(&problems("shout", &ext(named)), "isn't 1 to 40"));
    let mut undescribed = ext(LOUD);
    undescribed[0] = file("extension.json", r#"{"name": "shout", "description": "", "tools": []}"#);
    assert!(has(&problems("shout", &undescribed), "gives no description"));
    let mut extra = ext(LOUD);
    extra[0] = file("extension.json", r#"{"name": "shout", "description": "x", "tools": [], "network": true}"#);
    assert!(has(&problems("shout", &extra), "doesn't read"), "an unknown field is refused");
}

#[test]
fn tool_names_are_short_lowercase_identifiers() {
    assert!(valid_tool_name("loud_2"));
    for bad in ["", "2loud", "_loud", "Loud", "lo-ud", &"x".repeat(41)] {
        assert!(!valid_tool_name(bad), "{bad:?}");
    }
    assert!(valid_tool_name(&"x".repeat(40)));
}

#[test]
fn it_needs_its_manifest_and_index_and_carries_only_its_own_source() {
    assert!(has(&problems("shout", &[file("index.ts", "")]), "no extension.json"));
    assert!(has(&problems("shout", &[file("extension.json", &manifest(LOUD))]), "no index.ts"));
    for (path, why) in [
        ("../x.ts", "must be relative"),
        ("/x.ts", "must be relative"),
        ("a//x.ts", "must be relative"),
        ("./x.ts", "must be relative"),
        (".env.ts", "hidden"),
        ("node_modules/x.ts", "dependency"),
        ("run.sh", "isn't a .ts, .json or .md"),
    ] {
        let mut files = ext(LOUD);
        files.push(file(path, "x"));
        assert!(has(&problems("shout", &files), why), "{path}: {:?}", problems("shout", &files));
    }
    let mut fine = ext(LOUD);
    fine.extend([file("lib/a.ts", "x"), file("README.md", "x"), file("data.json", "{}")]);
    assert!(parse("shout", &fine).is_ok());
}

#[test]
fn it_may_be_exactly_its_limits_but_no_more() {
    let padded = |n: usize| {
        let mut files = ext(LOUD);
        let used: usize = files.iter().map(|f| f.content.len()).sum();
        files.push(file("pad.md", &"x".repeat(n - used)));
        files
    };
    assert!(parse("shout", &padded(64 * 1024)).is_ok());
    assert!(has(&problems("shout", &padded(64 * 1024 + 1)), "the limit is 65536"));
    let many = |n: usize| {
        let mut files = ext(LOUD);
        files.extend((files.len()..n).map(|i| file(&format!("f{i}.md"), "")));
        files
    };
    assert!(parse("shout", &many(32)).is_ok());
    assert!(has(&problems("shout", &many(33)), "at most 32"));
}

#[test]
fn the_same_files_in_any_order_are_the_same_extension() {
    let a = ext(LOUD);
    let b: Vec<File> = a.iter().rev().cloned().collect();
    assert_eq!(canonical(&a), canonical(&b));
    let mut c = a.clone();
    c[1].content.push(' ');
    assert_ne!(canonical(&a), canonical(&c));
}
