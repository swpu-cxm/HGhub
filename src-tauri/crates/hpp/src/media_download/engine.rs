use super::{
    hls::{self, download_fmp4_hls, download_progressive, detect_fmp4_hls},
    progress::{DownloadKind, DownloadState, DownloadTask},
    store::DownloadStore,
};
use crate::{store::now, PluginError, Result};
use reqwest::Client;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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

    pub async fn enqueue(
        &self,
        title: String,
        episode_label: Option<String>,
        source_url: String,
        headers: HashMap<String, String>,
        kind: Option<DownloadKind>,
    ) -> Result<DownloadTask> {
        let mut tasks = self.inner.tasks.lock().unwrap();
        if tasks.iter().any(|t| {
            t.source_url == source_url
                && t.state != DownloadState::Cancelled
                && t.state != DownloadState::Failed
        }) {
            return Err(PluginError::invalid("相同地址已有进行中的下载任务"));
        }
        let kind = match kind {
            Some(k) => k,
            None => {
                if detect_fmp4_hls(&self.inner.client, &source_url, &headers)
                    .await
                    .unwrap_or(false)
                {
                    DownloadKind::HlsFmp4
                } else {
                    DownloadKind::ProgressiveMp4
                }
            }
        };
        let id = Uuid::new_v4().to_string();
        let ts = now();
        let task = DownloadTask::new(id.clone(), title, episode_label, source_url, kind, headers, ts);
        tasks.push(task.clone());
        self.inner.store.save(&tasks)?;
        drop(tasks);
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
            let path = self.inner.root.join(rel);
            let _ = std::fs::remove_file(path);
        }
        Ok(())
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
        task.state = state;
        task.updated_at = now();
        task.error = error.map(str::to_string);
        self.inner.store.save(&tasks)?;
        Ok(())
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
        let temp_rel = snapshot
            .temp_rel
            .clone()
            .unwrap_or_else(|| format!("offline/.{}.part", id));
        let output_rel = snapshot
            .output_rel
            .clone()
            .unwrap_or_else(|| format!("offline/{}.mp4", sanitize(&snapshot.title)));
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
        let resume_from = temp_path.metadata().map(|m| m.len()).unwrap_or(0);
        let noop = |_: u64, _: Option<u64>| !flag.load(Ordering::Relaxed);
        let mut attempt = 0u32;
        let result = loop {
            attempt += 1;
            let mut progress = noop;
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
            };
            match run {
                Ok(_) => break Ok(()),
                Err(e) if e.code == "CANCELLED" => break Err(e),
                Err(e) if attempt >= MAX_RETRIES => break Err(e),
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
                }
            }
        };
        self.inner.cancel_flags.lock().unwrap().remove(id);
        match result {
            Ok(()) => {
                std::fs::rename(&temp_path, &output_path)?;
                hls::validate_mp4_atom(&std::fs::read(&output_path)?)?;
                let mut tasks = self.inner.tasks.lock().unwrap();
                if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                    t.state = DownloadState::Completed;
                    t.bytes_done = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
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