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

4. 配置 GitHub Actions Secrets（官方推荐：仓库或 Environment secrets，勿写入源码 / APK）  
   文档：[Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)、[Storing Base64 binary blobs as secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions#storing-base64-binary-blobs-as-secrets)（keystore &lt; 48KB 适用）、[Storing large secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions#storing-large-secrets)（超限时用加密文件 + 口令 secret）。

| Secret | 值来源 |
| --- | --- |
| `ANDROID_KEY_BASE64` | `base64 -w0 hghub-release.keystore`（Linux）或 `base64 -i …`（macOS），再 `gh secret set ANDROID_KEY_BASE64 < keystore.base64` |
| `ANDROID_KEY_ALIAS` | `hghub` |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD` | store 口令（经 env 注入 runner，禁止 echo 到日志） |

维护者需在仓库 **Settings → Secrets and variables → Actions**（或 Environment）中自行添加；CI 工作流仅检测非空并 `base64 --decode` 到临时文件，签名后删除。

## CI 行为

`scripts/verify-android-apk-cert.mjs` 在签名后对 APK 校验证书 SHA-256；与 `signing-identity.json` 不一致则失败，避免静默换证导致无法覆盖安装/更新。

## 父助手 / Agent 原始备份路径（只读路径，不含秘密内容）

运行生成证书的 Cloud Agent 私有 store：

- `/cursor/stores/self/android-signing/hghub-release.keystore`（明文 keystore，未提交）
- `/cursor/stores/self/android-signing/credentials.env`（口令，未提交）
- `/cursor/stores/self/android-signing/keystore-backup.passphrase`（加密备份口令，未提交）
- `/opt/cursor/artifacts/hghub-release.keystore`（工件副本，未提交）

请在合并发布流程前，由有权访问的一方将上述路径**离线备份**；恢复时可选择明文 keystore 或本目录 `.enc` + 备份口令。