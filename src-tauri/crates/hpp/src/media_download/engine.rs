use super::{
    hls::{self, download_fmp4_hls, download_progressive, detect_fmp4_hls},
    hls_mpegts::{self, detect_mpegts_hls, download_mpegts_hls},
    progress::{DownloadKind, DownloadState, DownloadTask},
    store::DownloadStore,
};
use base64::Engine;
use crate::{store::now, PluginError, Result};
use reqwest::Client;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::sync::Semaphore;
use uuid::Uuid;

const MAX_ACTIVE: usize = 2;
const MAX_RETRIES: u32 = 3;

#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<DownloadManagerInner>,
}

struct DownloadManagerInner {
    root: PathBuf,
    store: DownloadStore,
    client: Client,
    tasks: Mutex<Vec<DownloadTask>>,
    active: Semaphore,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadManager {
    pub fn open(root: PathBuf) -> Result<Self> {
        let cache = root.join("offline");
        std::fs::create_dir_all(&cache)?;
        let store = DownloadStore::open(&root)?;
        let tasks = store.load()?;
        Ok(Self {
            inner: Arc::new(DownloadManagerInner {
                root,
                store,
                client: Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(8))
                    .build()
                    .map_err(|_| PluginError::internal("无法创建下载客户端"))?,
                tasks: Mutex::new(tasks),
                active: Semaphore::new(MAX_ACTIVE),
                cancel_flags: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn list(&self) -> Vec<DownloadTask> {
        self.inner.tasks.lock().unwrap().clone()
    }

    pub fn cover_local_path(&self, rel: &str) -> Result<PathBuf> {
        let path = self.inner.root.join(rel);
        if path.is_file() {
            Ok(path)
        } else {
            Err(PluginError::invalid("封面文件不存在"))
        }
    }

    pub async fn enqueue(
        &self,
        title: String,
        episode_label: Option<String>,
        source_url: String,
        headers: HashMap<String, String>,
        kind: Option<DownloadKind>,
        source_format: Option<&str>,
        plugin_id: Option<String>,
        media_id: Option<String>,
        episode_id: Option<String>,
        episode_index: Option<u32>,
        episode_count: Option<u32>,
        cover_url: Option<String>,
    ) -> Result<DownloadTask> {
        {
            let tasks = self.inner.tasks.lock().unwrap();
            if tasks.iter().any(|t| {
                t.source_url == source_url
                    && t.state != DownloadState::Cancelled
                    && t.state != DownloadState::Failed
            }) {
                return Err(PluginError::invalid("相同地址已有进行中的下载任务"));
            }
        }
        let kind = match kind {
            Some(k) => k,
            None => classify_url(&self.inner.client, &source_url, &headers, source_format).await,
        };
        let id = Uuid::new_v4().to_string();
        let ts = now();
        let task = DownloadTask::new(
            id.clone(),
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
            None,
            ts,
        );
        {
            let mut tasks = self.inner.tasks.lock().unwrap();
            tasks.push(task.clone());
            self.inner.store.save(&tasks)?;
        }
        if let Some(url) = cover_url.filter(|u| u.starts_with("http://") || u.starts_with("https://")) {
            let mgr = self.clone();
            let id = id.clone();
            tokio::spawn(async move {
                let _ = mgr.fetch_cover(&id, &url).await;
            });
        }
        self.kick(id).await;
        Ok(task)
    }

    pub async fn pause(&self, id: &str) -> Result<()> {
        self.set_state(id, DownloadState::Paused, None).await
    }

    pub async fn resume(&self, id: &str) -> Result<()> {
        self.set_state(id, DownloadState::Queued, None).await?;
        self.kick(id.to_string()).await;
        Ok(())
    }

    pub async fn cancel(&self, id: &str) -> Result<()> {
        if let Some(flag) = self.inner.cancel_flags.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
        self.set_state(id, DownloadState::Cancelled, None).await
    }

    pub async fn remove(&self, id: &str) -> Result<()> {
        self.cancel(id).await.ok();
        let mut tasks = self.inner.tasks.lock().unwrap();
        let (output, temp) = tasks
            .iter()
            .find(|t| t.id == id)
            .map(|t| (t.output_rel.clone(), t.temp_rel.clone()))
            .unwrap_or((None, None));
        tasks.retain(|t| t.id != id);
        self.inner.store.save(&tasks)?;
        drop(tasks);
        for rel in [output, temp].into_iter().flatten() {
            if rel.contains("pkg_") || rel.ends_with(".m3u8") {
                let _ = hls_mpegts::remove_package(&self.inner.root, &rel);
            } else {
                let path = self.inner.root.join(rel);
                let _ = std::fs::remove_file(path);
                let part = self.inner.root.join(format!("offline/.{}.part", id));
                let _ = std::fs::remove_file(part);
            }
        }
        let pkg = self.inner.root.join(format!("offline/pkg_{id}"));
        let _ = std::fs::remove_dir_all(pkg);
        Ok(())
    }

    pub fn offline_hls_package_dir(&self, id: &str) -> Result<std::path::PathBuf> {
        let tasks = self.inner.tasks.lock().unwrap();
        let task = tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| PluginError::invalid("找不到下载任务"))?;
        if task.kind != DownloadKind::HlsMpegTs {
            return Err(PluginError::invalid("不是 HLS TS 离线任务"));
        }
        if task.state != DownloadState::Completed {
            return Err(PluginError::invalid("任务尚未完成"));
        }
        let rel = task
            .output_rel
            .as_ref()
            .ok_or_else(|| PluginError::internal("缺少输出路径"))?;
        let path = self.inner.root.join(rel);
        if !path.exists() {
            return Err(PluginError::invalid("离线文件已不存在"));
        }
        Ok(if path.is_file() {
            path.parent()
                .ok_or_else(|| PluginError::invalid("HLS 路径无效"))?
                .to_path_buf()
        } else {
            path
        })
    }

    pub fn offline_hls_read(&self, id: &str, resource: &str) -> Result<serde_json::Value> {
        let pkg = self.offline_hls_package_dir(id)?;
        let name = hls_mpegts::validate_offline_resource_name(resource)?;
        let bytes = hls_mpegts::read_offline_package_file(&pkg, &name)?;
        let mime = if name.ends_with(".m3u8") {
            "application/vnd.apple.mpegurl"
        } else if name.ends_with(".ts") {
            "video/mp2t"
        } else if name.ends_with(".key") {
            "application/octet-stream"
        } else {
            "application/octet-stream"
        };
        Ok(serde_json::json!({
            "name": name,
            "bytes": bytes.len(),
            "mime": mime,
            "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "loader": "ipc",
        }))
    }

    pub fn prepare_playback(&self, id: &str) -> Result<serde_json::Value> {
        let tasks = self.inner.tasks.lock().unwrap();
        let task = tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| PluginError::invalid("找不到下载任务"))?;
        if task.state != DownloadState::Completed {
            return Err(PluginError::invalid("任务尚未完成"));
        }
        let rel = task
            .output_rel
            .as_ref()
            .ok_or_else(|| PluginError::internal("缺少输出路径"))?;
        let path = self.inner.root.join(rel);
        if !path.exists() {
            return Err(PluginError::invalid("离线文件已不存在"));
        }
        let kind = task.kind.clone();
        let playback_path = path.clone();
        drop(tasks);
        let mut out = serde_json::json!({
            "path": playback_path.to_string_lossy(),
            "downloadId": id,
        });
        out["kind"] = serde_json::to_value(&kind).unwrap_or(serde_json::Value::Null);
        if kind == DownloadKind::HlsMpegTs {
            let pkg = if path.is_file() {
                path.parent()
                    .ok_or_else(|| PluginError::invalid("HLS 路径无效"))?
                    .to_path_buf()
            } else {
                path.clone()
            };
            match hls_mpegts::validate_offline_package(&pkg) {
                Ok(()) => {
                    let index = pkg.join("index.m3u8");
                    let text = std::fs::read_to_string(&index)?;
                    let segments = text
                        .lines()
                        .filter(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#')
                        })
                        .count();
                    let has_key = text.contains("#EXT-X-KEY:METHOD=AES-128");
                    let key_ok = has_key
                        && text
                            .lines()
                            .find(|l| l.contains("#EXT-X-KEY:"))
                            .and_then(|l| hls_mpegts::key_uri_from_tag(l))
                            .map(|k| pkg.join(&k).is_file())
                            .unwrap_or(false);
                    out["packageValid"] = true.into();
                    out["segmentCount"] = segments.into();
                    out["aes128KeyPresent"] = key_ok.into();
                }
                Err(e) => {
                    out["packageValid"] = false.into();
                    out["validateError"] = e.message.into();
                }
            }
        }
        Ok(out)
    }

    pub fn local_playback_path(&self, id: &str) -> Result<std::path::PathBuf> {
        let tasks = self.inner.tasks.lock().unwrap();
        let task = tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| PluginError::invalid("找不到下载任务"))?;
        if task.state != DownloadState::Completed {
            return Err(PluginError::invalid("任务尚未完成"));
        }
        let rel = task
            .output_rel
            .as_ref()
            .ok_or_else(|| PluginError::internal("缺少输出路径"))?;
        let path = self.inner.root.join(rel);
        if !path.exists() {
            return Err(PluginError::invalid("离线文件已不存在"));
        }
        Ok(path)
    }

    pub async fn resume_interrupted(&self) {
        let ids: Vec<String> = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|t| matches!(t.state, DownloadState::Running | DownloadState::Queued))
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            let _ = self
                .set_state(&id, DownloadState::Queued, Some("进程恢复后将继续下载"))
                .await;
            self.kick(id).await;
        }
    }

    async fn set_state(
        &self,
        id: &str,
        state: DownloadState,
        error: Option<&str>,
    ) -> Result<()> {
        let mut tasks = self.inner.tasks.lock().unwrap();
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| PluginError::invalid("找不到下载任务"))?;
        let running = matches!(state, DownloadState::Running);
        task.state = state;
        task.updated_at = now();
        task.error = error.map(str::to_string);
        if !running {
            task.speed_bps = 0.0;
        }
        self.inner.store.save(&tasks)?;
        Ok(())
    }

    async fn fetch_cover(&self, id: &str, url: &str) -> Result<()> {
        let bytes = self
            .inner
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| PluginError::internal("封面下载失败"))?
            .bytes()
            .await
            .map_err(|_| PluginError::internal("封面下载失败"))?;
        if bytes.is_empty() {
            return Ok(());
        }
        let covers = self.inner.root.join("offline/covers");
        std::fs::create_dir_all(&covers)?;
        let rel = format!("offline/covers/{id}.img");
        let path = self.inner.root.join(&rel);
        std::fs::write(&path, &bytes)?;
        let mut tasks = self.inner.tasks.lock().unwrap();
        if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
            t.cover_rel = Some(rel);
            t.updated_at = now();
        }
        self.inner.store.save(&tasks)?;
        Ok(())
    }

    pub async fn attach_cover(&self, id: &str, url: &str) -> Result<()> {
        self.fetch_cover(id, url).await
    }

    async fn kick(&self, id: String) {
        let this = self.inner.clone();
        tokio::spawn(async move {
            let Ok(permit) = this.active.acquire().await else {
                return;
            };
            let manager = DownloadManager { inner: this.clone() };
            if manager.run_one(&id).await.is_err() {
                // state already recorded
            }
            drop(permit);
            manager.kick_next();
        });
    }

    fn kick_next(&self) {
        let next = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.state == DownloadState::Queued)
            .map(|t| t.id.clone());
        if let Some(id) = next {
            let manager = self.clone();
            tokio::spawn(async move {
                manager.kick(id).await;
            });
        }
    }

    async fn run_one(&self, id: &str) -> Result<()> {
        let snapshot = {
            let tasks = self.inner.tasks.lock().unwrap();
            tasks
                .iter()
                .find(|t| t.id == id)
                .cloned()
                .ok_or_else(|| PluginError::invalid("找不到下载任务"))?
        };
        if !matches!(snapshot.state, DownloadState::Queued) {
            return Ok(());
        }
        self.set_state(id, DownloadState::Running, None).await?;
        let flag = Arc::new(AtomicBool::new(false));
        self.inner
            .cancel_flags
            .lock()
            .unwrap()
            .insert(id.to_string(), flag.clone());
        let is_ts = snapshot.kind == DownloadKind::HlsMpegTs;
        let pkg_rel = format!("offline/pkg_{id}");
        let output_rel = snapshot.output_rel.clone().unwrap_or_else(|| {
            if is_ts {
                format!("{pkg_rel}/index.m3u8")
            } else {
                format!("offline/{}.mp4", sanitize(&snapshot.title))
            }
        });
        let temp_rel = snapshot
            .temp_rel
            .clone()
            .unwrap_or_else(|| if is_ts { pkg_rel.clone() } else { format!("offline/.{}.part", id) });
        let temp_path = self.inner.root.join(&temp_rel);
        let output_path = self.inner.root.join(&output_rel);
        {
            let mut tasks = self.inner.tasks.lock().unwrap();
            if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                t.temp_rel = Some(temp_rel.clone());
                t.output_rel = Some(output_rel.clone());
            }
            self.inner.store.save(&tasks)?;
        }
        let resume_from = if is_ts {
            0
        } else {
            temp_path.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let mut attempt = 0u32;
        let result: Result<u64> = loop {
            attempt += 1;
            let mut progress = self.progress_callback(&id, flag.clone());
            let run = match snapshot.kind {
                DownloadKind::ProgressiveMp4 => {
                    download_progressive(
                        &self.inner.client,
                        &snapshot.source_url,
                        &snapshot.headers,
                        &temp_path,
                        resume_from,
                        &mut progress,
                        &flag,
                    )
                    .await
                }
                DownloadKind::HlsFmp4 => {
                    download_fmp4_hls(
                        &self.inner.client,
                        &snapshot.source_url,
                        &snapshot.headers,
                        &temp_path,
                        resume_from,
                        &mut progress,
                        &flag,
                    )
                    .await
                }
                DownloadKind::HlsMpegTs => {
                    download_mpegts_hls(
                        &self.inner.client,
                        &snapshot.source_url,
                        &snapshot.headers,
                        &temp_path,
                        &mut progress,
                        &flag,
                    )
                    .await
                }
            };
            match run {
                Ok(bytes) => break Ok(bytes),
                Err(e) if e.code == "CANCELLED" => break Err(e),
                Err(e) if attempt >= MAX_RETRIES => break Err(e),
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
                }
            }
        };
        self.inner.cancel_flags.lock().unwrap().remove(id);
        match result {
            Ok(written) => {
                let bytes_done = if snapshot.kind == DownloadKind::HlsMpegTs {
                    hls_mpegts::validate_offline_package(&temp_path)?;
                    written
                } else {
                    std::fs::rename(&temp_path, &output_path)?;
                    hls::validate_mp4_atom(&std::fs::read(&output_path)?)?;
                    written
                };
                let mut tasks = self.inner.tasks.lock().unwrap();
                if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                    t.state = DownloadState::Completed;
                    t.bytes_done = bytes_done;
                    t.speed_bps = 0.0;
                    t.updated_at = now();
                    t.error = None;
                }
                self.inner.store.save(&tasks)?;
            }
            Err(e) => {
                let state = if e.code == "CANCELLED" {
                    DownloadState::Cancelled
                } else {
                    DownloadState::Failed
                };
                let mut tasks = self.inner.tasks.lock().unwrap();
                if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                    t.state = state;
                    t.error = Some(e.message.clone());
                    t.updated_at = now();
                }
                self.inner.store.save(&tasks)?;
                return Err(e);
            }
        }
        Ok(())
    }
}

async fn classify_url(
    client: &reqwest::Client,
    source_url: &str,
    headers: &HashMap<String, String>,
    source_format: Option<&str>,
) -> DownloadKind {
    let try_hls = source_format == Some("hls")
        || source_url.contains(".m3u8")
        || source_url.contains("mpegurl");
    if try_hls {
        let fmp4 = detect_fmp4_hls(client, source_url, headers).await;
        if fmp4.unwrap_or(false) {
            return DownloadKind::HlsFmp4;
        }
        let ts = detect_mpegts_hls(client, source_url, headers).await;
        if ts.unwrap_or(false) {
            return DownloadKind::HlsMpegTs;
        }
        if source_format == Some("hls") {
            return DownloadKind::HlsMpegTs;
        }
    }
    DownloadKind::ProgressiveMp4
}

impl DownloadManager {
    fn progress_callback(
        &self,
        id: &str,
        cancel: Arc<AtomicBool>,
    ) -> impl FnMut(u64, Option<u64>) -> bool {
        let inner = self.inner.clone();
        let id = id.to_string();
        let mut last_save = Instant::now();
        let mut last_bytes = 0u64;
        let mut last_tick = Instant::now();
        move |bytes_done, bytes_total| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            let now = Instant::now();
            let dt = now.duration_since(last_tick).as_secs_f64();
            let mut speed_sample = None::<f64>;
            if dt >= 0.2 {
                let delta = bytes_done.saturating_sub(last_bytes);
                last_bytes = bytes_done;
                last_tick = now;
                if dt > 0.0 {
                    speed_sample = Some(delta as f64 / dt);
                }
            }
            let mut tasks = inner.tasks.lock().unwrap();
            if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                t.bytes_done = bytes_done;
                if let Some(total) = bytes_total {
                    t.bytes_total = Some(total);
                }
                if let Some(sample) = speed_sample {
                    t.speed_bps = if t.speed_bps > 0.0 {
                        t.speed_bps * 0.65 + sample * 0.35
                    } else {
                        sample
                    };
                }
                t.updated_at = now_ms();
            }
            if last_save.elapsed().as_millis() >= 800 {
                let _ = inner.store.save(&tasks);
                last_save = Instant::now();
            }
            true
        }
    }
}

fn now_ms() -> u64 {
    crate::store::now()
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename() {
        assert_eq!(sanitize("EP 01: 试看"), "EP_01____");
    }
}