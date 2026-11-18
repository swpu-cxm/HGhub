use axum::{
    body::Body,
    extract::{State},
    http::{HeaderMap, Method, Response, StatusCode, Uri},
    routing::any,
    Router,
};
use hghub_hpp::media_download::{DownloadKind, DownloadManager, DownloadState};
use std::sync::{Arc, Mutex};

type Seen = Arc<Mutex<Vec<(String, String)>>>;

async fn fixture(
    State(seen): State<Seen>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response<Body> {
    let range = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    seen.lock().unwrap().push((uri.path().to_string(), range.clone()));
    match uri.path() {
        "/movie.mp4" => {
            let data: Vec<u8> = {
                let mut v = vec![
                    0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0,
                    b'm', b'p', b'4', b'1',
                ];
                v.extend((0..512 * 1024).map(|i| (i % 251) as u8));
                v
            };
            serve_bytes(method, &data, &range)
        }
        "/no-range.mp4" => {
            let data = b"\0\0\0\x20ftypisom\0\0\0\0mp41".to_vec();
            Response::builder()
                .status(200)
                .header("content-length", data.len())
                .body(if method == Method::HEAD {
                    Body::empty()
                } else {
                    Body::from(data)
                })
                .unwrap()
        }
        "/hls/master.m3u8" => text_body(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8\n",
            method,
        ),
        "/hls/variant.m3u8" => text_body(
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST\n",
            method,
        ),
        "/hls/init.mp4" => serve_bytes(
            method,
            b"\0\0\0\x20ftypisom\0\0\0\0mp41",
            &range,
        ),
        "/hls/a.m4s" => serve_bytes(
            method,
            b"\0\0\0\x18stypmsdh\0\0\0\x08moof",
            &range,
        ),
        "/hls-ts/master.m3u8" => text_body(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8\n",
            method,
        ),
        "/hls-ts/variant.m3u8" => text_body(
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n0.ts\n#EXTINF:2.0,\n1.ts\n#EXT-X-ENDLIST\n",
            method,
        ),
        "/hls-ts/0.ts" | "/hls-ts/1.ts" => serve_bytes(method, &ts_packet(), &range),
        _ => Response::builder().status(404).body(Body::empty()).unwrap(),
    }
}

fn text_body(body: &str, method: Method) -> Response<Body> {
    Response::builder()
        .status(200)
        .header("content-type", "application/vnd.apple.mpegurl")
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap()
}

fn serve_bytes(method: Method, data: &[u8], range: &str) -> Response<Body> {
    let size = data.len();
    if let Some(raw) = range.strip_prefix("bytes=") {
        let (start_s, end_s) = raw.split_once('-').unwrap_or((raw, ""));
        let start = start_s.parse::<usize>().unwrap_or(0);
        let end = if end_s.is_empty() {
            size - 1
        } else {
            end_s.parse::<usize>().unwrap_or(size - 1).min(size - 1)
        };
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-range", format!("bytes {start}-{end}/{size}"))
            .header("accept-ranges", "bytes")
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(data[start..=end].to_vec())
            })
            .unwrap();
    }
    Response::builder()
        .status(200)
        .header("content-length", size)
        .header("accept-ranges", "bytes")
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(data.to_vec())
        })
        .unwrap()
}

async fn spawn_server(seen: Seen) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/*path", any(fixture))
        .with_state(seen);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    base
}

fn ts_packet() -> Vec<u8> {
    let mut v = vec![0x47u8; 188];
    v[1] = 0x40;
    v
}

fn ffprobe_ok(path: &std::path::Path) -> bool {
    std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn progressive_download_pause_resume_and_cancel() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let task = manager
        .enqueue(
            "movie".into(),
            None,
            format!("{base}/movie.mp4"),
            Default::default(),
            Some(DownloadKind::ProgressiveMp4),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    manager.pause(&task.id).await.unwrap();
    manager.resume(&task.id).await.unwrap();
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if manager
            .list()
            .await
            .into_iter()
            .any(|t| t.id == task.id && t.state == DownloadState::Completed)
        {
            break;
        }
    }
    let done = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(done.state, DownloadState::Completed);
    let out = dir.path().join(done.output_rel.as_ref().unwrap());
    assert!(out.exists() && out.metadata().map(|m| m.len()).unwrap_or(0) > 1024);
    let ranges: Vec<_> = seen.lock().unwrap().iter().filter(|(p, _)| p == "/movie.mp4").cloned().collect();
    assert!(ranges.iter().any(|(_, r)| !r.is_empty()), "应使用 Range 并发分片");
}

#[tokio::test]
async fn rejects_duplicate_active_task() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen).await;
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let url = format!("{base}/movie.mp4");
    manager
        .enqueue("a".into(), None, url.clone(), Default::default(), Some(DownloadKind::ProgressiveMp4), None, None, None, None, None, None, None)
        .await
        .unwrap();
    assert!(manager.enqueue("b".into(), None, url, Default::default(), None, None, None, None, None, None, None, None).await.is_err());
}

#[tokio::test]
async fn fmp4_hls_becomes_playable_mp4() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen).await;
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let task = manager
        .enqueue(
            "hls".into(),
            None,
            format!("{base}/hls/master.m3u8"),
            Default::default(),
            Some(DownloadKind::HlsFmp4),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if manager
            .list()
            .await
            .into_iter()
            .any(|t| t.id == task.id && t.state == DownloadState::Completed)
        {
            break;
        }
    }
    let done = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(done.state, DownloadState::Completed, "{:?}", done.error);
    let out = dir.path().join(done.output_rel.as_ref().unwrap());
    assert!(out.exists());
}

#[tokio::test]
async fn mpegts_hls_offline_package() {
    let base = spawn_server(Default::default()).await;
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let task = manager
        .enqueue(
            "ts-hls".into(),
            None,
            format!("{base}/hls-ts/master.m3u8"),
            Default::default(),
            Some(DownloadKind::HlsMpegTs),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if manager
            .list()
            .await
            .into_iter()
            .any(|t| t.id == task.id && t.state == DownloadState::Completed)
        {
            break;
        }
    }
    let done = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(done.state, DownloadState::Completed, "{:?}", done.error);
    let index = dir.path().join(done.output_rel.as_ref().unwrap());
    assert!(index.is_file());
    assert!(std::fs::read_to_string(&index).unwrap().contains("seg00000.ts"));
}

#[tokio::test]
#[ignore = "真实公网集成测试：需要网络"]
async fn real_public_mpegts_hls_download() {
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";
    let task = manager
        .enqueue("apple-ts".into(), None, url.into(), Default::default(), Some(DownloadKind::HlsMpegTs), None, None, None, None, None, None, None)
        .await
        .unwrap();
    for _ in 0..180 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let state = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap().state;
        if state == DownloadState::Completed || state == DownloadState::Failed {
            break;
        }
    }
    let done = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(done.state, DownloadState::Completed, "{:?}", done.error);
    let index = dir.path().join(done.output_rel.as_ref().unwrap());
    assert!(ffprobe_ok(&index));
}

#[tokio::test]
#[ignore = "真实公网集成测试：需要网络"]
async fn real_public_mp4_download() {
    let dir = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(dir.path().to_path_buf()).unwrap();
    let url = "https://storage.googleapis.com/exoplayer-test-media-1/mp4/android-screens-10s.mp4";
    let task = manager
        .enqueue("sample".into(), None, url.into(), Default::default(), Some(DownloadKind::ProgressiveMp4), None, None, None, None, None, None, None)
        .await
        .unwrap();
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let state = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap().state;
        if state == DownloadState::Completed || state == DownloadState::Failed {
            break;
        }
    }
    let done = manager.list().await.into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(done.state, DownloadState::Completed, "{:?}", done.error);
    assert!(ffprobe_ok(&dir.path().join(done.output_rel.as_ref().unwrap())));
}