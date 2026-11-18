//! 通用缓存请求链：IPC requestId 校验 → resolvePlayback → DownloadManager 入队与下载。
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Method, Response, StatusCode, Uri},
    routing::any,
    Router,
};
use hghub_hpp::ipc;
use hghub_hpp::media_download::{DownloadKind, DownloadManager, DownloadState};
use hghub_hpp::PluginManager;
use serde_json::json;
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
    if uri.path() != "/movie.mp4" {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    }
    let data: Vec<u8> = {
        let mut v = vec![
            0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0, b'm', b'p',
            b'4', b'1',
        ];
        v.extend((0..256 * 1024).map(|i| (i % 251) as u8));
        v
    };
  serve_bytes(method, &data, &range)
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

async fn open_fixture_plugin(base: &str) -> (tempfile::TempDir, PluginManager, String) {
    let dir = tempfile::tempdir().unwrap();
    let manager = PluginManager::with_mode(dir.path().into(), Some(false)).unwrap();
    let code = include_str!("fixtures/cache_enqueue.js");
    let info = manager.import_code(code.into(), None, false).await.unwrap();
    assert_eq!(info.status, "ready", "{:?}", info.error);
    manager
        .settings_set(&info.meta.id, "baseUrl".into(), json!(base))
        .await
        .unwrap();
    (dir, manager, info.meta.id)
}

fn stream_header<'a>(playback: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    playback["streams"][0]["headers"][key].as_str()
}

#[tokio::test]
async fn ipc_call_diagnoses_missing_request_id() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Arc::new(PluginManager::open(dir.path().into()).unwrap());
    let err = ipc::dispatch(
        &manager,
        "call".into(),
        json!({
            "id": "fixture.cache.enqueue",
            "method": "media.getDetail",
            "args": {"id": "work"}
        }),
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("requestId"),
        "expected 缺少 requestId diagnostic, got {:?}",
        err
    );
}

#[tokio::test]
async fn resolve_playback_echoes_request_id_in_headers() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen).await;
    let (_dir, manager, id) = open_fixture_plugin(&base).await;
    let rid = "cache-single-rid-001";
    let playback = manager
        .call(
            &id,
            "media.resolvePlayback",
            json!({
                "mediaId": "work",
                "playlistId": "main",
                "episodeId": "ep1"
            }),
            rid.into(),
        )
        .await
        .unwrap();
    assert_eq!(
        stream_header(&playback, "X-Fixture-Request-Id"),
        Some(rid),
        "{playback}"
    );
    assert!(playback["streams"][0]["url"]
        .as_str()
        .unwrap()
        .starts_with(&format!("{base}/movie.mp4")));
}

#[tokio::test]
async fn concurrent_resolve_out_of_order_request_ids() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen).await;
    let (_dir, manager, id) = open_fixture_plugin(&base).await;
    let ids = ["batch-rid-a", "batch-rid-b", "batch-rid-c"];
    let futs = ids.iter().map(|rid| {
        let manager = &manager;
        let id = id.clone();
        async move {
            let playback = manager
                .call(
                    &id,
                    "media.resolvePlayback",
                    json!({
                        "mediaId": "work",
                        "playlistId": "main",
                        "episodeId": "ep2"
                    }),
                    (*rid).into(),
                )
                .await
                .unwrap();
            (
                *rid,
                stream_header(&playback, "X-Fixture-Request-Id").unwrap().to_string(),
            )
        }
    });
    let results = futures_util::future::join_all(futs).await;
    for (sent, echoed) in results {
        assert_eq!(sent, echoed.as_str());
    }
}

#[tokio::test]
async fn batch_one_failure_rest_enqueue_and_download() {
    let seen: Seen = Default::default();
    let base = spawn_server(seen).await;
    let (_dir, plugins, plugin_id) = open_fixture_plugin(&base).await;
    let dl_root = tempfile::tempdir().unwrap();
    let downloads = DownloadManager::open(dl_root.path().to_path_buf()).unwrap();

    let episode_ids = ["ep1", "fail", "ep4"];
    let mut enqueued = 0;
    let mut errors: Vec<String> = vec![];

    for ep in episode_ids {
        let resolve = plugins
            .call(
                &plugin_id,
                "media.resolvePlayback",
                json!({
                    "mediaId": "work",
                    "playlistId": "main",
                    "episodeId": ep
                }),
                format!("batch-{ep}"),
            )
            .await;
        let Ok(playback) = resolve else {
            errors.push(ep.to_string());
            continue;
        };
        let url = playback["streams"][0]["url"].as_str().unwrap();
        let headers = playback["streams"][0]["headers"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let title = format!("Fixture {ep}");
        match downloads
            .enqueue(
                title.clone(),
                None,
                url.into(),
                headers,
                Some(DownloadKind::ProgressiveMp4),
                Some("progressive"),
                Some(plugin_id.clone()),
                Some("work".into()),
                Some(ep.into()),
                None,
                None,
                None,
            )
            .await
        {
            Ok(_) => enqueued += 1,
            Err(e) if e.message.contains("相同") || e.message.contains("已有") => {}
            Err(e) => panic!("unexpected enqueue error for {ep}: {:?}", e),
        }
    }

    assert_eq!(errors, vec!["fail".to_string()]);
    assert_eq!(enqueued, 2, "ep1 and ep4 should enqueue");

    let ep1_task = downloads
        .list()
        .await
        .into_iter()
        .find(|t| t.episode_id.as_deref() == Some("ep1"))
        .expect("ep1 task");
    let dup = downloads
        .enqueue(
            "dup".into(),
            None,
            format!("{base}/movie.mp4?ep=ep1-dup"),
            Default::default(),
            Some(DownloadKind::ProgressiveMp4),
            Some("progressive"),
            Some(plugin_id.clone()),
            Some("work".into()),
            Some("ep1".into()),
            None,
            None,
            None,
        )
        .await
        .expect("duplicate episode should kick/resume existing, not create second task");
    assert_eq!(dup.id, ep1_task.id, "dedup by plugin+media+episode");

    let first = downloads.list().await.into_iter().next().unwrap();
    downloads.pause(&first.id).await.unwrap();
    downloads.resume(&first.id).await.unwrap();

    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if downloads
            .list()
            .await
            .iter()
            .any(|t| t.state == DownloadState::Completed)
        {
            break;
        }
    }
    let completed = downloads
        .list()
        .await
        .into_iter()
        .filter(|t| t.state == DownloadState::Completed)
        .count();
    assert!(completed >= 1, "at least one task should finish downloading");
}