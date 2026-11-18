use crate::{PluginError, Result};
use reqwest::Client;
use std::{collections::HashMap, path::Path, time::Duration};
use url::Url;

pub async fn detect_fmp4_hls(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<bool> {
    let body = fetch_text(client, url, headers, None).await?;
    let (playlist, _base) = resolve_media_playlist(client, url, &body, headers).await?;
    Ok(playlist.contains("#EXT-X-MAP:") && !playlist.contains(".ts\n") && !playlist.contains(".ts\r"))
}

pub(super) async fn resolve_media_playlist(
    client: &Client,
    base: &str,
    body: &str,
    headers: &HashMap<String, String>,
) -> Result<(String, String)> {
    if body.contains("#EXT-X-STREAM-INF") {
        let line = body
            .lines()
            .find(|l| !l.starts_with('#') && !l.trim().is_empty())
            .ok_or_else(|| PluginError::invalid("HLS 主清单为空"))?;
        let child = resolve_url(base, line.trim())?;
        let child_body = fetch_text(client, &child, headers, None).await?;
        return Ok((child_body, child));
    }
    Ok((body.to_string(), base.to_string()))
}

pub async fn download_fmp4_hls(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    dest: &Path,
    resume_from: u64,
    on_progress: &mut impl FnMut(u64, Option<u64>) -> bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<u64> {
    let body = fetch_text(client, url, headers, None).await?;
    let (playlist, base) = resolve_media_playlist(client, url, &body, headers).await?;
    if playlist.contains(".ts") {
        return Err(PluginError::invalid(
            "当前仅支持非 DRM 的 fMP4/HLS（含 #EXT-X-MAP），不支持 MPEG-TS 分片",
        ));
    }
    let map_uri = playlist
        .lines()
        .find_map(|l| l.strip_prefix("#EXT-X-MAP:URI=\"").and_then(|r| r.strip_suffix('"')))
        .ok_or_else(|| PluginError::invalid("HLS 清单缺少 #EXT-X-MAP"))?;
    let init_url = resolve_url(&base, map_uri)?;
    let segments: Vec<String> = playlist
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| resolve_url(&base, l.trim()))
        .collect::<Result<Vec<_>>>()?;
    if segments.is_empty() {
        return Err(PluginError::invalid("HLS 清单没有媒体分片"));
    }

    let init_bytes = fetch_bytes(client, &init_url, headers, None).await?;
    validate_mp4_atom(&init_bytes)?;
    let mut written = resume_from;
    if resume_from == 0 {
        append_bytes(dest, &init_bytes)?;
        written += init_bytes.len() as u64;
        if !on_progress(written, None) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
    }
    let skip = if resume_from > init_bytes.len() as u64 {
        ((resume_from - init_bytes.len() as u64) / estimate_segment_size(&segments, client, headers).await?) as usize
    } else {
        0
    };
    for (index, seg_url) in segments.into_iter().enumerate().skip(skip) {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
        let bytes = fetch_bytes(client, &seg_url, headers, None).await?;
        validate_m4s_atom(&bytes)?;
        append_bytes(dest, &bytes)?;
        written += bytes.len() as u64;
        if !on_progress(written, None) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
        let _ = index;
    }
    validate_mp4_atom(&std::fs::read(dest)?)?;
    Ok(written)
}

async fn estimate_segment_size(
    segments: &[String],
    client: &Client,
    headers: &HashMap<String, String>,
) -> Result<u64> {
    if let Some(url) = segments.first() {
        let resp = head_size(client, url, headers).await?;
        return Ok(resp.max(1));
    }
    Ok(256 * 1024)
}

pub async fn download_progressive(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    dest: &Path,
    resume_from: u64,
    on_progress: &mut impl FnMut(u64, Option<u64>) -> bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<u64> {
    let total = head_size(client, url, headers).await?;
    let mut offset = resume_from;
    let chunk = 256 * 1024;
    while offset < total {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
        let end = (offset + chunk as u64 - 1).min(total - 1);
        let mut req = client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req
            .header("Range", format!("bytes={offset}-{end}"))
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| PluginError::new("NETWORK", "无法下载媒体流"))?;
        let status = resp.status();
        let has_range = resp.headers().contains_key("content-range");
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(PluginError::invalid("服务器不支持当前 Range 续传"));
        }
        let bytes = if status == reqwest::StatusCode::PARTIAL_CONTENT || status.is_success() {
            resp.bytes()
                .await
                .map_err(|_| PluginError::new("NETWORK", "读取响应失败"))?
        } else {
            return Err(PluginError::new(
                "NETWORK",
                format!("下载失败（HTTP {status}）"),
            ));
        };
        append_bytes(dest, &bytes)?;
        offset += bytes.len() as u64;
        if !on_progress(offset, Some(total)) {
            return Err(PluginError::new("CANCELLED", "下载已取消"));
        }
        if status.is_success() && !has_range {
            break;
        }
    }
    let data = std::fs::read(dest)?;
    validate_mp4_atom(&data)?;
    Ok(offset)
}

pub fn validate_mp4_atom(data: &[u8]) -> Result<()> {
    if data.len() < 8 {
        return Err(PluginError::invalid("不是有效的 MP4 容器"));
    }
    let brand = &data[4..8];
    if brand != b"ftyp" && brand != b"styp" && brand != b"moov" && brand != b"moof" {
        // walk first box
        let mut i = 0usize;
        while i + 8 <= data.len() {
            let size = u32::from_be_bytes(data[i..i + 4].try_into().unwrap()) as usize;
            let typ = &data[i + 4..i + 8];
            if typ == b"ftyp" || typ == b"moov" || typ == b"moof" {
                return Ok(());
            }
            if size < 8 {
                break;
            }
            i += size;
        }
        return Err(PluginError::invalid("不是有效的 MP4 容器"));
    }
    Ok(())
}

fn validate_m4s_atom(data: &[u8]) -> Result<()> {
    validate_mp4_atom(data)
}

fn append_bytes(dest: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut file = open_append(dest, dest.metadata().map(|m| m.len()).unwrap_or(0))?;
    file.seek(SeekFrom::End(0))?;
    file.write_all(bytes)?;
    Ok(())
}

fn open_append(dest: &Path, resume_from: u64) -> Result<std::fs::File> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dest)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::StorageFull {
                PluginError::new("DISK_FULL", "存储空间不足")
            } else {
                PluginError::internal("无法写入缓存文件")
            }
        })?;
    if resume_from > 0 {
        file.set_len(resume_from.max(file.metadata().map(|m| m.len()).unwrap_or(0)))
            .map_err(|_| PluginError::internal("无法续传临时文件"))?;
    }
    Ok(file)
}

async fn head_size(client: &Client, url: &str, headers: &HashMap<String, String>) -> Result<u64> {
    let mut req = client.head(url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| PluginError::new("NETWORK", "无法探测媒体大小"))?;
    if let Some(len) = resp.headers().get(reqwest::header::CONTENT_LENGTH) {
        if let Ok(v) = len.to_str() {
            if let Ok(n) = v.parse::<u64>() {
                return Ok(n);
            }
        }
    }
    // fallback GET first byte range
    let mut get = client.get(url);
    for (k, v) in headers {
        get = get.header(k, v);
    }
    let resp = get
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|_| PluginError::new("NETWORK", "无法探测媒体大小"))?;
    if let Some(v) = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(total) = v.split('/').nth(1) {
            if let Ok(n) = total.parse::<u64>() {
                return Ok(n);
            }
        }
    }
    Ok(resp.content_length().unwrap_or(0))
}

pub(super) async fn fetch_text(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    range: Option<&str>,
) -> Result<String> {
    let bytes = fetch_bytes(client, url, headers, range).await?;
    String::from_utf8(bytes).map_err(|_| PluginError::invalid("HLS 清单编码无效"))
}

pub(super) async fn fetch_bytes(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    range: Option<&str>,
) -> Result<Vec<u8>> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(range) = range {
        req = req.header("Range", range);
    }
    let resp = req
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| PluginError::new("NETWORK", "网络请求失败"))?;
    if !resp.status().is_success() {
        return Err(PluginError::new(
            "NETWORK",
            format!("请求失败（HTTP {}）", resp.status()),
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| PluginError::new("NETWORK", "读取响应失败"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(PluginError::invalid("响应过大"));
    }
    Ok(bytes.to_vec())
}

pub(super) fn resolve_url(base: &str, rel: &str) -> Result<String> {
    Url::parse(base)
        .and_then(|b| b.join(rel))
        .map(|u| u.to_string())
        .map_err(|_| PluginError::invalid("HLS URL 无效"))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn rejects_non_mp4_magic() {
        assert!(validate_mp4_atom(b"not-a-video").is_err());
        let sample: &[u8] = &[
            0, 0, 0, 20, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0,
            b'i', b's', b'o', b'm',
        ];
        assert!(validate_mp4_atom(sample).is_ok());
    }
}