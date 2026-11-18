# HGhub Android 签名身份恢复

本目录仅包含**公钥证书**、**期望证书指纹**与 **OpenSSL 加密后的 keystore 备份**，不含任何口令或私钥明文。

## 仓库内文件

| 文件 | 内容 |
| --- | --- |
| `hghub-release-cert.pem` | 签名证书（公钥） |
| `signing-identity.json` | 别名 `hghub` 与 SHA-256 指纹（强校验用） |
| `hghub-release.keystore.enc` | AES-256-CBC + PBKDF2 加密的 PKCS12/JKS keystore |

## 恢复 keystore（维护者本地）

1. 从**安全保管处**取回加密口令（与本仓库分离保存，不在 Git 中）。
2. 解密：

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in hghub-release.keystore.enc -out hghub-release.keystore
```

3. 验证指纹与 `signing-identity.json` 一致：

```bash
keytool -list -v -keystore hghub-release.keystore -alias hghub | rg SHA256
```

4. 配置 GitHub Actions Secrets（名称与上游 `release.yml` 相同）：

- `ANDROID_KEY_BASE64`：`base64 -w0 hghub-release.keystore`（Linux）或 `base64 -i hghub-release.keystore`（macOS）
- `ANDROID_KEY_ALIAS`：`hghub`
- `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD`：解密所得 store 口令

## CI 行为

`scripts/verify-android-apk-cert.mjs` 在签名后对 APK 校验证书 SHA-256；与 `signing-identity.json` 不一致则失败，避免静默换证导致无法覆盖安装/更新。

## 父助手 / Agent 原始备份路径（只读路径，不含秘密内容）

运行生成证书的 Cloud Agent 私有 store：

- `/cursor/stores/self/android-signing/hghub-release.keystore`（明文 keystore，未提交）
- `/cursor/stores/self/android-signing/credentials.env`（口令，未提交）
- `/cursor/stores/self/android-signing/keystore-backup.passphrase`（加密备份口令，未提交）
- `/opt/cursor/artifacts/hghub-release.keystore`（工件副本，未提交）

请在合并发布流程前，由有权访问的一方将上述路径**离线备份**；恢复时可选择明文 keystore 或本目录 `.enc` + 备份口令。