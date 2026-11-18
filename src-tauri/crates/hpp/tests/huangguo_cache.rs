//! 黄果短剧「琼明神女录」离线缓存全链路（网络依赖）。
//! 复现用户路径：搜索 → 详情 → media.resolvePlayback(第 2 集) → DownloadManager::enqueue → 持久化 → 下载完成。
use hghub_hpp::media_download::{DownloadManager, DownloadState};
use hghub_hpp::PluginManager;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, time::Instant};

fn plugin_source() -> PathBuf {
    if let Ok(path) = std::env::var("HGHUB_HUANGGUO_PLUGIN") {
        return PathBuf::from(path);
    }
    for candidate in [
        "/tmp/hghub-plugins/plugins/huangguo.js",
        "/agent/repos/hghub-plugins/plugins/huangguo.js",
    ] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return p;
        }
    }
    panic!("未找到黄果插件源文件；请设置 HGHUB_HUANGGUO_PLUGIN 或 clone swpu-cxm/hghub-plugins");
}

fn ffmpeg_offline_hls_decode(pkg_dir: &std::path::Path, seconds: u32) -> Result<(), String> {
    let index = pkg_dir.join("index.m3u8");
    let key = pkg_dir.join("aes128.key");
    if !key.is_file() {
        return Err("缺少 aes128.key".into());
    }
    let ok = std::process::Command::new("ffmpeg")
        .current_dir(pkg_dir)
        .args([
            "-v",
            "error",
            "-allowed_extensions",
            "ALL",
            "-i",
            index.file_name().unwrap().to_str().unwrap(),
            "-t",
            &seconds.to_string(),
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("无法启动 ffmpeg: {e}"))?;
    if ok.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&ok.stderr).trim().into())
}

fn headers_of(stream: &Value) -> HashMap<String, String> {
    let Some(obj) = stream.get("headers").and_then(Value::as_object) else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}

#[tokio::test]
async fn resolve_playback_requires_request_id() {
    let dir = tempfile::tempdir().unwrap();
    let manager = PluginManager::open(dir.path().into()).unwrap();
    let code = fs::read_to_string(plugin_source()).unwrap();
    let info = manager.import_code(code.into(), None, false).await.unwrap();
    assert_eq!(info.status, "ready", "{:?}", info.error);
    let err = manager
        .call(
            &info.meta.id,
            "media.resolvePlayback",
            json!({"mediaId": "x", "playlistId": "p", "episodeId": "1"}),
            String::new(),
        )
        .await
        .unwrap_err();
    assert!(
        err.message.contains("requestId"),
        "expected missing requestId error, got {:?}",
        err
    );
}

#[tokio::test]
#[ignore = "网络依赖：黄果短剧 琼明神女录 第 2 集真实缓存"]
async fn huangguo_qiongming_episode2_offline_cache() {
    let dir = tempfile::tempdir().unwrap();
    let hpp_root = dir.path().join("hpp");
    let plugins = PluginManager::open(hpp_root.clone()).unwrap();
    let code = fs::read_to_string(plugin_source()).unwrap();
    let info = plugins.import_code(code.into(), None, false).await.unwrap();
    assert_eq!(info.status, "ready", "{:?}", info.error);
    let id = info.meta.id.clone();

    let search = plugins
        .call(&id, "search.search", json!({"query": "琼明神女录"}), "hg-search".into())
        .await
        .unwrap();
    let items = search["items"].as_array().expect("搜索结果应为数组");
    assert!(!items.is_empty(), "搜索「琼明神女录」无结果");
    let media_id = items[0]["id"].as_str().expect("条目缺少 id").to_string();
    let title = items[0]["title"].as_str().unwrap_or("琼明神女录").to_string();
    eprintln!("选中作品 id={media_id} title={title}");

    let detail = plugins
        .call(
            &id,
            "media.getDetail",
            json!({"id": media_id}),
            "hg-detail".into(),
        )
        .await
        .unwrap();
    let episodes = detail["playlists"][0]["episodes"]
        .as_array()
        .expect("分集列表");
    let ep2 = episodes
        .iter()
        .find(|e| e["id"].as_str() == Some("2") || e["index"].as_u64() == Some(2))
        .expect("未找到第 2 集");
    let episode_id = ep2["id"].as_str().unwrap().to_string();
    eprintln!("缓存分集 episodeId={episode_id}");

    let playback = plugins
        .call(
            &id,
            "media.resolvePlayback",
            json!({
                "mediaId": media_id,
                "episodeId": episode_id,
                "playlistId": "main",
            }),
            "hg-playback".into(),
        )
        .await
        .unwrap();
    let streams = playback["streams"].as_array().expect("streams");
    assert!(!streams.is_empty(), "resolvePlayback 未返回流");
    let downloads = DownloadManager::open(hpp_root.clone()).unwrap();
    let mut failures: Vec<String> = Vec::new();
    for (index, stream) in streams.iter().enumerate() {
        let url = stream["url"].as_str().expect("流缺少 url");
        let format = stream["format"].as_str().unwrap_or("hls");
        let label = stream["label"].as_str().unwrap_or("默认");
        let headers = headers_of(stream);
        let url_host = url.split('/').nth(2).unwrap_or("(unknown)");
        eprintln!(
            "尝试线路 {index} ({label}): format={format} host={url_host} headers={} 项",
            headers.len()
        );

        let started = Instant::now();
        let task = match downloads
            .enqueue(
                title.clone(),
                Some(format!("第 {episode_id} 集 · {label}")),
                url.to_string(),
                headers,
                None,
                Some(format),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
        {
            Ok(t) => t,
            Err(e) => {
                failures.push(format!("{label}: enqueue — {}", e.message));
                continue;
            }
        };
        eprintln!("任务入队 id={} kind={:?}", task.id, task.kind);

        let list_after_enqueue = downloads.list().await;
        assert!(
            list_after_enqueue.iter().any(|t| t.id == task.id),
            "入队后 list 应含任务"
        );
        assert!(
            std::fs::exists(hpp_root.join("downloads.json")).unwrap_or(false),
            "downloads.json 未持久化"
        );

        let mut last_state = DownloadState::Queued;
        let mut terminal = None;
        for _ in 0..600 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let current = downloads
                .list()
                .await
                .into_iter()
                .find(|t| t.id == task.id)
                .expect("任务从 list 消失");
            if current.state != last_state {
                eprintln!(
                    "  {:.0}s state={:?} bytes={} err={:?}",
                    started.elapsed().as_secs_f32(),
                    current.state,
                    current.bytes_done,
                    current.error
                );
                last_state = current.state.clone();
            }
            if matches!(
                current.state,
                DownloadState::Completed | DownloadState::Failed | DownloadState::Cancelled
            ) {
                terminal = Some(current);
                break;
            }
        }
        let Some(done) = terminal else {
            failures.push(format!("{label}: 下载超时"));
            let _ = downloads.remove(&task.id).await;
            continue;
        };
        if done.state != DownloadState::Completed {
            failures.push(format!(
                "{label}: {:?}",
                done.error.unwrap_or_else(|| "unknown".into())
            ));
            let _ = downloads.remove(&task.id).await;
            continue;
        }
        assert!(done.bytes_done > 0, "未下载任何字节");
        let out = hpp_root.join(done.output_rel.as_ref().unwrap());
        assert!(out.exists(), "输出文件不存在: {}", out.display());
        if format == "hls" {
            let index = std::fs::read_to_string(&out).expect("读取 m3u8");
            assert!(index.contains("#EXTM3U"), "离线包缺少 m3u8 头");
            let pkg = out.parent().expect("pkg dir");
            let ts_count = std::fs::read_dir(pkg)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "ts"))
                .count();
            assert!(ts_count > 0, "离线包应含 .ts 分片");
            eprintln!("离线包: {} 个 TS 分片, index 共 {} 字节", ts_count, index.len());
        }
            let pkg = out.parent().expect("pkg");
            ffmpeg_offline_hls_decode(pkg, 8).expect("ffmpeg 无法解码离线 AES-128 HLS（含密钥与分片引用）");
            ffmpeg_offline_hls_decode(pkg, 3).expect("ffmpeg 重试短采样失败");
            eprintln!(
                "黄果缓存验收通过（线路 {label}, {:.1}s, ffmpeg 解码 OK, {} 字节）",
                started.elapsed().as_secs_f32(),
                done.bytes_done
            );
            return;
    }
    panic!(
        "所有播放线路均无法离线缓存；详情:\n{}",
        failures.join("\n")
    );
}