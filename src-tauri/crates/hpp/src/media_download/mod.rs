//! Host-owned offline media download queue (progressive MP4 and non-DRM fMP4 HLS).
mod engine;
mod hls;
mod progress;
mod store;

pub use engine::DownloadManager;
pub use progress::{DownloadKind, DownloadState, DownloadTask};