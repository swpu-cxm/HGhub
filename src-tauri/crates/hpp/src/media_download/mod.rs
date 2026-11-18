//! Host-owned offline media download queue (progressive MP4 and non-DRM fMP4 HLS).
mod engine;
mod hls;
mod hls_mpegts;
mod progress;
mod reconcile;
mod store;
mod work_meta;

pub use engine::DownloadManager;
pub use progress::{DownloadKind, DownloadState, DownloadTask};
pub use work_meta::WorkCacheMeta;