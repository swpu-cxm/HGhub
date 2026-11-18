use crate::{store::atomic_write, PluginError, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCacheMeta {
    pub plugin_id: String,
    pub media_id: String,
    pub title: String,
    pub plugin_name: Option<String>,
    pub year: Option<u32>,
    pub episode_count: Option<u32>,
    pub description: Option<String>,
    pub score: Option<f64>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub cover_rel: Option<String>,
    pub updated_at: u64,
}

pub fn work_key(plugin_id: &str, media_id: &str) -> String {
    format!("{plugin_id}\x1f{media_id}")
}

pub(super) struct WorkMetaStore {
    path: PathBuf,
}

impl WorkMetaStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            path: dir.join("work_meta.json"),
        })
    }

    pub fn load(&self) -> Result<HashMap<String, WorkCacheMeta>> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        serde_json::from_slice(&std::fs::read(&self.path)?)
            .map_err(|_| PluginError::internal("离线作品元数据损坏"))
    }

    pub fn save(&self, map: &HashMap<String, WorkCacheMeta>) -> Result<()> {
        atomic_write(
            &self.path,
            &serde_json::to_vec(map).map_err(|_| PluginError::internal("无法序列化作品元数据"))?,
        )
    }
}