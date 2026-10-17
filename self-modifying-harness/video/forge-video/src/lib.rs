//! Forge, recorded: a real `./forge` session replayed from an asciicast and drawn as SVG, one frame at a time, with
//! the harness's own events animated around it.
//!
//! The cast is the byte stream a pseudo-terminal received while the TUI ran against a real model. `vt100` replays it
//! into a screen grid; each distinct screen becomes a keyframe at a *video* time. Video time runs at real speed while
//! someone is typing or reading, fast-forwards while the footer says the model is thinking, and holds for a few
//! seconds after each turn so the result can be read.
//!
//! Next to the terminal, `session.events.json` (taken from the forge's own chat log, see `events.py`) drives three
//! animations: the gate (each proposal lights the gate's stages in order, up to the one that decided it), the tool
//! lineage (one row per tool, a dot per proposal: filled when accepted), and a spotlight that enlarges the ASCII
//! drawings the agent-built tools returned. The top bar carries the cost and call counters read off the TUI footer;
//! the bottom bar shows the chapters (one per typed message) and every verdict.
use fframes::{AudioMap, Color, Duration, FFramesContext, Frame, Svgr, Video, include_media_dir};

include_media_dir!(pub struct ForgeVideoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

const MONO: &str = "DejaVu Sans Mono, DejaVu Sans";
const SANS: &str = "DM Sans";

// Terminal geometry: DejaVu Sans Mono advances 1233/2048 em per cell.
const ADVANCE: f32 = 1233.0 / 2048.0;
const CELL_W: f32 = 9.3;
const FONT_SIZE: f32 = CELL_W / ADVANCE;
const LINE_H: f32 = 24.0;
const PAD_X: f32 = 16.0;
const PAD_Y: f32 = 12.0;
const HEADER_H: f32 = 40.0;
const TERM_X: f32 = 40.0;
const TERM_Y: f32 = 96.0;

// The right column: the gate on top, the tool lineage under it.
const SIDE_X: f32 = 1336.0;
const SIDE_W: f32 = 544.0;
const GATE_Y: f32 = 96.0;
const GATE_H: f32 = 446.0;
const TOOLS_Y: f32 = 562.0;
const TOOLS_H: f32 = 414.0;
const BAR_Y: f32 = 1012.0;

const BG: &str = "#0b0d12";
const PANEL: &str = "#11141b";
const EDGE: &str = "#262b36";
const FG: &str = "#d7dae0";
const MUTED: &str = "#8b93a1";
const DIM: &str = "#4b5263";
const GREEN: &str = "#98c379";
const RED: &str = "#e06c75";
const AMBER: &str = "#e5c07b";

const INTRO: f64 = 6.0;
const OUTRO: f64 = 9.0;
/// Model time runs this many times faster than real time.
const THINK_SPEED: f64 = 8.0;
/// No single quiet gap lasts longer than this on screen.
const MAX_GAP: f64 = 1.2;
/// Pause after each turn ends, so its result can be read.
const HOLD: f64 = 5.0;
/// Seconds per gate stage in the gate animation.
const STEP: f64 = 0.13;
/// How long a drawing stays in the spotlight.
const SPOT: f64 = 4.6;
/// Real seconds between two spotlights, and the most a video gets.
const ART_GAP: f64 = 8.0;
const MAX_ARTS: usize = 8;

/// The gate's stages, in the order `gate.ts` runs them. Checks, property checks and invariants run together on each
/// check group; they are split here because the verdict names which one failed.
const STAGES: [(&str, &str); 8] = [
    ("fresh", "proposal is based on the live version"),
    ("coverage", "every action has a check"),
    ("migration", "state migrates on a copy"),
    ("checks", "exact checks, old and new"),
    ("properties", "rules hold on every run"),
    ("invariants", "state invariants hold"),
    ("replay", "real calls behave the same"),
    ("fuzz", "schema inputs: no hang"),
];

#[derive(Clone, PartialEq)]
struct Run {
    col: u16,
    text: String,
    fg: String,
    bg: Option<String>,
    bold: bool,
}

#[derive(Clone, PartialEq)]
struct Screen {
    rows: Vec<Vec<Run>>,
}

struct Keyframe {
    at: f64,
    screen: usize,
    thinking: bool,
    real: f64,
    calls: u32,
    cost: f32,
}

struct Chapter {
    at: f64,
    title: String,
}

struct Verdict {
    at: f64,
    ok: bool,
    cell: String,
    version: String,
    /// Index into `STAGES` of the stage that rejected it; `None` when accepted or refused by the brakes.
    stage: Option<usize>,
    refused: bool,
    detail: String,
}

struct Art {
    at: f64,
    tool: String,
    lines: Vec<String>,
}

struct Meta {
    title: String,
    subtitle: String,
    blurb: String,
    accent: String,
}

pub struct ForgeVideoVideo<'a> {
    pub media: &'a ForgeVideoMedia,
    cols: u16,
    rows: u16,
    screens: Vec<Screen>,
    keys: Vec<Keyframe>,
    chapters: Vec<Chapter>,
    verdicts: Vec<Verdict>,
    arts: Vec<Art>,
    cells: Vec<String>,
    meta: Meta,
    session_len: f64,
}

impl std::fmt::Debug for ForgeVideoVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeVideoVideo").field("screens", &self.screens.len()).field("session_len", &self.session_len).finish()
    }
}

fn palette(i: u8) -> String {
    const BASE: [&str; 16] = [
        "#1d2027", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dae0",
        "#5c6370", "#ff7a85", "#b5e890", "#ffd88a", "#7cc4ff", "#de95f0", "#6fd3e0", "#ffffff",
    ];

    match i {
        0..=15 => BASE[i as usize].to_string(),
        16..=231 => {
            let n = i - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };

            format!("#{:02x}{:02x}{:02x}", level(n / 36), level((n / 6) % 6), level(n % 6))
        }
        _ => {
            let v = 8 + (i - 232) * 10;

            format!("#{v:02x}{v:02x}{v:02x}")
        }
    }
}

fn color(c: vt100::Color) -> Option<String> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(palette(i)),
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

/// Mix two `#rrggbb` colors; `t` is the share of `a`.
fn mix(a: &str, b: &str, t: f32) -> String {
    let p = |s: &str, i: usize| u8::from_str_radix(&s[1 + i * 2..3 + i * 2], 16).unwrap_or(0) as f32;
    let ch = |i: usize| (p(a, i) * t + p(b, i) * (1.0 - t)).round() as u8;

    format!("#{:02x}{:02x}{:02x}", ch(0), ch(1), ch(2))
}

fn clamp01(x: f64) -> f32 {
    x.clamp(0.0, 1.0) as f32
}

/// Ease-out over `[a, a + d]`.
fn ease(t: f64, a: f64, d: f64) -> f32 {
    let x = clamp01((t - a) / d);

    1.0 - (1.0 - x) * (1.0 - x) * (1.0 - x)
}

/// A spring-like pop from 0 to 1 that overshoots a little, over `[a, a + d]`.
fn pop(t: f64, a: f64, d: f64) -> f32 {
    let x = (t - a) / d;

    if x <= 0.0 {
        return 0.0;
    }

    if x >= 1.0 {
        return 1.0;
    }

    (1.0 - (-6.0 * x).exp() * (9.0 * x).cos()) as f32
}

fn push_run(runs: &mut Vec<Run>, current: &mut Option<Run>) {
    if let Some(mut run) = current.take() {
        run.text = run.text.trim_end().to_string();

        if !run.text.is_empty() || run.bg.is_some() {
            runs.push(run);
        }
    }
}

/// The visible screen as runs of same-styled text, with long gaps of spaces dropped (SVG collapses them anyway).
fn snapshot(screen: &vt100::Screen, rows: u16, cols: u16) -> Screen {
    let mut out = Vec::with_capacity(rows as usize);

    for r in 0..rows {
        let mut runs: Vec<Run> = Vec::new();
        let mut current: Option<Run> = None;
        let mut spaces = 0usize;

        for c in 0..cols {
            let Some(cell) = screen.cell(r, c) else { continue };

            if cell.is_wide_continuation() {
                continue;
            }

            let (mut fg, mut bg) = (color(cell.fgcolor()).unwrap_or_else(|| FG.to_string()), color(cell.bgcolor()));

            if cell.inverse() {
                let old = fg;
                fg = bg.unwrap_or_else(|| PANEL.to_string());
                bg = Some(old);
            }

            if cell.dim() {
                fg = mix(&fg, PANEL, 0.55);
            }

            let text = if cell.has_contents() { cell.contents().to_string() } else { " ".to_string() };
            let blank = text == " " && bg.is_none();

            // DejaVu Sans Mono has no Braille (the TUI's spinner), and a run with one missing glyph falls back whole to a
            // proportional font, so a Braille cell gets a run of its own.
            if text.chars().any(|ch| ('\u{2800}'..='\u{28FF}').contains(&ch)) {
                push_run(&mut runs, &mut current);
                runs.push(Run { col: c, text, fg, bg, bold: cell.bold() });
                spaces = 0;

                continue;
            }

            if blank {
                spaces += 1;

                if spaces >= 2 {
                    push_run(&mut runs, &mut current);
                }

                if let Some(run) = current.as_mut() {
                    run.text.push(' ');
                }

                continue;
            }

            spaces = 0;

            let same = current.as_ref().is_some_and(|run| run.fg == fg && run.bg == bg && run.bold == cell.bold() && !cell.is_wide());

            if same {
                if let Some(run) = current.as_mut() {
                    run.text.push_str(&text);
                }
            } else {
                push_run(&mut runs, &mut current);
                current = Some(Run { col: c, text, fg, bg, bold: cell.bold() });
            }
        }

        push_run(&mut runs, &mut current);
        out.push(runs);
    }

    Screen { rows: out }
}

/// The footer is the last row; while the model works it carries the spinner and "thinking...".
fn is_thinking(footer: &str) -> bool {
    footer.chars().take(40).collect::<String>().contains("thinking")
}

/// `... | 156/1000 calls $0.1498/$2.00 | ...` in the footer, as (calls, dollars).
fn counters(footer: &str) -> Option<(u32, f32)> {
    let at = footer.find(" calls $")?;
    let calls = footer[..at].rsplit(' ').next()?.split('/').next()?.parse().ok()?;
    let cost = footer[at + 8..].split('/').next()?.parse().ok()?;

    Some((calls, cost))
}

/// Real seconds to video seconds, by linear interpolation between the replay's recorded pairs.
fn to_video(pairs: &[(f64, f64)], real: f64) -> f64 {
    match pairs.iter().position(|&(r, _)| r >= real) {
        Some(0) | None if pairs.is_empty() => 0.0,
        Some(0) => pairs[0].1,
        Some(i) => {
            let (r0, v0) = pairs[i - 1];
            let (r1, v1) = pairs[i];

            if r1 - r0 < 1e-9 { v1 } else { v0 + (v1 - v0) * (real - r0) / (r1 - r0) }
        }
        None => pairs.last().map_or(0.0, |p| p.1),
    }
}

/// Greedy word wrap to `width` characters, at most `max` lines (the last one cut with an ellipsis).
fn wrap(text: &str, width: usize, max: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();

    for word in text.split_whitespace() {
        let word: String = word.chars().take(width).collect();

        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut line));
        }

        if !line.is_empty() {
            line.push(' ');
        }

        line.push_str(&word);
    }

    if !line.is_empty() {
        lines.push(line);
    }

    if lines.len() > max {
        lines.truncate(max);

        let last = &mut lines[max - 1];
        let keep: String = last.chars().take(width.saturating_sub(1)).collect();
        *last = keep + "…";
    }

    lines
}

fn read_json(path: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn stage_index(name: &str) -> Option<usize> {
    let name = if name == "stale" { "fresh" } else { name };

    STAGES.iter().position(|(n, _)| *n == name)
}

/// The color a character of an agent-drawn picture is shown in.
fn art_class(ch: char) -> &'static str {
    match ch {
        '#' | '█' | '■' => "wall",
        '.' | '·' | ':' => "dim",
        '@' | '*' | 'O' | 'o' => "hero",
        '^' | '!' | 'X' | 'x' => "alert",
        '▁'..='▇' => "bar",
        '=' | '-' | '|' | '+' => "line",
        _ => "text",
    }
}

/// A tool name cut to fit its column in the lineage card.
fn short(name: &str) -> String {
    if name.chars().count() <= 12 { name.to_string() } else { name.chars().take(11).collect::<String>() + "…" }
}

/// A drawing without its empty margins (a fogged map is mostly blank), so what was drawn fills the spotlight.
fn crop(lines: Vec<String>) -> Vec<String> {
    let drawn = |l: &String| !l.trim().is_empty();
    let (Some(top), Some(bottom)) = (lines.iter().position(drawn), lines.iter().rposition(drawn)) else { return lines };
    let indent = lines[top..=bottom].iter().filter(|l| drawn(l)).map(|l| l.chars().take_while(|c| *c == ' ').count()).min().unwrap_or(0);

    lines[top..=bottom].iter().map(|l| l.chars().skip(indent).collect::<String>().trim_end().to_string()).collect()
}

/// The drawings worth a spotlight, at their real times: each new picture once (not one already shown), at least
/// `ART_GAP` real seconds after the last one, at most `MAX_ARTS` in all, and never an empty canvas (all background).
fn pick_arts(events: &[serde_json::Value]) -> Vec<Art> {
    let mut out: Vec<Art> = Vec::new();

    for e in events.iter().filter(|e| e["kind"] == "art") {
        let at = e["t"].as_f64().unwrap_or(0.0);
        let lines = crop(e["lines"].as_array().map(|l| l.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default());

        let blank = lines.iter().flat_map(|l| l.chars()).all(|c| c == ' ' || art_class(c) == "dim");

        if blank || out.len() >= MAX_ARTS || out.iter().any(|a| a.lines == lines) || out.last().is_some_and(|a| at - a.at < ART_GAP) {
            continue;
        }

        out.push(Art { at, tool: e["tool"].as_str().unwrap_or("").to_string(), lines });
    }

    out
}

impl<'a> ForgeVideoVideo<'a> {
    pub fn new(media: &'a ForgeVideoMedia, cast_path: &str) -> Self {
        let cast = std::fs::read_to_string(cast_path).expect("cast");
        let mut lines = cast.lines();
        let head: serde_json::Value = serde_json::from_str(lines.next().expect("cast header")).expect("cast header");
        let cols = head["width"].as_u64().unwrap_or(132) as u16;
        let rows = head["height"].as_u64().unwrap_or(34) as u16;

        let stem = cast_path.trim_end_matches(".cast").to_string();
        let events = read_json(&format!("{stem}.events.json")).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let mut pending = pick_arts(&events);
        let mut arts: Vec<Art> = Vec::new();

        let mut parser = vt100::Parser::new(rows, cols, 0);
        let mut screens: Vec<Screen> = Vec::new();
        let mut keys: Vec<Keyframe> = Vec::new();
        let mut pairs: Vec<(f64, f64)> = Vec::new();
        let (mut video, mut last_real, mut started, mut was_thinking) = (0.0f64, 0.0f64, false, false);
        let (mut calls, mut cost) = (0u32, 0.0f32);

        for line in lines {
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let real = ev[0].as_f64().unwrap_or(last_real);
            let data = ev[2].as_str().unwrap_or("");

            parser.process(data.as_bytes());

            let screen = parser.screen();

            // Only the full-screen app is filmed: before it starts and after it exits is shell output.
            if !started {
                if screen.alternate_screen() {
                    started = true;
                    last_real = real;
                } else {
                    continue;
                }
            } else if !screen.alternate_screen() {
                break;
            }

            let factor = if was_thinking { 1.0 / THINK_SPEED } else { 1.0 };
            video += ((real - last_real) * factor).min(MAX_GAP);
            last_real = real;

            let footer = screen.contents_between(rows - 1, 0, rows - 1, cols);
            let thinking = is_thinking(&footer);

            if let Some((n, c)) = counters(&footer) {
                (calls, cost) = (n, c);
            }

            let snap = snapshot(screen, rows, cols);

            if screens.last() != Some(&snap) {
                screens.push(snap);
                keys.push(Keyframe { at: video, screen: screens.len() - 1, thinking, real, calls, cost });
            } else if let Some(k) = keys.last_mut() {
                k.thinking = thinking;
            }

            pairs.push((real, video));

            // A drawing gets the screen to itself for a while: the replay pauses under the spotlight.
            while pending.first().is_some_and(|a| a.at <= real) {
                let mut art = pending.remove(0);

                art.at = video;
                arts.push(art);
                video += SPOT;
                pairs.push((real + 1e-6, video));
            }

            if was_thinking && !thinking {
                video += HOLD;
                pairs.push((real + 1e-6, video));
            }

            was_thinking = thinking;
        }

        let session_len = video + 1.5;

        // Chapters: the driver's markers, named "title" at a real time, written next to the cast.
        let chapters = read_json(&format!("{stem}.snaps.json"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| {
                let title = v[0].as_str()?.to_string();
                let real = v[2].as_f64()?;

                (title != "end").then(|| Chapter { at: to_video(&pairs, real), title })
            })
            .collect();

        let str_of = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        let mut verdicts = Vec::new();

        for e in &events {
            let at = to_video(&pairs, e["t"].as_f64().unwrap_or(0.0));

            match e["kind"].as_str() {
                Some("verdict") => {
                    let stage = str_of(e, "stage");

                    verdicts.push(Verdict {
                        at,
                        ok: e["ok"].as_bool().unwrap_or(false),
                        cell: str_of(e, "cell"),
                        version: str_of(e, "version"),
                        stage: stage_index(&stage),
                        refused: stage == "repeat",
                        detail: str_of(e, "detail"),
                    });
                }
                _ => {}
            }
        }

        let mut cells: Vec<String> = Vec::new();

        for v in &verdicts {
            if v.cell != "?" && !v.cell.is_empty() && !cells.contains(&v.cell) {
                cells.push(v.cell.clone());
            }
        }

        let meta_json = read_json(&format!("{stem}.meta.json")).unwrap_or_default();
        let meta = Meta {
            title: str_of(&meta_json, "title"),
            subtitle: str_of(&meta_json, "subtitle"),
            blurb: str_of(&meta_json, "blurb"),
            accent: Some(str_of(&meta_json, "accent")).filter(|a| a.len() == 7).unwrap_or_else(|| AMBER.to_string()),
        };

        Self { media, cols, rows, screens, keys, chapters, verdicts, arts, cells, meta, session_len }
    }

    fn key_at(&self, t: f64) -> Option<&Keyframe> {
        let i = self.keys.partition_point(|k| k.at <= t);

        if i == 0 { self.keys.first() } else { self.keys.get(i - 1) }
    }

    fn chapter_at(&self, t: f64) -> Option<(usize, &Chapter)> {
        let i = self.chapters.partition_point(|c| c.at <= t);

        if i == 0 { None } else { Some((i - 1, &self.chapters[i - 1])) }
    }

    fn messages(&self) -> Vec<&Chapter> {
        self.chapters.iter().filter(|c| c.title != "Done" && !c.title.starts_with("Starting")).collect()
    }

    fn term_size(&self) -> (f32, f32) {
        (self.cols as f32 * CELL_W + 2.0 * PAD_X, self.rows as f32 * LINE_H + 2.0 * PAD_Y + HEADER_H)
    }

    fn screen_svgr<'b>(&'b self, screen: &'b Screen, x0: f32, y0: f32) -> Svgr<'b> {
        screen
            .rows
            .iter()
            .enumerate()
            .flat_map(|(r, runs)| runs.iter().map(move |run| (r, run)))
            .map(|(r, run)| {
                let x = x0 + run.col as f32 * CELL_W;
                let y = y0 + r as f32 * LINE_H;
                let w = run.text.chars().count() as f32 * CELL_W;
                let weight = if run.bold { "bold" } else { "normal" };
                let bg = run.bg.as_deref().map(|bg| fframes::svgr!(<rect x={x} y={y} width={w.max(CELL_W)} height={LINE_H} fill={bg} />));

                fframes::svgr!(
                    <g>
                        {bg.unwrap_or_default()}
                        <text x={x} y={y + LINE_H * 0.74} font-family={MONO} font-size={FONT_SIZE} font-weight={weight} fill={run.fg.as_str()}>{run.text.as_str()}</text>
                    </g>
                )
            })
            .collect()
    }

    fn card<'b>(&'b self, x: f32, y: f32, w: f32, h: f32, title: &'b str, note: String) -> Svgr<'b> {
        fframes::svgr!(
            <g>
                <rect x={x + 5.0} y={y + 8.0} width={w} height={h} rx="14" fill="#000000" opacity="0.35" />
                <rect x={x} y={y} width={w} height={h} rx="14" fill={PANEL} stroke={EDGE} stroke-width="1.5" />
                <text x={x + 22.0} y={y + 34.0} font-family={SANS} font-size={17} font-weight="bold" fill={MUTED} letter-spacing="3">{title}</text>
                <text x={x + w - 22.0} y={y + 34.0} font-family={MONO} font-size={16} fill={MUTED} text-anchor="end">{note}</text>
                <rect x={x} y={y + 50.0} width={w} height="1" fill={EDGE} />
            </g>
        )
    }

    // ---- the gate ----

    fn gate<'b>(&'b self, t: f64) -> Svgr<'b> {
        let current = self.verdicts.iter().rev().find(|v| v.at <= t);
        let seen = self.verdicts.iter().filter(|v| v.at <= t).count();
        let note = current.map(|v| if v.cell == "?" { "brakes".to_string() } else { format!("{}@{}", v.cell, &v.version[..v.version.len().min(8)]) }).unwrap_or_default();
        let head = self.card(SIDE_X, GATE_Y, SIDE_W, GATE_H, "GATE", note);
        let (x, top) = (SIDE_X + 30.0, GATE_Y + 78.0);
        let row_h = 27.0;

        // Stages light up one after another; the one that decided turns red.
        let lit = |i: usize| -> (f32, &'static str) {
            let Some(v) = current else { return (0.0, DIM) };

            if v.refused {
                return (0.0, DIM);
            }

            let fail = if v.ok { STAGES.len() } else { v.stage.unwrap_or(3) };
            let at = v.at + i as f64 * STEP;

            if i < fail {
                (ease(t, at, 0.18), GREEN)
            } else if i == fail {
                (ease(t, at, 0.18), RED)
            } else {
                (0.0, DIM)
            }
        };

        let spine_len = current.filter(|v| !v.refused).map_or(0.0, |v| {
            let last = if v.ok { STAGES.len() - 1 } else { v.stage.unwrap_or(3) };

            ((t - v.at) / STEP).clamp(0.0, last as f64) as f32 * row_h
        });

        let stages: Svgr = STAGES
            .iter()
            .enumerate()
            .map(|(i, (name, what))| {
                let (on, hue) = lit(i);
                let y = top + i as f32 * row_h;
                let fill = mix(hue, PANEL, 0.25 + 0.75 * on);
                let text = mix(FG, DIM, on.max(0.35));
                let r = 6.0 + 3.0 * on * (1.0 - ease(t, current.map_or(0.0, |v| v.at + i as f64 * STEP + 0.18), 0.4));

                fframes::svgr!(
                    <g>
                        <circle cx={x} cy={y} r={r} fill={fill} />
                        <text x={x + 22.0} y={y + 6.0} font-family={MONO} font-size={17} fill={text}>{*name}</text>
                        <text x={x + 150.0} y={y + 6.0} font-family={SANS} font-size={16} fill={DIM}>{*what}</text>
                    </g>
                )
            })
            .collect();

        let stamp = current.map(|v| {
            let decided = v.at + if v.refused { 0.0 } else if v.ok { STAGES.len() as f64 * STEP } else { (v.stage.unwrap_or(3) + 1) as f64 * STEP };
            let s = pop(t, decided, 0.6);
            let (label, hue) = if v.refused { ("REFUSED", AMBER) } else if v.ok { ("ACCEPTED", GREEN) } else { ("REJECTED", RED) };
            let (cx, cy) = (SIDE_X + SIDE_W / 2.0, top + 7.0 * row_h + 56.0);
            let transform = format!("translate({cx},{cy}) rotate(-7) scale({})", 0.6 + 0.4 * s);
            let lines = wrap(&v.detail, 58, 3);
            let shown = ease(t, decided, 0.5);
            let detail: Svgr = lines
                .into_iter()
                .enumerate()
                .map(|(i, l)| fframes::svgr!(<text x={SIDE_X + 22.0} y={GATE_Y + GATE_H - 66.0 + i as f32 * 20.0} font-family={MONO} font-size={14} fill={MUTED} opacity={shown}>{l}</text>))
                .collect();

            fframes::svgr!(
                <g>
                    <g transform={transform} opacity={s.min(1.0)}>
                        <rect x="-98" y="-24" width="196" height="48" rx="6" fill="none" stroke={hue} stroke-width="3" />
                        <text x="0" y="10" font-family={MONO} font-size={28} font-weight="bold" fill={hue} text-anchor="middle">{label}</text>
                    </g>
                    {detail}
                </g>
            )
        });

        fframes::svgr!(
            <g>
                {head}
                <rect x={x - 1.5} y={top} width="3" height={(STAGES.len() - 1) as f32 * row_h} fill={EDGE} />
                <rect x={x - 1.5} y={top} width="3" height={spine_len} fill={GREEN} opacity="0.6" />
                {stages}
                {stamp.unwrap_or_default()}
                <text x={SIDE_X + 22.0} y={top + 7.0 * row_h + 62.0} font-family={SANS} font-size={15} fill={DIM}>{format!("{seen} judged")}</text>
            </g>
        )
    }

    // ---- the tool lineage ----

    fn tools<'b>(&'b self, t: f64) -> Svgr<'b> {
        let visible: Vec<&String> = self.cells.iter().filter(|c| self.verdicts.iter().any(|v| &v.cell == *c && v.at <= t)).collect();
        let accepted = self.verdicts.iter().filter(|v| v.ok && v.at <= t).count();
        let rejected = self.verdicts.iter().filter(|v| !v.ok && v.at <= t).count();
        let head = self.card(SIDE_X, TOOLS_Y, SIDE_W, TOOLS_H, "TOOLS IT GREW", format!("{accepted} in · {rejected} out"));
        let (x0, y0, row_h) = (SIDE_X + 22.0, TOOLS_Y + 92.0, 44.0);
        let max_rows = ((TOOLS_H - 120.0) / row_h) as usize;
        let shown = &visible[visible.len().saturating_sub(max_rows)..];

        let rows: Svgr = shown
            .iter()
            .enumerate()
            .map(|(r, cell)| {
                let y = y0 + r as f32 * row_h;
                let mine: Vec<&Verdict> = self.verdicts.iter().filter(|v| &v.cell == *cell && v.at <= t).collect();
                let first = mine.first().map_or(t, |v| v.at);
                let enter = ease(t, first, 0.5);
                let live = mine.iter().filter(|v| v.ok).count();
                let label_color = if live > 0 { FG } else { MUTED };
                let tag = if live > 0 { format!("v{live}") } else { "not yet".to_string() };
                let dots_x = x0 + 222.0;
                let gap = 15.0;
                let fit = ((SIDE_W - 222.0 - 44.0) / gap) as usize;
                let dots = &mine[mine.len().saturating_sub(fit)..];
                let lineage: Vec<f32> = dots.iter().enumerate().filter(|(_, v)| v.ok).map(|(i, _)| dots_x + i as f32 * gap).collect();
                let line = match (lineage.first(), lineage.last()) {
                    (Some(&a), Some(&b)) if b > a => fframes::svgr!(<rect x={a} y={y - 1.5} width={b - a} height="3" fill={GREEN} opacity="0.5" />),
                    _ => Svgr::default(),
                };
                let marks: Svgr = dots
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let s = pop(t, v.at, 0.5);
                        let cx = dots_x + i as f32 * gap;

                        if v.ok {
                            let ring = 1.0 - ease(t, v.at, 1.2);

                            fframes::svgr!(
                                <g>
                                    <circle cx={cx} cy={y} r={7.0 + 16.0 * (1.0 - ring)} fill="none" stroke={GREEN} stroke-width="2" opacity={ring} />
                                    <circle cx={cx} cy={y} r={7.0 * s} fill={GREEN} />
                                </g>
                            )
                        } else {
                            let hue = if v.refused { AMBER } else { RED };

                            fframes::svgr!(<circle cx={cx} cy={y} r={4.0 * s} fill="none" stroke={hue} stroke-width="2" />)
                        }
                    })
                    .collect();

                fframes::svgr!(
                    <g opacity={enter} transform={format!("translate({},0)", (1.0 - enter) * 30.0)}>
                        <text x={x0} y={y + 6.0} font-family={MONO} font-size={17} font-weight="bold" fill={label_color}>{short(cell)}</text>
                        <text x={x0 + 202.0} y={y + 6.0} font-family={MONO} font-size={14} fill={if live > 0 { GREEN } else { DIM }} text-anchor="end">{tag}</text>
                        {line}
                        {marks}
                    </g>
                )
            })
            .collect();

        let legend = fframes::svgr!(
            <g>
                <circle cx={x0 + 6.0} cy={TOOLS_Y + TOOLS_H - 22.0} r="6" fill={GREEN} />
                <text x={x0 + 20.0} y={TOOLS_Y + TOOLS_H - 17.0} font-family={SANS} font-size={14} fill={DIM}>"accepted version"</text>
                <circle cx={x0 + 170.0} cy={TOOLS_Y + TOOLS_H - 22.0} r="4" fill="none" stroke={RED} stroke-width="2" />
                <text x={x0 + 182.0} y={TOOLS_Y + TOOLS_H - 17.0} font-family={SANS} font-size={14} fill={DIM}>"rejected by the gate"</text>
                <circle cx={x0 + 360.0} cy={TOOLS_Y + TOOLS_H - 22.0} r="4" fill="none" stroke={AMBER} stroke-width="2" />
                <text x={x0 + 372.0} y={TOOLS_Y + TOOLS_H - 17.0} font-family={SANS} font-size={14} fill={DIM}>"brakes"</text>
            </g>
        );

        let empty = visible.is_empty().then(|| {
            fframes::svgr!(<text x={SIDE_X + SIDE_W / 2.0} y={TOOLS_Y + TOOLS_H / 2.0} font-family={SANS} font-size={18} fill={DIM} text-anchor="middle">"no tools yet: it starts empty"</text>)
        });

        fframes::svgr!(
            <g>
                {head}
                {rows}
                {empty.unwrap_or_default()}
                {legend}
            </g>
        )
    }

    // ---- the spotlight ----

    fn spotlight<'b>(&'b self, t: f64) -> Svgr<'b> {
        let Some(art) = self.arts.iter().rev().find(|a| a.at <= t && t < a.at + SPOT) else { return Svgr::default() };
        let (tw, th) = self.term_size();
        let longest = art.lines.iter().map(|l| l.chars().count()).max().unwrap_or(1).max(12) as f32;
        let count = art.lines.len().max(1) as f32;
        // As big as fits in the terminal panel, capped so small drawings do not turn into posters.
        let font = (((tw - 160.0) / longest) / ADVANCE).min((th - 200.0) / count / 1.15).min(40.0);
        let (cw, lh) = (font * ADVANCE, font * 1.15);
        let (w, h) = ((longest * cw + 64.0).max(520.0), count * lh + 96.0);
        let (x, y) = (TERM_X + (tw - w) / 2.0, TERM_Y + (th - h) / 2.0);
        let open = ease(t, art.at, 0.35) * (1.0 - ease(t, art.at + SPOT - 0.4, 0.4));
        let scale = 0.92 + 0.08 * open;
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        let accent = self.meta.accent.as_str();

        let body: Svgr = art
            .lines
            .iter()
            .enumerate()
            .map(|(r, line)| {
                let reveal = ease(t, art.at + 0.25 + r as f64 * (1.4 / count as f64), 0.25);
                let mut runs: Vec<(usize, &'static str, String)> = Vec::new();

                for (c, ch) in line.chars().enumerate() {
                    if ch == ' ' {
                        continue;
                    }

                    let class = art_class(ch);

                    match runs.last_mut() {
                        Some((start, k, text)) if *k == class && *start + text.chars().count() == c => text.push(ch),
                        _ => runs.push((c, class, ch.to_string())),
                    }
                }

                runs.into_iter()
                    .map(|(c, class, text)| {
                        let fill = match class {
                            "wall" => "#7f8aa3",
                            "dim" => "#3e4554",
                            "hero" => accent,
                            "alert" => RED,
                            "bar" => GREEN,
                            "line" => MUTED,
                            _ => FG,
                        };
                        let weight = if class == "hero" || class == "alert" { "bold" } else { "normal" };

                        fframes::svgr!(<text x={x + (w - longest * cw) / 2.0 + c as f32 * cw} y={y + 72.0 + r as f32 * lh + font * 0.8} font-family={MONO} font-size={font} font-weight={weight} fill={fill} opacity={reveal}>{text}</text>)
                    })
                    .collect::<Svgr>()
            })
            .collect();

        fframes::svgr!(
            <g opacity={open} transform={format!("translate({cx},{cy}) scale({scale}) translate({},{})", -cx, -cy)}>
                <rect x={TERM_X} y={TERM_Y} width={tw} height={th} rx="14" fill={BG} opacity="0.72" />
                <rect x={x + 6.0} y={y + 10.0} width={w} height={h} rx="16" fill="#000000" opacity="0.45" />
                <rect x={x} y={y} width={w} height={h} rx="16" fill="#0d1017" stroke={accent} stroke-width="2" />
                <text x={x + 32.0} y={y + 42.0} font-family={SANS} font-size={18} fill={accent} letter-spacing="2">{format!("DRAWN BY ITS OWN TOOL  ·  {}", art.tool)}</text>
                {body}
            </g>
        )
    }

    // ---- frame chrome ----

    fn top_bar<'b>(&'b self, t: f64) -> Svgr<'b> {
        let key = self.key_at(t);
        let (calls, cost) = key.map_or((0, 0.0), |k| (k.calls, k.cost));
        let budget = 2.0f32;
        let messages = self.messages();
        let chapter = match self.chapter_at(t) {
            Some((_, c)) if c.title != "Done" && !c.title.starts_with("Starting") => {
                let n = messages.iter().position(|m| std::ptr::eq(*m, c)).map_or(0, |i| i + 1);
                format!("message {n} of {}  ·  {}", messages.len(), c.title)
            }
            Some((_, c)) => c.title.clone(),
            None => String::new(),
        };
        let fill = (cost / budget).clamp(0.0, 1.0) * 220.0;

        fframes::svgr!(
            <g>
                <text x={TERM_X} y={58.0} font-family={MONO} font-size={30} font-weight="bold" fill={FG}>"./forge"</text>
                <text x={TERM_X + 150.0} y={58.0} font-family={SANS} font-size={28} fill={self.meta.accent.as_str()}>{self.meta.title.as_str()}</text>
                <text x={TERM_X + 1260.0} y={58.0} font-family={SANS} font-size={22} fill={FG} text-anchor="end">{chapter}</text>
                <text x={SIDE_X} y={44.0} font-family={MONO} font-size={22} font-weight="bold" fill={FG}>{format!("${cost:.3}")}</text>
                <text x={SIDE_X + 110.0} y={44.0} font-family={SANS} font-size={17} fill={MUTED}>{format!("of ${budget:.2} cap  ·  {calls} model calls")}</text>
                <rect x={SIDE_X} y={58.0} width="220" height="6" rx="3" fill={EDGE} />
                <rect x={SIDE_X} y={58.0} width={fill} height="6" rx="3" fill={self.meta.accent.as_str()} />
            </g>
        )
    }

    fn progress<'b>(&'b self, t: f64) -> Svgr<'b> {
        let (x0, w) = (TERM_X, SIDE_X + SIDE_W - TERM_X);
        let at = |v: f64| x0 + (v / self.session_len).clamp(0.0, 1.0) as f32 * w;
        let messages = self.messages();
        let marks: Svgr = messages
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let x = at(c.at);
                let active = self.chapter_at(t).is_some_and(|(_, cur)| std::ptr::eq(cur, *c));
                let color = if active { FG } else { MUTED };

                fframes::svgr!(
                    <g>
                        <rect x={x} y={BAR_Y - 6.0} width="2" height="20" fill={MUTED} />
                        <text x={x + 8.0} y={BAR_Y + 40.0} font-family={SANS} font-size={17} fill={color}>{format!("{} {}", i + 1, c.title)}</text>
                    </g>
                )
            })
            .collect();
        let ticks: Svgr = self
            .verdicts
            .iter()
            .filter(|v| v.at <= t)
            .map(|v| {
                let hue = if v.ok { GREEN } else if v.refused { AMBER } else { RED };
                let h = if v.ok { 16.0 } else { 9.0 };

                fframes::svgr!(<rect x={at(v.at) - 1.0} y={BAR_Y - 4.0 - h} width="2.5" height={h} fill={hue} />)
            })
            .collect();

        fframes::svgr!(
            <g>
                <rect x={x0} y={BAR_Y} width={w} height="8" rx="4" fill={EDGE} />
                <rect x={x0} y={BAR_Y} width={(at(t) - x0).max(0.0)} height="8" rx="4" fill={self.meta.accent.as_str()} />
                {ticks}
                {marks}
            </g>
        )
    }

    fn intro<'b>(&'b self, t: f64) -> Svgr<'b> {
        let fade = ease(t, 0.2, 0.8) * (1.0 - ease(t, INTRO - 0.6, 0.6));
        let rise = (1.0 - pop(t, 0.2, 1.0)) * 50.0;
        let sub = ease(t, 0.9, 0.8);
        let (cx, cy) = (WIDTH as f32 / 2.0, HEIGHT as f32 / 2.0 - 80.0);
        let messages = self.messages();
        let n = messages.len().max(1) as f32;
        let span = 300.0;
        let list: Svgr = messages
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let x = cx - (n - 1.0) * span / 2.0 + i as f32 * span;
                let s = pop(t, 1.6 + i as f64 * 0.3, 0.7);

                fframes::svgr!(
                    <g opacity={s.min(1.0)} transform={format!("translate({x},{}) scale({})", cy + 230.0, 0.7 + 0.3 * s)}>
                        <circle cx="0" cy="0" r="26" fill="none" stroke={self.meta.accent.as_str()} stroke-width="2.5" />
                        <text x="0" y="9" font-family={MONO} font-size={26} font-weight="bold" fill={FG} text-anchor="middle">{format!("{}", i + 1)}</text>
                        <text x="0" y="66" font-family={SANS} font-size={26} fill={MUTED} text-anchor="middle">{c.title.as_str()}</text>
                    </g>
                )
            })
            .collect();
        let path: Svgr = (n > 1.0)
            .then(|| {
                let x = cx - (n - 1.0) * span / 2.0;
                let grow = ease(t, 1.6, 0.3 * n as f64 + 0.4);

                fframes::svgr!(<rect x={x} y={cy + 229.0} width={(n - 1.0) * span * grow} height="2" fill={EDGE} />)
            })
            .unwrap_or_default();

        fframes::svgr!(
            <g opacity={fade} transform={format!("translate(0,{rise})")}>
                <text x={cx} y={cy - 120.0} font-family={MONO} font-size={44} font-weight="bold" fill={MUTED} text-anchor="middle">"./forge"</text>
                <text x={cx} y={cy - 20.0} font-family={SANS} font-size={96} font-weight="bold" fill={FG} text-anchor="middle">{self.meta.title.as_str()}</text>
                <text x={cx} y={cy + 50.0} font-family={SANS} font-size={36} fill={self.meta.accent.as_str()} text-anchor="middle" opacity={sub}>{self.meta.subtitle.as_str()}</text>
                <text x={cx} y={cy + 110.0} font-family={SANS} font-size={26} fill={MUTED} text-anchor="middle" opacity={sub}>{self.meta.blurb.as_str()}</text>
                {path}
                {list}
                <text x={cx} y={HEIGHT as f32 - 70.0} font-family={SANS} font-size={22} fill={DIM} text-anchor="middle" opacity={sub}>{format!("Recorded live on deepseek-flash, no tools at the start. Model time fast-forwarded {}×.", THINK_SPEED as u32)}</text>
            </g>
        )
    }

    fn outro<'b>(&'b self, t: f64) -> Svgr<'b> {
        let fade = ease(t, 0.0, 0.8);
        let last = self.keys.last();
        let calls = last.map_or(0, |k| k.calls) as f64;
        let cost = last.map_or(0.0, |k| k.cost) as f64;
        let real = last.map_or(0.0, |k| k.real);
        let accepted = self.verdicts.iter().filter(|v| v.ok).count() as f64;
        let rejected = self.verdicts.iter().filter(|v| !v.ok).count() as f64;
        let grown = self.cells.iter().filter(|c| self.verdicts.iter().any(|v| &v.cell == *c && v.ok)).count() as f64;
        let count = |i: usize| ease(t, 0.6 + i as f64 * 0.15, 1.6) as f64;
        let stats: Vec<(&str, String)> = vec![
            ("tools grown", format!("{:.0}", grown * count(0))),
            ("versions accepted", format!("{:.0}", accepted * count(1))),
            ("proposals rejected", format!("{:.0}", rejected * count(2))),
            ("model calls", format!("{:.0}", calls * count(3))),
            ("cost", format!("${:.2}", cost * count(4))),
            ("real time", { let s = (real * count(5)) as u64; format!("{}:{:02}", s / 60, s % 60) }),
        ];
        let cx = WIDTH as f32 / 2.0;
        let grid: Svgr = stats
            .into_iter()
            .enumerate()
            .map(|(i, (label, value))| {
                let (col, row) = ((i % 3) as f32, (i / 3) as f32);
                let x = cx + (col - 1.0) * 460.0;
                let y = 400.0 + row * 200.0;
                let s = pop(t, 0.4 + i as f64 * 0.15, 0.8);

                fframes::svgr!(
                    <g opacity={s.min(1.0)} transform={format!("translate({x},{y}) scale({})", 0.8 + 0.2 * s)}>
                        <text x="0" y="0" font-family={MONO} font-size={86} font-weight="bold" fill={FG} text-anchor="middle">{value}</text>
                        <text x="0" y="50" font-family={SANS} font-size={28} fill={MUTED} text-anchor="middle">{label}</text>
                    </g>
                )
            })
            .collect();
        let names: Vec<String> = self
            .cells
            .iter()
            .filter_map(|c| {
                let n = self.verdicts.iter().filter(|v| &v.cell == c && v.ok).count();

                (n > 0).then(|| format!("{c} v{n}"))
            })
            .collect();
        let tools_line = if names.is_empty() { "no tool passed the gate".to_string() } else { names.join("   ·   ") };

        fframes::svgr!(
            <g opacity={fade}>
                <text x={cx} y={200.0} font-family={SANS} font-size={64} font-weight="bold" fill={FG} text-anchor="middle">{format!("{}: what it grew", self.meta.title)}</text>
                {grid}
                <text x={cx} y={830.0} font-family={MONO} font-size={30} fill={self.meta.accent.as_str()} text-anchor="middle" opacity={ease(t, 1.8, 0.8)}>{tools_line}</text>
                <text x={cx} y={HEIGHT as f32 - 80.0} font-family={SANS} font-size={26} fill={MUTED} text-anchor="middle">"pi-durable + OptChat + celld  ·  github.com/nikhil-vytla/hatch"</text>
            </g>
        )
    }

    fn session<'b>(&'b self, t: f64) -> Svgr<'b> {
        let (w, h) = self.term_size();
        let (x0, y0) = (TERM_X, TERM_Y);
        let enter = ease(t, -0.3, 0.8);
        let leave = 1.0 - ease(t, self.session_len - 0.6, 0.6);
        let key = self.key_at(t);
        let body = key.map(|k| self.screen_svgr(&self.screens[k.screen], x0 + PAD_X, y0 + HEADER_H + PAD_Y)).unwrap_or_default();
        let thinking = key.is_some_and(|k| k.thinking);
        let real = key.map_or(0.0, |k| k.real);
        let pulse = 0.55 + 0.45 * ((t * std::f64::consts::PI * 2.0).sin() * 0.5 + 0.5) as f32;
        let badge = thinking.then(|| {
            let label = format!("model working  ·  {}× fast-forward  ·  {:02}:{:02} real", THINK_SPEED as u32, (real as u64) / 60, (real as u64) % 60);

            fframes::svgr!(<text x={x0 + w - 20.0} y={y0 + 27.0} font-family={SANS} font-size={18} fill={AMBER} text-anchor="end" opacity={pulse}>{label}</text>)
        });

        fframes::svgr!(
            <g opacity={enter * leave}>
                {self.top_bar(t)}
                <rect x={x0 + 5.0} y={y0 + 8.0} width={w} height={h} rx="14" fill="#000000" opacity="0.35" />
                <rect x={x0} y={y0} width={w} height={h} rx="14" fill={PANEL} stroke={EDGE} stroke-width="1.5" />
                <rect x={x0} y={y0 + HEADER_H - 1.0} width={w} height="1" fill={EDGE} />
                <circle cx={x0 + 22.0} cy={y0 + HEADER_H / 2.0} r="6" fill={RED} />
                <circle cx={x0 + 42.0} cy={y0 + HEADER_H / 2.0} r="6" fill={AMBER} />
                <circle cx={x0 + 62.0} cy={y0 + HEADER_H / 2.0} r="6" fill={GREEN} />
                <text x={x0 + 86.0} y={y0 + 26.0} font-family={MONO} font-size={16} fill={MUTED}>"./forge  (the TUI, replayed from the recording)"</text>
                {badge.unwrap_or_default()}
                {body}
                {self.spotlight(t)}
                {self.gate(t)}
                {self.tools(t)}
                {self.progress(t)}
            </g>
        )
    }
}

impl Video for ForgeVideoVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds((INTRO + self.session_len + OUTRO) as f32)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds() as f64;
        let content = if t < INTRO - 0.3 {
            self.intro(t)
        } else if t < INTRO + self.session_len {
            self.session(t - INTRO)
        } else {
            self.outro(t - INTRO - self.session_len)
        };

        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <rect width={WIDTH} height={HEIGHT} fill={BG} />
                {content}
            </svg>
        )
    }
}
