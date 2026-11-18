use crate::artwork::{cache, extract, process};
use crate::lyrics::parser;
use crate::persistence::{models::*, repository, schema};
use image::{ImageBuffer, ImageFormat, Rgba};
use serde_json::{json, Value};
use std::hint::black_box;
use std::io::Cursor;
use std::time::Instant;

fn measure(samples: usize, mut operation: impl FnMut()) -> Value {
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        operation();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    json!({
        "samples_ms": times,
        "p50_ms": sorted[(samples as f64 * 0.5).ceil() as usize - 1],
        "p95_ms": sorted[(samples as f64 * 0.95).ceil() as usize - 1],
    })
}

fn track(index: usize) -> TrackDto {
    TrackDto {
        id: format!("fixture-{index:05}"),
        title: format!("Synthetic Track {index}"),
        artist: format!("Fixture Artist {}", index / 12),
        album: format!("Fixture Album {}", index / 12),
        file_name: format!("fixture-{index}.flac"),
        file_size: 12_345_678,
        mime_type: "audio/flac".into(),
        added_at: index as i64,
        duration_ms: Some(180_000),
        availability: "available".into(),
        access_mode: "desktop-path".into(),
        fingerprint: Some(format!("fixture-fingerprint-{index}")),
        ..TrackDto::default()
    }
}

fn record(rows: &mut Vec<Value>, name: &str, size: usize, measurements: Value) {
    rows.push(json!({ "workload": name, "size": size, "measurements": measurements }));
}

// Explicit opt-in; ordinary cargo test only verifies that the harness compiles.
// Run serially, without competing builds, using GMUSIC_BENCH_OUTPUT for raw evidence.
#[test]
fn desktop_performance_workloads() {
    if std::env::var("GMUSIC_BENCH").as_deref() != Ok("1") {
        return;
    }
    let mut rows = Vec::new();
    let root = tempfile::tempdir().unwrap();
    for size in [100, 1000, 10_000] {
        let tracks: Vec<_> = (0..size).map(track).collect();
        let db_path = root.path().join(format!("library-{size}.sqlite3"));
        let mut conn = repository::open_and_initialize_db(&db_path).unwrap();
        let mut run = 0;
        record(
            &mut rows,
            "sqlite_fresh_connection",
            size,
            measure(9, || {
                run += 1;
                let path = root.path().join(format!("fresh-{size}-{run}.sqlite3"));
                black_box(repository::open_and_initialize_db(&path).unwrap());
            }),
        );
        record(
            &mut rows,
            "sqlite_batch_insert_200",
            size,
            measure(9, || {
                conn.execute("DELETE FROM tracks", []).unwrap();
                for batch in tracks.chunks(200) {
                    repository::put_tracks(&mut conn, batch).unwrap();
                }
            }),
        );
        record(
            &mut rows,
            "sqlite_list_tracks",
            size,
            measure(25, || {
                assert_eq!(
                    black_box(repository::list_tracks(&conn).unwrap()).len(),
                    size
                );
            }),
        );
        record(
            &mut rows,
            "sqlite_track_json_serialization",
            size,
            measure(25, || {
                black_box(serde_json::to_vec(&tracks).unwrap());
            }),
        );
        record(
            &mut rows,
            "sqlite_metadata_update_100",
            size,
            measure(25, || {
                repository::put_tracks(&mut conn, &tracks[..100]).unwrap();
            }),
        );
        for index in 0..20 {
            repository::put_playlist(
                &mut conn,
                &PlaylistDto {
                    id: format!("playlist-{index}"),
                    name: format!("Fixture Playlist {index}"),
                    track_ids: tracks
                        .iter()
                        .skip(index)
                        .step_by(20)
                        .map(|t| t.id.clone())
                        .collect(),
                    ..PlaylistDto::default()
                },
            )
            .unwrap();
        }
        record(
            &mut rows,
            "sqlite_list_20_playlists",
            size,
            measure(25, || {
                assert_eq!(
                    black_box(repository::list_playlists(&conn).unwrap()).len(),
                    20
                );
            }),
        );
        record(
            &mut rows,
            "sqlite_playlist_switch",
            size,
            measure(25, || {
                for index in 0..20 {
                    black_box(
                        repository::get_playlist(&conn, &format!("playlist-{index}")).unwrap(),
                    );
                }
            }),
        );
        record(
            &mut rows,
            "sqlite_integrity",
            size,
            measure(25, || {
                assert!(schema::run_integrity_checks(&conn).unwrap().is_empty());
            }),
        );
        drop(conn);
        record(
            &mut rows,
            "sqlite_reopen_status_list",
            size,
            measure(25, || {
                let mut reopened = repository::open_and_initialize_db(&db_path).unwrap();
                assert!(repository::get_status(&mut reopened).unwrap().integrity_ok);
                assert_eq!(repository::list_tracks(&reopened).unwrap().len(), size);
                black_box(repository::list_playlists(&reopened).unwrap());
            }),
        );
        let conn = repository::open_and_initialize_db(&db_path).unwrap();
        for query in [
            "SELECT * FROM tracks ORDER BY rowid ASC",
            "SELECT * FROM tracks WHERE id = 'fixture-00001'",
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = 'playlist-1' ORDER BY position ASC",
            "SELECT id, name, description, created_at, updated_at FROM playlists ORDER BY rowid ASC",
        ] {
            let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {query}")).unwrap();
            let plan: Vec<String> = statement.query_map([], |row| row.get(3)).unwrap().collect::<Result<_, _>>().unwrap();
            rows.push(json!({"workload": "query_plan", "size": size, "query": query, "plan": plan}));
        }
    }

    let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(1600, 1200, |x, y| {
        Rgba([(x % 251) as u8, (y % 251) as u8, ((x + y) % 251) as u8, 255])
    });
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    let validated = process::validate_and_inspect_image(&bytes).unwrap();
    let art_dir = root.path().join("artwork-v1");
    record(
        &mut rows,
        "artwork_validate_decode",
        bytes.len(),
        measure(9, || {
            black_box(process::validate_and_inspect_image(&bytes).unwrap());
        }),
    );
    record(
        &mut rows,
        "artwork_thumbnail_pair",
        bytes.len(),
        measure(9, || {
            black_box(process::generate_thumbnail(&validated, 500).unwrap());
            black_box(process::generate_thumbnail(&validated, 256).unwrap());
        }),
    );
    let mut art_run = 0;
    record(
        &mut rows,
        "artwork_cold_store",
        bytes.len(),
        measure(9, || {
            art_run += 1;
            let dir = root.path().join(format!("cold-art-{art_run}"));
            black_box(
                cache::store_artwork_blob(
                    &dir,
                    &["album::fixture".into()],
                    Some("fixture"),
                    &validated,
                    "embedded",
                    cache::CachedArtworkRecord::default(),
                )
                .unwrap(),
            );
        }),
    );
    let mut art_index = 0;
    record(
        &mut rows,
        "artwork_shared_content_store",
        bytes.len(),
        measure(9, || {
            art_index += 1;
            black_box(
                cache::store_artwork_blob(
                    &art_dir,
                    &[format!("album::fixture-{art_index}")],
                    Some("fixture"),
                    &validated,
                    "embedded",
                    cache::CachedArtworkRecord::default(),
                )
                .unwrap(),
            );
        }),
    );
    record(
        &mut rows,
        "artwork_warm_read",
        bytes.len(),
        measure(25, || {
            assert!(
                cache::read_cached_artwork(&art_dir, "track::fixture", false)
                    .unwrap()
                    .is_some()
            );
        }),
    );

    // A real FLAC PICTURE block; no decoder/playable-audio claim for this metadata fixture.
    let mut picture = Vec::new();
    picture.extend_from_slice(&3u32.to_be_bytes());
    picture.extend_from_slice(&9u32.to_be_bytes());
    picture.extend_from_slice(b"image/png");
    picture.extend_from_slice(&0u32.to_be_bytes());
    for value in [1600u32, 1200, 32, 0, bytes.len() as u32] {
        picture.extend_from_slice(&value.to_be_bytes());
    }
    picture.extend_from_slice(&bytes);
    let mut flac = b"fLaC".to_vec();
    flac.push(0x86);
    flac.extend_from_slice(&(picture.len() as u32).to_be_bytes()[1..]);
    flac.extend_from_slice(&picture);
    let audio_path = root.path().join("fixture.flac");
    std::fs::write(&audio_path, flac).unwrap();
    record(
        &mut rows,
        "artwork_flac_extraction",
        bytes.len(),
        measure(25, || {
            assert!(extract::extract_embedded_artwork(&audio_path)
                .unwrap()
                .is_some());
        }),
    );
    for size in [100, 1000, 10_000] {
        let folder = root.path().join(format!("scan-{size}"));
        std::fs::create_dir(&folder).unwrap();
        for index in 0..size {
            std::fs::write(folder.join(format!("fixture-{index}.mp3")), b"fixture").unwrap();
        }
        record(
            &mut rows,
            "folder_scan",
            size,
            measure(9, || {
                assert_eq!(
                    crate::collect_audio_files_in_dir(&folder, 16)
                        .unwrap()
                        .len(),
                    size
                );
            }),
        );
    }
    for lines in [100, 1000] {
        let content: String = (0..lines)
            .map(|i| {
                format!(
                    "[{}:{:02}.000]<{}:{:02}.000>Fixture <{}:{:02}.500>word\n",
                    i / 60,
                    i % 60,
                    i / 60,
                    i % 60,
                    i / 60,
                    i % 60
                )
            })
            .collect();
        record(
            &mut rows,
            "lyrics_enhanced_parse",
            lines,
            measure(25, || {
                assert_eq!(black_box(parser::parse(&content)).lines.len(), lines);
            }),
        );
    }
    let report = json!({
        "profile": "cargo-test-debug",
        "percentiles": "nearest-rank",
        "warmup": "none; first sample retained",
        "scope": "native operations only; no Tauri IPC, WebView rendering or audible playback",
        "results": rows,
    });
    let output = std::env::var("GMUSIC_BENCH_OUTPUT")
        .expect("Set GMUSIC_BENCH_OUTPUT to a new evidence file");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap();
    std::io::Write::write_all(
        &mut file,
        serde_json::to_string_pretty(&report).unwrap().as_bytes(),
    )
    .unwrap();
}
