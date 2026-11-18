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
) -> Result<Value, String> {
    let v: Value = plugin
        .0
        .run_mobile_plugin_async("installApk", serde_json::json!({ "path": path }))
        .await
        .map_err(|error| error.to_string())?;
    if v.get("launched").and_then(|b| b.as_bool()) != Some(true) {
        return Err("安装程序未成功打开".into());
    }
    Ok(v)
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
    let response = client
        .get(&url)
        .header("Accept", "application/octet-stream")
        .header(
            reqwest::header::USER_AGENT,
            "HGhub-Android-Updater/1.0 (+https://github.com/swpu-cxm/HGhub)",
        )
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败（HTTP）：{e}"))?;
    let bytes = response.bytes().await.map_err(|e| format!("读取下载内容失败：{e}"))?;
    if bytes.len() < 64 * 1024 {
        return Err(format!(
            "下载内容过小（{} 字节），可能不是有效的 APK",
            bytes.len()
        ));
    }
    if bytes.len() < 4 || &bytes[0..2] != b"PK" {
        return Err("下载内容不是 ZIP/APK 格式".into());
    }
    if let Some(expected) = expected_sha256 {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let want = expected.trim().to_lowercase();
        if want.len() >= 64 && hash != want {
            let prefix = if want.len() >= 16 { &want[..16] } else { &want };
            return Err(format!("安装包 SHA-256 校验失败（期望 {prefix}…）"));
        }
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("无法写入安装包：{e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
