use super::DownloadTask;
use crate::{store::atomic_write, PluginError, Result};
use std::path::{Path, PathBuf};

pub(super) struct DownloadStore {
    path: PathBuf,
}

impl DownloadStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            path: dir.join("downloads.json"),
        })
    }

    pub fn load(&self) -> Result<Vec<DownloadTask>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        serde_json::from_slice(&std::fs::read(&self.path)?)
            .map_err(|_| PluginError::internal("离线下载任务列表损坏"))
    }

    pub fn save(&self, tasks: &[DownloadTask]) -> Result<()> {
        atomic_write(
            &self.path,
            &serde_json::to_vec(tasks).map_err(|_| PluginError::internal("无法序列化下载任务"))?,
        )
    }
}