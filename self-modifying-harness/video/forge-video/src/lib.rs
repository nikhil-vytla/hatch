//! Forge, recorded: a real `./forge` session replayed from an asciicast and drawn as SVG, one frame at a time.
//!
//! The cast is the byte stream a pseudo-terminal received while the TUI ran against a real model. `vt100` replays it
//! into a screen grid; each distinct screen becomes a keyframe at a *video* time. Video time runs at real speed while
//! someone is typing or reading, fast-forwards while the footer says the model is thinking, and holds for a few
//! seconds after each turn so the result can be read. Chapter titles come from the driver's markers (one per typed
//! message), mapped from real to video time the same way. An intro card and a closing card with the run's real
//! numbers frame it.
use fframes::{
    AudioMap, Color, Duration, FFramesContext, Frame, Svgr, Transform, Video, animation::Easing,
    include_media_dir,
};

include_media_dir!(pub struct ForgeVideoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

const MONO: &str = "DejaVu Sans Mono, DejaVu Sans";
const SANS: &str = "DM Sans";

// Terminal geometry: DejaVu Sans Mono advances 1233/2048 em per cell.
const FONT_SIZE: f32 = 22.0;
const CELL_W: f32 = FONT_SIZE * 1233.0 / 2048.0;
const LINE_H: f32 = 27.0;
const PAD_X: f32 = 24.0;
const PAD_Y: f32 = 16.0;
const HEADER_H: f32 = 46.0;

const BG: &str = "#0b0d12";
const TERM_BG: &str = "#11141b";
const FG: &str = "#d7dae0";
const MUTED: &str = "#8b93a1";
const ACCENT: &str = "#e5c07b";

const INTRO: f64 = 5.0;
const OUTRO: f64 = 7.0;
/// Model time runs this many times faster than real time.
const THINK_SPEED: f64 = 6.0;
/// No single quiet gap lasts longer than this on screen.
const MAX_GAP: f64 = 1.2;
/// Pause after each turn ends, so its result can be read.
const HOLD: f64 = 5.0;

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
}

struct Chapter {
    at: f64,
    title: String,
}

pub struct ForgeVideoVideo<'a> {
    pub media: &'a ForgeVideoMedia,
    cols: u16,
    rows: u16,
    screens: Vec<Screen>,
    keys: Vec<Keyframe>,
    chapters: Vec<Chapter>,
    stats: Vec<(String, String)>,
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
                fg = bg.unwrap_or_else(|| TERM_BG.to_string());
                bg = Some(old);
            }

            if cell.dim() {
                fg = mix(&fg, TERM_BG, 0.55);
            }

            let text = if cell.has_contents() { cell.contents().to_string() } else { " ".to_string() };
            let blank = text == " " && bg.is_none();

            // DejaVu Sans Mono has no Braille (the TUI's spinner), and a run with one missing glyph falls back whole to a
            // proportional font, so a Braille cell gets a run of its own.
            if text.chars().any(|ch| ('\u{2800}'..='\u{28FF}').contains(&ch)) {
                if let Some(mut run) = current.take() {
                    run.text = run.text.trim_end().to_string();

                    if !run.text.is_empty() {
                        runs.push(run);
                    }
                }

                runs.push(Run { col: c, text, fg, bg, bold: cell.bold() });
                spaces = 0;

                continue;
            }
            let same = current.as_ref().is_some_and(|run| run.fg == fg && run.bg == bg && run.bold == cell.bold() && !cell.is_wide());

            if blank {
                spaces += 1;

                if spaces >= 2 {
                    if let Some(mut run) = current.take() {
                        run.text = run.text.trim_end().to_string();

                        if !run.text.is_empty() {
                            runs.push(run);
                        }
                    }
                }

                if let Some(run) = current.as_mut() {
                    run.text.push(' ');
                }

                continue;
            }

            spaces = 0;

            if same {
                if let Some(run) = current.as_mut() {
                    run.text.push_str(&text);
                }
            } else {
                if let Some(mut run) = current.take() {
                    run.text = run.text.trim_end().to_string();

                    if !run.text.is_empty() || run.bg.is_some() {
                        runs.push(run);
                    }
                }

                current = Some(Run { col: c, text, fg, bg, bold: cell.bold() });
            }
        }

        if let Some(mut run) = current.take() {
            run.text = run.text.trim_end().to_string();

            if !run.text.is_empty() {
                runs.push(run);
            }
        }

        out.push(runs);
    }

    Screen { rows: out }
}

/// The footer is the last row; while the model works it carries the spinner and "thinking...".
fn is_thinking(screen: &vt100::Screen, rows: u16) -> bool {
    screen.contents_between(rows - 1, 0, rows - 1, 40).contains("thinking")
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

impl<'a> ForgeVideoVideo<'a> {
    pub fn new(media: &'a ForgeVideoMedia, cast_path: &str) -> Self {
        let cast = std::fs::read_to_string(cast_path).expect("cast");
        let mut lines = cast.lines();
        let head: serde_json::Value = serde_json::from_str(lines.next().expect("cast header")).expect("cast header");
        let cols = head["width"].as_u64().unwrap_or(132) as u16;
        let rows = head["height"].as_u64().unwrap_or(34) as u16;

        let mut parser = vt100::Parser::new(rows, cols, 0);
        let mut screens: Vec<Screen> = Vec::new();
        let mut keys: Vec<Keyframe> = Vec::new();
        let mut pairs: Vec<(f64, f64)> = Vec::new();
        let (mut video, mut last_real, mut started, mut was_thinking) = (0.0f64, 0.0f64, false, false);

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

            let thinking = is_thinking(screen, rows);
            let snap = snapshot(screen, rows, cols);

            if screens.last() != Some(&snap) {
                screens.push(snap);
                keys.push(Keyframe { at: video, screen: screens.len() - 1, thinking, real });
            } else if let Some(k) = keys.last_mut() {
                k.thinking = thinking;
            }

            pairs.push((real, video));

            if was_thinking && !thinking {
                video += HOLD;
                pairs.push((real + 1e-6, video));
            }

            was_thinking = thinking;
        }

        let session_len = video + 1.5;

        // Chapters: the driver's markers, named "title" at a real time, written next to the cast.
        let snaps_path = cast_path.trim_end_matches(".cast").to_string() + ".snaps.json";
        let chapters = std::fs::read_to_string(&snaps_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| {
                let title = v[0].as_str()?.to_string();
                let real = v[2].as_f64()?;

                (title != "end").then(|| Chapter { at: to_video(&pairs, real), title })
            })
            .collect();

        let stats_path = cast_path.trim_end_matches(".cast").to_string() + ".stats.json";
        let stats = std::fs::read_to_string(&stats_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<(String, String)>>(&s).ok())
            .unwrap_or_default();

        Self { media, cols, rows, screens, keys, chapters, stats, session_len }
    }

    fn key_at(&self, t: f64) -> Option<&Keyframe> {
        let i = self.keys.partition_point(|k| k.at <= t);

        if i == 0 { self.keys.first() } else { self.keys.get(i - 1) }
    }

    fn chapter_at(&self, t: f64) -> Option<(usize, &Chapter)> {
        let i = self.chapters.partition_point(|c| c.at <= t);

        if i == 0 { None } else { Some((i - 1, &self.chapters[i - 1])) }
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
                        <text x={x} y={y + LINE_H * 0.75} font-family={MONO} font-size={FONT_SIZE} font-weight={weight} fill={run.fg.as_str()}>{run.text.as_str()}</text>
                    </g>
                )
            })
            .collect()
    }

    fn intro<'b>(&'b self, frame: &Frame) -> Svgr<'b> {
        let fade_in = frame.animate(&fframes::timeline!(at 0.2 => 1.0, animate 0.0_f32 => 1.0, Easing::EaseOut));
        let rise = frame.animate(&fframes::timeline!(at 0.2, animate 50.0_f32 => 0.0, Easing::Spring { mass: 1.0, stiffness: 160.0, damping: 20.0 }));
        let sub = frame.animate(&fframes::timeline!(at 1.0 => 1.8, animate 0.0_f32 => 1.0, Easing::EaseOut));
        let fade_out = frame.animate(&fframes::timeline!(at (INTRO - 0.6) as f32 => INTRO as f32, animate 1.0_f32 => 0.0, Easing::EaseIn));
        let (cx, cy) = (WIDTH as f32 / 2.0, HEIGHT as f32 / 2.0);

        fframes::svgr!(
            <g opacity={fade_in * fade_out} transform={Transform::translate(0, rise)}>
                <text x={cx} y={cy - 40.0} font-family={MONO} font-size={120} font-weight="bold" fill={FG} text-anchor="middle">"./forge"</text>
                <text x={cx} y={cy + 40.0} font-family={SANS} font-size={40} fill={ACCENT} text-anchor="middle" opacity={sub}>"an agent that writes, verifies and hot-installs its own tools"</text>
                <text x={cx} y={cy + 110.0} font-family={SANS} font-size={30} fill={MUTED} text-anchor="middle" opacity={sub}>"Tonight: a D&D one-shot. Five messages, no tools to start with, DeepSeek V4.1 Flash."</text>
                <text x={cx} y={cy + 160.0} font-family={SANS} font-size={26} fill={MUTED} text-anchor="middle" opacity={sub}>"Recorded live; model time fast-forwarded."</text>
            </g>
        )
    }

    fn outro<'b>(&'b self, frame: &Frame, start: f64) -> Svgr<'b> {
        let fade_in = frame.animate(&fframes::timeline!(at start as f32 => (start + 0.8) as f32, animate 0.0_f32 => 1.0, Easing::EaseOut));
        let (cx, top) = (WIDTH as f32 / 2.0, 300.0);
        let rows: Svgr = self
            .stats
            .iter()
            .enumerate()
            .map(|(i, (label, value))| {
                let y = top + 120.0 + i as f32 * 62.0;
                let shown = frame.animate(&fframes::timeline!(at (start + 0.6 + i as f64 * 0.25) as f32 => (start + 1.1 + i as f64 * 0.25) as f32, animate 0.0_f32 => 1.0, Easing::EaseOut));

                fframes::svgr!(
                    <g opacity={shown}>
                        <text x={cx - 20.0} y={y} font-family={SANS} font-size={34} fill={MUTED} text-anchor="end">{label.as_str()}</text>
                        <text x={cx + 20.0} y={y} font-family={MONO} font-size={34} font-weight="bold" fill={FG}>{value.as_str()}</text>
                    </g>
                )
            })
            .collect();

        fframes::svgr!(
            <g opacity={fade_in}>
                <text x={cx} y={top} font-family={MONO} font-size={64} font-weight="bold" fill={FG} text-anchor="middle">"What it grew"</text>
                {rows}
                <text x={cx} y={HEIGHT as f32 - 90.0} font-family={SANS} font-size={28} fill={MUTED} text-anchor="middle">"pi-durable + OptChat + celld  ·  github.com/nikhil-vytla/hatch"</text>
            </g>
        )
    }

    fn session<'b>(&'b self, frame: &Frame, t: f64) -> Svgr<'b> {
        let (w, h) = self.term_size();
        let (x0, y0) = ((WIDTH as f32 - w) / 2.0, (HEIGHT as f32 - h) / 2.0);
        let enter = frame.animate(&fframes::timeline!(at (INTRO - 0.3) as f32 => (INTRO + 0.5) as f32, animate 0.0_f32 => 1.0, Easing::EaseOut));
        let leave = frame.animate(&fframes::timeline!(at (INTRO + self.session_len - 0.6) as f32 => (INTRO + self.session_len) as f32, animate 1.0_f32 => 0.0, Easing::EaseIn));
        let key = self.key_at(t);
        let body = key.map(|k| self.screen_svgr(&self.screens[k.screen], x0 + PAD_X, y0 + HEADER_H + PAD_Y)).unwrap_or_default();
        let thinking = key.is_some_and(|k| k.thinking);
        let real = key.map_or(0.0, |k| k.real);
        let total = self.chapters.iter().filter(|c| c.title != "Done" && !c.title.starts_with("Starting")).count();
        let chapter = match self.chapter_at(t) {
            Some((i, c)) if c.title != "Done" && !c.title.starts_with("Starting") => format!("message {} of {}  ·  {}", i, total, c.title),
            Some((_, c)) => c.title.clone(),
            None => String::new(),
        };
        let pulse = 0.55 + 0.45 * ((t * std::f64::consts::PI * 2.0).sin() * 0.5 + 0.5) as f32;
        let badge = thinking.then(|| {
            let label = format!("model working  ·  fast-forward {}×  ·  {:02}:{:02} real", THINK_SPEED as u32, (real as u64) / 60, (real as u64) % 60);

            fframes::svgr!(<text x={x0 + w - 22.0} y={y0 + 30.0} font-family={SANS} font-size={20} fill={ACCENT} text-anchor="end" opacity={pulse}>{label}</text>)
        });

        fframes::svgr!(
            <g opacity={enter * leave} transform={Transform::translate(0, (1.0 - enter) * 40.0)}>
                <rect x={x0 + 6.0} y={y0 + 10.0} width={w} height={h} rx="14" fill="#000000" opacity="0.35" />
                <rect x={x0} y={y0} width={w} height={h} rx="14" fill={TERM_BG} stroke="#262b36" stroke-width="1.5" />
                <rect x={x0} y={y0 + HEADER_H - 1.0} width={w} height="1" fill="#262b36" />
                <circle cx={x0 + 24.0} cy={y0 + HEADER_H / 2.0} r="7" fill="#e06c75" />
                <circle cx={x0 + 46.0} cy={y0 + HEADER_H / 2.0} r="7" fill="#e5c07b" />
                <circle cx={x0 + 68.0} cy={y0 + HEADER_H / 2.0} r="7" fill="#98c379" />
                <text x={x0 + 96.0} y={y0 + 30.0} font-family={MONO} font-size={19} fill={MUTED}>"./forge"</text>
                <text x={x0 + w / 2.0} y={y0 + 30.0} font-family={SANS} font-size={21} fill={FG} text-anchor="middle">{chapter}</text>
                {badge.unwrap_or_default()}
                {body}
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
            self.intro(&frame)
        } else if t < INTRO + self.session_len {
            self.session(&frame, t - INTRO)
        } else {
            self.outro(&frame, INTRO + self.session_len)
        };

        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <rect width={WIDTH} height={HEIGHT} fill={BG} />
                {content}
            </svg>
        )
    }
}
