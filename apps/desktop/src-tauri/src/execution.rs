use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct ActiveExecutions {
    projects: HashSet<PathBuf>,
    cli_installing: bool,
}

/// One atomic editing slot per project, plus an exclusive CLI-install slot.
#[derive(Clone, Default)]
pub struct ProjectExecutions {
    active: Arc<Mutex<ActiveExecutions>>,
}

pub struct ProjectPermit {
    active: Arc<Mutex<ActiveExecutions>>,
    project: PathBuf,
}

pub struct CliInstallPermit {
    active: Arc<Mutex<ActiveExecutions>>,
}

impl ProjectExecutions {
    pub fn try_acquire(&self, project: &Path) -> Option<ProjectPermit> {
        let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.cli_installing || !active.projects.insert(project.clone()) {
            return None;
        }
        Some(ProjectPermit {
            active: self.active.clone(),
            project,
        })
    }

    pub fn try_acquire_cli_install(&self) -> Option<CliInstallPermit> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.cli_installing || !active.projects.is_empty() {
            return None;
        }
        active.cli_installing = true;
        Some(CliInstallPermit {
            active: self.active.clone(),
        })
    }
}

impl Drop for ProjectPermit {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .projects
            .remove(&self.project);
    }
}

impl Drop for CliInstallPermit {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cli_installing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_has_exactly_one_slot_until_the_permit_drops() {
        let slots = ProjectExecutions::default();
        let project = std::env::temp_dir();
        let permit = slots.try_acquire(&project).unwrap();
        assert!(slots.try_acquire(&project).is_none());
        drop(permit);
        assert!(slots.try_acquire(&project).is_some());
    }

    #[test]
    fn cli_install_is_exclusive_with_every_project_operation() {
        let slots = ProjectExecutions::default();
        let project = std::env::temp_dir();

        let project_permit = slots.try_acquire(&project).unwrap();
        assert!(slots.try_acquire_cli_install().is_none());
        drop(project_permit);

        let install_permit = slots.try_acquire_cli_install().unwrap();
        assert!(slots.try_acquire_cli_install().is_none());
        assert!(slots.try_acquire(&project).is_none());
        drop(install_permit);

        assert!(slots.try_acquire(&project).is_some());
    }
}
