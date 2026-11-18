use hghub_hpp::{
    media_download::{DownloadKind, DownloadManager, WorkCacheMeta},
    PluginError, Result,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueParams {
    title: String,
    episode_label: Option<String>,
    source_url: String,
    headers: Option<HashMap<String, String>>,
    kind: Option<DownloadKind>,
    media_format: Option<String>,
    plugin_id: Option<String>,
    media_id: Option<String>,
    episode_id: Option<String>,
    episode_index: Option<u32>,
    episode_count: Option<u32>,
    cover_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertWorkMetaParams {
    plugin_id: String,
    media_id: String,
    title: String,
    plugin_name: Option<String>,
    year: Option<u32>,
    episode_count: Option<u32>,
    description: Option<String>,
    score: Option<f64>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachCoverDataParams {
    id: String,
    data_base64: String,
}

fn enrich_task(manager: &DownloadManager, t: &hghub_hpp::media_download::DownloadTask) -> Value {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    if let (Some(rel), Some(obj)) = (&t.cover_rel, v.as_object_mut()) {
        if let Ok(path) = manager.cover_local_path(rel) {
            obj.insert(
                "coverLocalPath".into(),
                Value::String(path.to_string_lossy().into_owned()),
            );
        }
    }
    if let (Some(obj), Some(plugin_id), Some(media_id)) = (
        v.as_object_mut(),
        t.plugin_id.as_deref(),
        t.media_id.as_deref(),
    ) {
        if let Some(path) = manager.work_cover_local_path(plugin_id, media_id) {
            obj.insert(
                "workCoverLocalPath".into(),
                Value::String(path.to_string_lossy().into_owned()),
            );
        }
    }
    v
}

#[tauri::command]
pub async fn download_manage(
    manager: State<'_, Arc<DownloadManager>>,
    action: String,
    params: Value,
) -> Result<Value> {
    match action.as_str() {
        "list" => {
            let tasks = manager.list().await;
            let enriched: Vec<Value> = tasks.iter().map(|t| enrich_task(&manager, t)).collect();
            let works = manager.list_work_meta();
            let work_covers: HashMap<String, String> = works
                .iter()
                .filter_map(|(key, meta)| {
                    meta.cover_rel.as_ref().and_then(|rel| {
                        manager
                            .cover_local_path(rel)
                            .ok()
                            .map(|p| (key.clone(), p.to_string_lossy().into_owned()))
                    })
                })
                .collect();
            Ok(json!({ "tasks": enriched, "works": works, "workCovers": work_covers }))
        }
        "upsertWorkMeta" => {
            let p: UpsertWorkMetaParams = serde_json::from_value(params)
                .map_err(|_| PluginError::invalid("作品元数据无效"))?;
            let meta = WorkCacheMeta {
                plugin_id: p.plugin_id,
                media_id: p.media_id,
                title: p.title,
                plugin_name: p.plugin_name,
                year: p.year,
                episode_count: p.episode_count,
                description: p.description,
                score: p.score,
                tags: p.tags.unwrap_or_default(),
                cover_rel: None,
                updated_at: {
                    use std::time::{SystemTime, UNIX_EPOCH};
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                },
            };
            manager.upsert_work_meta(meta)?;
            Ok(Value::Null)
        }
        "attachCoverData" => {
            let p: AttachCoverDataParams = serde_json::from_value(params)
                .map_err(|_| PluginError::invalid("封面数据无效"))?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(p.data_base64.as_bytes())
                .map_err(|_| PluginError::invalid("封面数据无效"))?;
            manager.attach_cover_data(&p.id, data).await?;
            Ok(Value::Null)
        }
        "enqueue" => {
            let p: EnqueueParams = serde_json::from_value(params)
                .map_err(|_| PluginError::invalid("下载参数无效"))?;
            Ok(json!(
                manager
                    .enqueue(
                        p.title,
                        p.episode_label,
                        p.source_url,
                        p.headers.unwrap_or_default(),
                        p.kind,
                        p.media_format.as_deref(),
                        p.plugin_id,
                        p.media_id,
                        p.episode_id,
                        p.episode_index,
                        p.episode_count,
                        p.cover_url,
                    )
                    .await?
            ))
        }
        "pause" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            manager.pause(id).await?;
            Ok(Value::Null)
        }
        "resume" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            manager.resume(id).await?;
            Ok(Value::Null)
        }
        "cancel" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            manager.cancel(id).await?;
            Ok(Value::Null)
        }
        "remove" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            manager.remove(id).await?;
            Ok(Value::Null)
        }
        "localPath" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            Ok(json!(manager.local_playback_path(id)?.to_string_lossy()))
        }
        "preparePlayback" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            Ok(manager.prepare_playback(id)?)
        }
        "offlineHlsRead" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            let resource = params["resource"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 resource"))?;
            Ok(manager.offline_hls_read(id, resource)?)
        }
        "attachCover" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 id"))?;
            let url = params["coverUrl"]
                .as_str()
                .ok_or_else(|| PluginError::invalid("缺少 coverUrl"))?;
            manager.attach_cover(id, url).await?;
            Ok(Value::Null)
        }
        _ => Err(PluginError::new("UNSUPPORTED", "未知下载操作")),
    }
}