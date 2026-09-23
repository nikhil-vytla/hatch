//! Which directories effects are changing and which are being rewound,
//! across every session: sessions that share a directory (or nest one in
//! another) share its files. A rewind can't start while an effect in an
//! overlapping directory runs, and an effect waits for a rewind to finish.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Default)]
pub struct Workspaces {
    busy: Mutex<Busy>,
    changed: Notify,
}

#[derive(Default)]
struct Busy {
    effects: Vec<PathBuf>,
    rewinding: Vec<PathBuf>,
}

fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// An effect in progress; dropping it lets rewinds of its directory go ahead.
pub struct Effect {
    owner: Arc<Workspaces>,
    path: PathBuf,
}

/// A rewind in progress; dropping it lets effects in its directory go ahead.
pub struct Rewind {
    owner: Arc<Workspaces>,
    path: PathBuf,
}

impl Workspaces {
    /// Waits until no overlapping directory is being rewound, then counts an
    /// effect in `path`.
    pub async fn effect(self: &Arc<Self>, path: &Path) -> Effect {
        loop {
            let changed = self.changed.notified();
            {
                let mut busy = crate::sync::lock(&self.busy);
                if !busy.rewinding.iter().any(|r| overlaps(r, path)) {
                    busy.effects.push(path.to_path_buf());
                    return Effect { owner: self.clone(), path: path.to_path_buf() };
                }
            }
            changed.await;
        }
    }

    /// Starts a rewind of `path`, or `None` if an effect (or another rewind)
    /// in an overlapping directory is under way.
    pub fn rewind(self: &Arc<Self>, path: &Path) -> Option<Rewind> {
        let mut busy = crate::sync::lock(&self.busy);
        if busy.effects.iter().chain(&busy.rewinding).any(|p| overlaps(p, path)) {
            return None;
        }
        busy.rewinding.push(path.to_path_buf());
        Some(Rewind { owner: self.clone(), path: path.to_path_buf() })
    }
}

fn remove_one(list: &mut Vec<PathBuf>, path: &Path) {
    if let Some(i) = list.iter().position(|p| p == path) {
        list.swap_remove(i);
    }
}

impl Drop for Effect {
    fn drop(&mut self) {
        remove_one(&mut crate::sync::lock(&self.owner.busy).effects, &self.path);
        self.owner.changed.notify_waiters();
    }
}

impl Drop for Rewind {
    fn drop(&mut self) {
        remove_one(&mut crate::sync::lock(&self.owner.busy).rewinding, &self.path);
        self.owner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nested_directories_overlap_and_siblings_dont() {
        let w = Arc::new(Workspaces::default());
        let effect = w.effect(Path::new("/repo/app")).await;
        assert!(w.rewind(Path::new("/repo")).is_none(), "a parent overlaps");
        assert!(w.rewind(Path::new("/repo/app/src")).is_none(), "a child overlaps");
        assert!(w.rewind(Path::new("/repo/lib")).is_some(), "a sibling doesn't");
        drop(effect);
        assert!(w.rewind(Path::new("/repo")).is_some());
    }

    #[tokio::test]
    async fn an_effect_waits_for_a_rewind_of_its_directory() {
        let w = Arc::new(Workspaces::default());
        let rewind = w.rewind(Path::new("/repo")).unwrap();
        let waiting = tokio::spawn({
            let w = w.clone();
            async move { w.effect(Path::new("/repo/a")).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        drop(rewind);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await.unwrap().unwrap();
    }
}
