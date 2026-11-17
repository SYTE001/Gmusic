use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn request() -> DiscoveryRequest {
    DiscoveryRequest {
        track: TrackQuery {
            id: "stable-track".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_ms: Some(200000),
        },
        providers: vec!["lrclib".into()],
        force: false,
        offline: false,
    }
}

async fn server(
    status: &str,
    body: &str,
    delay: std::time::Duration,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            requests.fetch_add(1, Ordering::SeqCst);
            let reply = reply.clone();
            tokio::spawn(async move {
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer).await;
                tokio::time::sleep(delay).await;
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    (format!("http://{address}"), count, task)
}

fn engine(bases: [String; 3]) -> LyricsEngine {
    LyricsEngine {
        providers: providers::NativeProviders::with_test_endpoints(
            bases,
            std::time::Duration::from_secs(2),
        ),
        flights: Default::default(),
    }
}

fn payload() -> String {
    serde_json::json!({ "id":42, "trackName":"Song", "artistName":"Artist", "albumName":"Album", "duration":200, "syncedLyrics":"[00:01]Hello\n[00:02]world" }).to_string()
}

#[tokio::test]
async fn cache_hits_coalesce_duplicates_and_preserve_offline_data() {
    let (url, count, task) = server("200 OK", &payload(), std::time::Duration::ZERO).await;
    let engine = engine([url.clone(), url.clone(), url]);
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = tokio::join!(
        engine.discover(dir.path().into(), request()),
        engine.discover(dir.path().into(), request())
    );
    assert_eq!(first.unwrap().candidates.len(), 1);
    assert!(second.unwrap().from_cache);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let mut offline = request();
    offline.offline = true;
    offline.force = true;
    let result = engine.discover(dir.path().into(), offline).await.unwrap();
    assert!(result.from_cache && result.offline);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn providers_run_concurrently_and_failures_do_not_poison_cache() {
    let (fast, _, fast_task) = server("200 OK", &payload(), std::time::Duration::ZERO).await;
    let (slow, _, slow_task) =
        server("403 Forbidden", "{}", std::time::Duration::from_millis(50)).await;
    let engine = engine([slow.clone(), fast, slow]);
    let dir = tempfile::tempdir().unwrap();
    let mut query = request();
    query.providers = vec!["lrclib".into(), "lrcmux".into()];
    let result = engine.discover(dir.path().into(), query).await.unwrap();
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.errors.len(), 1);
    // Partial successes are not cached as complete discovery: missing providers
    // may have a better result, and failures are never a negative cache.
    assert!(!dir
        .path()
        .join(format!("{}.json", cache::identity(&request().track, &[])))
        .exists());
    fast_task.abort();
    slow_task.abort();
}

#[tokio::test]
async fn offline_without_cache_and_invalid_identity_never_request_network() {
    let (url, count, task) = server("404 Not Found", "{}", std::time::Duration::ZERO).await;
    let engine = engine([url.clone(), url.clone(), url]);
    let dir = tempfile::tempdir().unwrap();
    let mut offline = request();
    offline.offline = true;
    assert!(
        engine
            .discover(dir.path().into(), offline)
            .await
            .unwrap()
            .offline
    );
    let mut invalid = request();
    invalid.providers = vec!["arbitrary-url".into()];
    assert!(engine.discover(dir.path().into(), invalid).await.is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn lrcmux_missing_uses_supported_search_and_can_be_negative_cached() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut paths = Vec::new();
        for _ in 0..3 {
            let accepted =
                tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept()).await;
            let Ok(Ok((mut stream, _))) = accepted else {
                break;
            };
            let mut buffer = [0; 4096];
            let size = stream.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            let path = request.split_whitespace().nth(1).unwrap().to_string();
            let (status, body) = if path.starts_with("/get?") {
                ("404 Not Found", "{}")
            } else if path.contains("artist_name=Artist") {
                ("200 OK", "[]")
            } else {
                ("400 Bad Request", "{}")
            };
            paths.push(path);
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
        }
        paths
    });
    let url = format!("http://{address}");
    let engine = engine([url.clone(), url.clone(), url]);
    let dir = tempfile::tempdir().unwrap();
    let mut query = request();
    query.providers = vec!["lrcmux".into()];
    let result = engine
        .discover(dir.path().into(), query.clone())
        .await
        .unwrap();
    assert!(result.candidates.is_empty());
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert!(
        engine
            .discover(dir.path().into(), query)
            .await
            .unwrap()
            .from_cache
    );
    let paths = task.await.unwrap();
    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(paths[1].starts_with("/compat/lrclib/api/search?"));
    assert!(paths[1].contains("track_name=Song") && paths[1].contains("artist_name=Artist"));
}

#[tokio::test]
async fn lrcmux_without_artist_does_not_send_unsupported_requests() {
    let (url, count, task) = server("400 Bad Request", "{}", std::time::Duration::ZERO).await;
    let engine = engine([url.clone(), url.clone(), url]);
    let dir = tempfile::tempdir().unwrap();
    let mut query = request();
    query.providers = vec!["lrcmux".into()];
    query.track.artist = " ".into();
    let result = engine.discover(dir.path().into(), query).await.unwrap();
    assert!(result.candidates.is_empty() && result.errors.is_empty());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn confirmed_missing_is_cached_and_metadata_changes_invalidate_it() {
    let (url, count, task) = server("404 Not Found", "{}", std::time::Duration::ZERO).await;
    let engine = engine([url.clone(), url.clone(), url]);
    let dir = tempfile::tempdir().unwrap();
    let first = engine.discover(dir.path().into(), request()).await.unwrap();
    assert!(first.errors.is_empty() && first.candidates.is_empty());
    let before = count.load(Ordering::SeqCst);
    assert!(
        engine
            .discover(dir.path().into(), request())
            .await
            .unwrap()
            .from_cache
    );
    assert_eq!(count.load(Ordering::SeqCst), before);
    let mut edited = request();
    edited.track.title = "Corrected Song".into();
    assert!(
        !engine
            .discover(dir.path().into(), edited)
            .await
            .unwrap()
            .from_cache
    );
    assert!(count.load(Ordering::SeqCst) > before);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    task.abort();
}
