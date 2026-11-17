import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Persist the release fix outside gen/: safe to rerun after every android init.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidSrc = join(root, "src-tauri/android");
const main = join(root, "src-tauri/gen/android/app/src/main");
const manifest = join(main, "AndroidManifest.xml");
if (existsSync(manifest)) {
  const java = join(main, "java/com/hghub/player");
  mkdirSync(java, { recursive: true });
  for (const file of ["OrientationPlugin.kt", "AppUpdatePlugin.kt"]) {
    copyFileSync(join(androidSrc, file), join(java, file));
  }
  mkdirSync(join(main, "res/xml"), { recursive: true });
  copyFileSync(join(androidSrc, "network_security_config.xml"), join(main, "res/xml/network_security_config.xml"));
  copyFileSync(join(androidSrc, "file_paths.xml"), join(main, "res/xml/file_paths.xml"));
  let xml = readFileSync(manifest, "utf8");
  if (/android:networkSecurityConfig=/.test(xml)) xml = xml.replace(/android:networkSecurityConfig="[^"]*"/, 'android:networkSecurityConfig="@xml/network_security_config"');
  else xml = xml.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/network_security_config"');
  if (!xml.includes("REQUEST_INSTALL_PACKAGES")) {
    xml = xml.replace(
      /<uses-permission android:name="android.permission.INTERNET"\s*\/?>/,
      match => `${match}\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`,
    );
  }
  if (!xml.includes("FileProvider")) {
    xml = xml.replace(
      /<\/application>/,
      `        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
    </application>`,
    );
  }
  writeFileSync(manifest, xml);
  console.log("[android] 已同步网络配置、应用更新插件与安装权限");
}