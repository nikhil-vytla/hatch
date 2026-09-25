//! The content store: blobs named by their SHA-256.
//!
//! A blob is written to a temp file, synced, then renamed into place, so a
//! reader never sees a partial blob and a crash leaves at most a stray temp
//! file. `put` returns only once the blob is durable, so a journal entry
//! that names it can be committed afterwards. `get` re-hashes what it reads.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest as _, Sha256};
pub use strive_proto::Digest;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// The name `bytes` would have in the store, without storing them.
pub fn digest(bytes: &[u8]) -> Digest {
    Digest::from_bytes(Sha256::digest(bytes).into())
}

#[derive(Debug, Clone)]
pub struct Cas {
    root: PathBuf,
}

impl Cas {
    pub fn open(root: &Path) -> io::Result<Self> {
        fs::create_dir_all(root.join("sha256"))?;
        Ok(Self { root: root.to_path_buf() })
    }

    /// The blob's directory and its path within it.
    fn location(&self, d: &Digest) -> (PathBuf, PathBuf) {
        let hex = d.hex();
        let dir = self.root.join("sha256").join(&hex[..2]);
        let path = dir.join(&hex[2..]);
        (dir, path)
    }

    pub fn put(&self, bytes: &[u8]) -> io::Result<Digest> {
        let d = digest(bytes);
        let (dir, path) = self.location(&d);
        if path.exists() {
            return Ok(d);
        }
        fs::create_dir_all(&dir)?;
        let tmp = dir.join(format!(".tmp-{}-{}", std::process::id(), TEMP_SEQ.fetch_add(1, Ordering::Relaxed)));
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, &path)?;
        File::open(&dir)?.sync_all()?;
        Ok(d)
    }

    pub fn get(&self, d: &Digest) -> io::Result<Vec<u8>> {
        let bytes = fs::read(self.location(d).1)?;
        if Sha256::digest(&bytes).as_slice() != d.as_bytes() {
            return Err(io::Error::new(ErrorKind::InvalidData, format!("blob {d} does not match its digest")));
        }
        Ok(bytes)
    }
}
