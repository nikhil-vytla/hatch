//! Daemon logging: timestamped lines on stderr, which the launcher points at
//! `~/.strive/logs/strived.log`.

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        eprintln!("{} {}", $crate::server::epoch_ms(), format_args!($($arg)*))
    };
}
