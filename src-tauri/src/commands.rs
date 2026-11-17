use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "android")]
pub struct OrientationPlugin(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub struct AppUpdatePlugin(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn set_orientation(landscape: bool, plugin: tauri::State<'_, OrientationPlugin>) -> Result<(), String> {
    plugin.0.run_mobile_plugin_async::<()>("setOrientation", serde_json::json!({"landscape": landscape})).await
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn set_orientation(landscape: bool) -> Result<(), String> {
    let _ = landscape;
    Err("当前平台不支持原生屏幕方向切换".into())
}

#[tauri::command]
pub fn app_boot() -> Value {
    json!({"strict_security":crate::network_policy::strict_security()})
}
#[tauri::command]
pub fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    Ok(crate::network_policy::strict_security())
}
#[tauri::command]
pub fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    crate::logging::append_debug(&app.path().app_data_dir().map_err(|e| e.to_string())?, &msg)
}
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn app_update_install(
    path: String,
    plugin: tauri::State<'_, AppUpdatePlugin>,
) -> Result<(), String> {
    plugin
        .0
        .run_mobile_plugin_async::<()>("installApk", serde_json::json!({ "path": path }))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn app_update_install(path: String) -> Result<(), String> {
    let _ = path;
    Err("当前平台不支持应用内安装".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn app_update_permissions(plugin: tauri::State<'_, AppUpdatePlugin>) -> Result<bool, String> {
    let v: serde_json::Value = plugin
        .0
        .run_mobile_plugin_async("canRequestPackageInstalls", serde_json::json!({}))
        .await
        .map_err(|error| error.to_string())?;
    Ok(v.get("allowed").and_then(|b| b.as_bool()).unwrap_or(false))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn app_update_permissions() -> Result<bool, String> {
    Ok(true)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn app_update_open_install_permission(
    plugin: tauri::State<'_, AppUpdatePlugin>,
) -> Result<(), String> {
    plugin
        .0
        .run_mobile_plugin_async::<()>("openUnknownAppSourcesSettings", serde_json::json!({}))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn app_update_open_install_permission() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn app_update_download_apk(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(file_name.replace('/', "_"));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(expected) = expected_sha256 {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if hash != expected.to_lowercase() {
            return Err("安装包校验失败".into());
        }
    }
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
