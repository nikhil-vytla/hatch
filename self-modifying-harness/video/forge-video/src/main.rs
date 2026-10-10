use fframes::{EncoderOptions, RenderOptions, StaticMediaProvider, cli};
use forge_video::{ForgeVideoMedia, ForgeVideoVideo};
use fframes::cli::clap; // the derive below expands to `clap::...`
use std::process::ExitCode;

/// Flags of this video next to the standard ones of `fframes::cli`. Rendering uses fframes' built-in CPU backend:
/// this machine has no GPU.
#[derive(Debug, clap::Args)]
struct VideoArgs {
    /// The asciicast to replay.
    #[arg(long, default_value = "session.cast", global = true)]
    cast: String,
}

fn main() -> ExitCode {
    let args = cli::parse::<VideoArgs>();
    let media = ForgeVideoMedia::prepare().expect("media");
    let video = ForgeVideoVideo::new(&media, &args.app.cast);

    cli::new(
        &video,
        RenderOptions {
            media: Some(&media),
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("mpeg4"),
                codec_params: Some(&[("b", "30M")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .args(args)
    .run()
}
