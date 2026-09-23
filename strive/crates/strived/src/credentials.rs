//! Provider API keys. Only the daemon holds them: the gateway adds them to
//! upstream requests, so the agent and its tools never see a key.
//!
//! Keys set with `strive auth` live in `~/.strive/credentials.json` (0600)
//! and take precedence over the daemon's environment at start-up.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

pub const PROVIDERS: &[(&str, &str)] = &[("anthropic", "ANTHROPIC_API_KEY"), ("openai", "OPENAI_API_KEY")];

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    api_key: String,
}

pub struct Credentials {
    path: PathBuf,
    file: RwLock<BTreeMap<String, Stored>>,
    env: BTreeMap<String, String>,
}

impl Credentials {
    pub fn load(home: &std::path::Path) -> io::Result<Self> {
        let path = home.join("credentials.json");
        let file = match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| io::Error::other(format!("{} is not valid: {e}", path.display())))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e),
        };
        let env = PROVIDERS
            .iter()
            .filter_map(|(p, var)| std::env::var(var).ok().filter(|v| !v.is_empty()).map(|v| ((*p).to_string(), v)))
            .collect();
        Ok(Self { path, file: RwLock::new(file), env })
    }

    pub fn get(&self, provider: &str) -> Option<String> {
        let file = crate::sync::read(&self.file);
        file.get(provider).map(|s| s.api_key.clone()).or_else(|| self.env.get(provider).cloned())
    }

    /// `file`, `env` or `none`.
    pub fn source(&self, provider: &str) -> &'static str {
        if crate::sync::read(&self.file).contains_key(provider) {
            "file"
        } else if self.env.contains_key(provider) {
            "env"
        } else {
            "none"
        }
    }

    /// Stores a key, replacing the file atomically with mode 0600.
    pub fn set(&self, provider: &str, api_key: String) -> io::Result<()> {
        let mut file = crate::sync::write(&self.file);
        let mut next = file.clone();
        next.insert(provider.to_string(), Stored { api_key });
        let tmp = self.path.with_extension(format!("json.{}", std::process::id()));
        let _ = fs::remove_file(&tmp);
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(&next).map_err(io::Error::other)?)?;
        f.sync_all()?;
        fs::rename(&tmp, &self.path)?;
        *file = next;
        Ok(())
    }
}
