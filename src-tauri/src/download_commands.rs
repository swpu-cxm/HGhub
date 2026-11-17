use hghub_hpp::{
    media_download::{DownloadKind, DownloadManager},
    PluginError, Result,
};
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
}

#[tauri::command]
pub async fn download_manage(
    manager: State<'_, Arc<DownloadManager>>,
    action: String,
    params: Value,
) -> Result<Value> {
    match action.as_str() {
        "list" => Ok(json!(manager.list().await)),
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
                        p.kind
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
        _ => Err(PluginError::new("UNSUPPORTED", "未知下载操作")),
    }
}