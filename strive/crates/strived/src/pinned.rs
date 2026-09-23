//! Files reached without following symlinks.
//!
//! The effect gate checks a path with every symlink resolved. Acting on that
//! path by name would follow symlinks again, so a directory swapped for a
//! symlink between the check and the act (by a command running in parallel)
//! could redirect a write out of the workspace. Here the path is walked one
//! component at a time with `O_NOFOLLOW`: the file reached is the one
//! checked, or the effect fails.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::OwnedFd;

use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

use nix::errno::Errno;
use nix::fcntl::{AT_FDCWD, OFlag, openat, renameat};
use nix::sys::stat::{FileStat, Mode, SFlag, fchmod, fstat, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};

/// A directory opened by walking its path without following symlinks.
pub struct Dir(OwnedFd);

/// Why a pinned operation failed.
#[derive(Debug)]
pub enum Error {
    /// A path component is (now) a symlink, or not a directory.
    Changed,
    /// The file exists but isn't a regular file (a FIFO, a device, a directory).
    NotRegular,
    NotFound,
    Io(io::Error),
}

impl From<Errno> for Error {
    fn from(e: Errno) -> Self {
        match e {
            Errno::ELOOP | Errno::ENOTDIR => Error::Changed,
            Errno::ENOENT => Error::NotFound,
            e => Error::Io(io::Error::from(e)),
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

const DIR_FLAGS: OFlag = OFlag::O_DIRECTORY.union(OFlag::O_NOFOLLOW).union(OFlag::O_RDONLY).union(OFlag::O_CLOEXEC);

/// Opens the directory holding `path` (absolute, with no symlinks in it) and
/// returns it with the file's name. With `create`, missing directories are made.
pub fn parent(path: &Path, create: bool) -> Result<(Dir, OsString), Error> {
    let name = path.file_name().ok_or(Error::NotFound)?.to_os_string();
    let mut dir = openat(AT_FDCWD, "/", DIR_FLAGS, Mode::empty())?;
    for part in path.parent().ok_or(Error::NotFound)?.components() {
        let Component::Normal(part) = part else { continue };
        dir = match openat(&dir, part, DIR_FLAGS, Mode::empty()) {
            Err(Errno::ENOENT) if create => {
                match mkdirat(&dir, part, Mode::from_bits_truncate(0o777)) {
                    Ok(()) | Err(Errno::EEXIST) => {}
                    Err(e) => return Err(e.into()),
                }
                openat(&dir, part, DIR_FLAGS, Mode::empty())?
            }
            r => r?,
        };
    }
    Ok((Dir(dir), name))
}

static TEMP: AtomicU64 = AtomicU64::new(0);

impl Dir {
    /// Opens a regular file for reading, with its metadata.
    pub fn open_regular(&self, name: &OsStr) -> Result<(File, FileStat), Error> {
        // O_NONBLOCK, so opening a FIFO doesn't wait for a writer.
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let fd = openat(&self.0, name, flags, Mode::empty())?;
        let stat = fstat(&fd)?;
        if !is_regular(&stat) {
            return Err(Error::NotRegular);
        }
        Ok((File::from(fd), stat))
    }

    /// Replaces a file with `bytes` atomically, keeping an existing file's
    /// permissions. Each call writes its own temporary file, so parallel
    /// writes to one file each land whole.
    pub fn replace(&self, name: &OsStr, bytes: &[u8]) -> Result<(), Error> {
        let mode = match fstatat(&self.0, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(s) if is_regular(&s) => Some(Mode::from_bits_truncate(s.st_mode)),
            Ok(_) | Err(Errno::ENOENT) => None,
            Err(e) => return Err(e.into()),
        };
        let mut tmp = OsString::from(".");
        tmp.push(name);
        tmp.push(format!(".strive-{}-{}", std::process::id(), TEMP.fetch_add(1, Ordering::Relaxed)));
        let flags = OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let fd = openat(&self.0, tmp.as_os_str(), flags, Mode::from_bits_truncate(0o666))?;
        let written = (|| -> Result<(), Error> {
            if let Some(mode) = mode {
                fchmod(&fd, mode)?;
            }
            let mut f = File::from(fd);
            f.write_all(bytes)?;
            f.sync_all()?;
            renameat(&self.0, tmp.as_os_str(), &self.0, name)?;
            Ok(())
        })();
        if written.is_err() {
            let _ = unlinkat(&self.0, tmp.as_os_str(), UnlinkatFlags::NoRemoveDir); // best effort
        }
        written
    }
}

fn is_regular(s: &FileStat) -> bool {
    SFlag::from_bits_truncate(s.st_mode) & SFlag::S_IFMT == SFlag::S_IFREG
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_swapped_for_a_symlink_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (ws, outside) = (root.join("ws"), root.join("outside"));
        std::fs::create_dir_all(ws.join("d")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let target = ws.join("d/file.txt"); // what the gate checked
        std::fs::remove_dir(ws.join("d")).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("d")).unwrap();
        assert!(matches!(parent(&target, true), Err(Error::Changed)));
        assert!(!outside.join("file.txt").exists());
    }

    #[test]
    fn a_final_symlink_is_not_followed_when_reading() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        std::fs::write(root.join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(root.join("secret"), root.join("link")).unwrap();
        let (dir, name) = parent(&root.join("link"), false).unwrap();
        assert!(matches!(dir.open_regular(&name), Err(Error::Changed)));
    }

    #[test]
    fn replacing_keeps_permissions_and_creates_missing_directories() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let p = root.join("a/b/run.sh");
        let (dir, name) = parent(&p, true).unwrap();
        dir.replace(&name, b"one").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o750)).unwrap();
        dir.replace(&name, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o750);
    }
}
