mod commands;
mod download_commands;
mod logging;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod network_policy;
mod plugins;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("orientation")
                .setup(|app, api| {
                    #[cfg(target_os = "android")]
                    {
                        let handle = api.register_android_plugin("com.hghub.player", "OrientationPlugin")?;
                        app.manage(commands::OrientationPlugin(handle));
                    }
                    #[cfg(not(target_os = "android"))]
                    let _ = (app, api);
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("app-update")
                .setup(|app, api| {
                    #[cfg(target_os = "android")]
                    {
                        let update = api.register_android_plugin("com.hghub.player", "AppUpdatePlugin")?;
                        app.manage(commands::AppUpdatePlugin(update));
                    }
                    #[cfg(not(target_os = "android"))]
                    let _ = (app, api);
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            network_policy::bind_security(&dir);
            hghub_hpp::proxy::bind(&dir);
            let manager = std::sync::Arc::new(
                hghub_hpp::PluginManager::open(dir.join("hpp"))?
                    .with_document_reader(std::sync::Arc::new(plugins::PickedDocuments(app.handle().clone()))),
            );
            app.manage(manager.clone());
            let downloads = std::sync::Arc::new(
                hghub_hpp::media_download::DownloadManager::open(dir.join("hpp"))?,
            );
            let resume = downloads.clone();
            app.manage(downloads);
            tauri::async_runtime::spawn(async move {
                resume.resume_interrupted().await;
            });
            // The WebView registers its playback capabilities before the first
            // plugin command; eager initialization would expose an incorrect env.
            #[cfg(target_os = "macos")]
            macos_titlebar::create_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plugins::hpp_manage,
            plugins::pick_plugin_files,
            commands::app_boot,
            commands::security_set,
            commands::set_orientation,
            commands::debug_log,
            commands::open_url,
            download_commands::download_manage,
            commands::app_update_build_info,
            commands::app_update_inspect_apk,
            commands::app_update_install,
            commands::app_update_permissions,
            commands::app_update_open_install_permission,
            commands::app_update_download_apk,
            commands::app_update_discard_downloads
        ])
        .run(tauri::generate_context!())
        .expect("error while running HGhub");
}
