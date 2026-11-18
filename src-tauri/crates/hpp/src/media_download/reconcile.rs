use super::progress::DownloadTask;

fn normalize_title(title: &str) -> String {
    title.trim().to_lowercase()
}

/// Backfill missing plugin_id / media_id when exactly one sibling identity exists for the same title.
pub fn reconcile_download_tasks(tasks: &mut [DownloadTask]) -> bool {
    let mut changed = false;
    let mut pairs_by_title: std::collections::HashMap<String, std::collections::HashSet<(String, String)>> =
        std::collections::HashMap::new();
    for task in tasks.iter() {
        let (Some(plugin_id), Some(media_id)) = (&task.plugin_id, &task.media_id) else {
            continue;
        };
        pairs_by_title
            .entry(normalize_title(&task.title))
            .or_default()
            .insert((plugin_id.clone(), media_id.clone()));
    }
    for task in tasks.iter_mut() {
        let title_key = normalize_title(&task.title);
        let Some(candidates) = pairs_by_title.get(&title_key) else {
            continue;
        };
        if candidates.len() != 1 {
            continue;
        }
        let (plugin_id, media_id) = candidates.iter().next().unwrap().clone();
        if task.plugin_id.is_none() {
            task.plugin_id = Some(plugin_id.clone());
            changed = true;
        }
        if task.media_id.is_none() && task.plugin_id.as_deref() == Some(plugin_id.as_str()) {
            task.media_id = Some(media_id);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_download::progress::{DownloadKind, DownloadState, DownloadTask};
    use std::collections::HashMap;

    fn sample(
        id: &str,
        title: &str,
        plugin_id: Option<&str>,
        media_id: Option<&str>,
        episode_index: u32,
    ) -> DownloadTask {
        DownloadTask {
            id: id.into(),
            title: title.into(),
            episode_label: Some(format!("第 {episode_index} 集")),
            source_url: format!("https://example/{id}"),
            kind: DownloadKind::HlsMpegTs,
            headers: HashMap::new(),
            plugin_id: plugin_id.map(str::to_string),
            media_id: media_id.map(str::to_string),
            episode_id: Some(format!("ep-{episode_index}")),
            episode_index: Some(episode_index),
            episode_count: Some(6),
            cover_rel: None,
            state: DownloadState::Completed,
            bytes_done: 1,
            bytes_total: Some(1),
            speed_bps: 0.0,
            error: None,
            output_rel: None,
            temp_rel: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn backfills_legacy_episode_when_sibling_has_media_id() {
        let mut tasks = vec![
            sample("a", "琼明神女录", None, None, 2),
            sample("b", "琼明神女录", Some("huangguo"), Some("media-1"), 3),
        ];
        assert!(reconcile_download_tasks(&mut tasks));
        assert_eq!(tasks[0].plugin_id.as_deref(), Some("huangguo"));
        assert_eq!(tasks[0].media_id.as_deref(), Some("media-1"));
        assert!(!reconcile_download_tasks(&mut tasks));
    }

    #[test]
    fn does_not_merge_ambiguous_title() {
        let mut tasks = vec![
            sample("a", "同名剧", None, None, 1),
            sample("b", "同名剧", Some("p1"), Some("m1"), 1),
            sample("c", "同名剧", Some("p2"), Some("m2"), 1),
        ];
        assert!(!reconcile_download_tasks(&mut tasks));
        assert!(tasks[0].media_id.is_none());
    }
}