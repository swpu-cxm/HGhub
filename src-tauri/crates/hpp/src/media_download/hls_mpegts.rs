use super::hls::{fetch_bytes, fetch_text, resolve_media_playlist, resolve_url};
use crate::{PluginError, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsProgress {
    next_segment: usize,
    bytes_done: u64,
    #[serde(default)]
    durations: Vec<f64>,
    #[serde(default)]
    local_names: Vec<String>,
    #[serde(default)]
    aes_key_file: Option<String>,
    #[serde(default)]
    aes_key_iv: Option<String>,
}

#[derive(Clone)]
struct MediaSegment {
    duration: f64,
    uri: String,
}

#[derive(Clone)]
struct Aes128Key {
    uri: String,
    iv: String,
    local_name: String,
}

pub async fn detect_mpegts_hls(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<bool> {
    let body = fetch_text(client, url, headers, None).await?;
    let (playlist, base) = resolve_media_playlist(client, url, &body, headers).await?;
    if playlist.contains("#EXT-X-MAP:") {
        return Ok(false);
    }
    parse_stream_key(&playlist, &base)?;
    let segs = parse_media_segments(&playlist, &base)?;
    Ok(!segs.is_empty()
        && segs.iter().any(|s| s.uri.ends_with(".ts") || s.uri.contains(".ts?")))
}

pub async fn download_mpegts_hls(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    package_dir: &Path,
    on_progress: &mut impl FnMut(u64, Option<u64>) -> bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<u64> {
    std::fs::create_dir_all(package_dir)?;
    let body = fetch_text(client, url, headers, None).await?;
    let (playlist, base) = resolve_media_playlist(client, url, &body, headers).await?;
    let stream_key = parse_stream_key(&playlist, &base)?;
    if playlist.contains("#EXT-X-MAP:") {
        return Err(PluginError::invalid("该 HLS 为 fMP4 分片，请使用 fMP4 缓存模式"));
    }
    if playlist.to_ascii_lowercase().contains("byterange") {
        return Err(PluginError::invalid("当前不支持 #EXT-X-BYTERANGE / I-frame 专用清单"));
    }
    let segments = parse_media_segments(&playlist, base.as_str())?;
    if segments.is_empty() {
        return Err(PluginError::invalid("HLS 清单没有可下载的 TS 分片"));
    }

    let state_path = package_dir.join(".download_state.json");
    let mut state: TsProgress = if state_path.exists() {
        serde_json::from_slice(&std::fs::read(&state_path)?)
            .map_err(|_| PluginError::internal("TS 缓存进度损坏"))?
    } else {
        TsProgress {
            next_segment: 0,
            bytes_done: 0,
            durations: Vec::new(),
            local_names: Vec::new(),
            aes_key_file: None,
            aes_key_iv: None,
        }
    };

    if let Some(key) = &stream_key {
        if state.aes_key_file.is_none() {
            let bytes = fetch_bytes(client, &key.uri, headers, None).await?;
            if bytes.is_empty() {
                return Err(PluginError::invalid("AES-128 密钥为空"));
            }
            let path = package_dir.join(&key.local_name);
            std::fs::write(&path, &bytes)?;
            state.aes_key_file = Some(key.local_name.clone());
            state.aes_key_iv = Some(key.iv.clone());
            atomic_write_json(&state_path, &state)?;
        }
    }

    let encrypted = state.aes_key_file.is_some();
    for (index, segment) in segments.iter().enumerate().skip(state.next_segment) {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
        let local = format!("seg{:05}.ts", index);
        let part = package_dir.join(&local);
        let seg_url = &segment.uri;
        let bytes = fetch_bytes(client, &seg_url, headers, None).await?;
        if !encrypted {
            validate_mpeg_ts(&bytes)?;
        } else if bytes.is_empty() {
            return Err(PluginError::invalid("TS 分片为空"));
        }
        std::fs::write(&part, &bytes)?;
        state.bytes_done += bytes.len() as u64;
        state.durations.push(segment.duration);
        state.local_names.push(local);
        state.next_segment = index + 1;
        atomic_write_json(&state_path, &state)?;
        if !on_progress(state.bytes_done, None) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
    }

    let playlist_path = package_dir.join("index.m3u8");
    write_local_playlist(&playlist_path, &state)?;
    validate_offline_package(package_dir)?;
    Ok(state.bytes_done)
}

fn parse_media_segments(playlist: &str, base: &str) -> Result<Vec<MediaSegment>> {
    let mut out = Vec::new();
    let mut pending_duration: Option<f64> = None;
    for line in playlist.lines() {
        let line = line.trim();
        if line.starts_with("#EXTINF:") {
            let raw = line.trim_start_matches("#EXTINF:").split(',').next().unwrap_or("0");
            pending_duration = Some(raw.parse().unwrap_or(0.0));
            continue;
        }
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let duration = pending_duration.take().unwrap_or(0.0);
        let uri = if line.contains("://") {
            line.to_string()
        } else {
            resolve_url(base, line)?
        };
        out.push(MediaSegment { duration, uri });
    }
    Ok(out)
}

fn tag_attr(rest: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    for part in rest.split(',') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&needle) {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn parse_stream_key(playlist: &str, base: &str) -> Result<Option<Aes128Key>> {
    for line in playlist.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let upper = rest.to_ascii_uppercase();
            if upper.contains("METHOD=NONE") {
                continue;
            }
            if !upper.contains("METHOD=AES-128") {
                return Err(PluginError::invalid(
                    "仅支持 AES-128 离线缓存；不支持 SAMPLE-AES / DRM",
                ));
            }
            let uri = tag_attr(rest, "URI")
                .ok_or_else(|| PluginError::invalid("AES-128 清单缺少密钥 URI"))?;
            let iv = tag_attr(rest, "IV").unwrap_or_else(|| "0x0".into());
            let resolved = if uri.contains("://") {
                uri
            } else {
                resolve_url(base, &uri)?
            };
            return Ok(Some(Aes128Key {
                uri: resolved,
                iv,
                local_name: "aes128.key".into(),
            }));
        }
    }
    Ok(None)
}

fn validate_mpeg_ts(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Err(PluginError::invalid("TS 分片为空"));
    }
    if bytes[0] != 0x47 {
        return Err(PluginError::invalid("TS 分片缺少 0x47 同步字节"));
    }
    Ok(())
}

fn write_local_playlist(path: &Path, state: &TsProgress) -> Result<()> {
    let mut body = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n");
    let target = state.durations.iter().cloned().fold(1.0_f64, f64::max).ceil() as u64;
    body.push_str(&format!("#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n"));
    if let (Some(name), Some(iv)) = (&state.aes_key_file, &state.aes_key_iv) {
        body.push_str(&format!(
            "#EXT-X-KEY:METHOD=AES-128,URI=\"{name}\",IV={iv}\n"
        ));
    }
    for (name, duration) in state.local_names.iter().zip(state.durations.iter()) {
        body.push_str(&format!("#EXTINF:{duration:.3},\n{name}\n"));
    }
    body.push_str("#EXT-X-ENDLIST\n");
    std::fs::write(path, body)?;
    Ok(())
}

pub fn validate_offline_package(dir: &Path) -> Result<()> {
    let index = dir.join("index.m3u8");
    if !index.is_file() {
        return Err(PluginError::invalid("离线包缺少 index.m3u8"));
    }
    let text = std::fs::read_to_string(&index)?;
    let encrypted = text.contains("#EXT-X-KEY:METHOD=AES-128");
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let part = dir.join(line.trim());
        if !part.is_file() {
            return Err(PluginError::invalid("离线清单引用了缺失分片"));
        }
        if !encrypted {
            let bytes = std::fs::read(&part)?;
            validate_mpeg_ts(&bytes)?;
        }
    }
    if encrypted {
        let key_line = text
            .lines()
            .find(|l| l.contains("#EXT-X-KEY:"))
            .ok_or_else(|| PluginError::invalid("AES 离线包缺少密钥标签"))?;
        let key_name = tag_attr(key_line.trim_start_matches("#EXT-X-KEY:"), "URI")
            .ok_or_else(|| PluginError::invalid("AES 离线包密钥 URI 无效"))?;
        let key_path = dir.join(key_name);
        if !key_path.is_file() || key_path.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            return Err(PluginError::invalid("AES 离线包缺少密钥文件"));
        }
    }
    Ok(())
}

fn atomic_write_json(path: &PathBuf, state: &TsProgress) -> Result<()> {
    let tmp = path.with_extension("json.part");
    std::fs::write(
        &tmp,
        serde_json::to_vec(state).map_err(|_| PluginError::internal("无法写入进度"))?,
    )?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub(super) fn remove_package(root: &Path, rel: &str) -> Result<()> {
    let path = root.join(rel);
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else if let Some(parent) = path.parent() {
        if parent
            .file_name()
            .map(|n| n.to_string_lossy().starts_with("pkg_"))
            .unwrap_or(false)
        {
            std::fs::remove_dir_all(parent)?;
            return Ok(());
        }
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aes128_key_from_manifest() {
        let key = parse_stream_key(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"enc.key\",IV=0x1\n",
            "https://cdn.example/v/",
        )
        .unwrap()
        .expect("key");
        assert_eq!(key.local_name, "aes128.key");
        assert_eq!(key.iv, "0x1");
    }

    #[test]
    fn rejects_sample_aes() {
        let err = parse_stream_key(
            "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://drm\"\n",
            "https://cdn.example/",
        )
        .unwrap_err();
        assert!(err.message.contains("SAMPLE-AES"));
    }
}