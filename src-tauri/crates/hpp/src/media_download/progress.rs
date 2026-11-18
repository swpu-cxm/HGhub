use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadKind {
    ProgressiveMp4,
    HlsFmp4,
    HlsMpegTs,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub title: String,
    pub episode_label: Option<String>,
    pub source_url: String,
    pub kind: DownloadKind,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub episode_id: Option<String>,
    #[serde(default)]
    pub episode_index: Option<u32>,
    #[serde(default)]
    pub episode_count: Option<u32>,
    #[serde(default)]
    pub cover_rel: Option<String>,
    pub state: DownloadState,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: f64,
    pub error: Option<String>,
    pub output_rel: Option<String>,
    pub temp_rel: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl DownloadTask {
    pub fn new(
        id: String,
        title: String,
        episode_label: Option<String>,
        source_url: String,
        kind: DownloadKind,
        headers: HashMap<String, String>,
        plugin_id: Option<String>,
        media_id: Option<String>,
        episode_id: Option<String>,
        episode_index: Option<u32>,
        episode_count: Option<u32>,
        cover_rel: Option<String>,
        now: u64,
    ) -> Self {
        Self {
            id,
            title,
            episode_label,
            source_url,
            kind,
            headers,
            plugin_id,
            media_id,
            episode_id,
            episode_index,
            episode_count,
            cover_rel,
            state: DownloadState::Queued,
            bytes_done: 0,
            bytes_total: None,
            speed_bps: 0.0,
            error: None,
            output_rel: None,
            temp_rel: None,
            created_at: now,
            updated_at: now,
        }
    }
}