# 版本与发行规范

项目采用 [SemVer 2.0.0](https://semver.org/lang/zh-CN/)。从 v1.0.0 开始，版本号描述局域网房间与媒体协议、已公布的启动参数和用户可依赖的房间及偏好行为。

| 版本位 | 何时升级 | 示例 |
| --- | --- | --- |
| `PATCH` 修订号 | 修复缺陷，保留已发布的接口和行为兼容性 | `1.0.0` → `1.0.1` |
| `MINOR` 次版本 | 兼容地添加功能、选项或协议能力，修订号归零 | `1.0.1` → `1.1.0` |
| `MAJOR` 主版本 | 不兼容的协议、启动接口或核心操作体验跨代变更，次版本与修订号归零 | `1.1.0` → `2.0.0` |

公开预发版用 `-beta.N`，候选版用 `-rc.N`，`N` 从 1 递增。例如 `1.1.0-beta.1` → `1.1.0-rc.1` → `1.1.0`。Git Tag 包含前缀 `v`，例如 `v1.1.0-rc.1`，GitHub Release 标记为 pre-release。构建和打包接受 SemVer 的构建元数据 `+...`，公开 Tag 和下载包采用省略元数据的版本号。已公开的版本与校验值保持固定，有改动就发新版本。

## 局域网兼容性

- 建议同一房间的所有成员使用完全相同的发行版本。主版本内应维持已公布的协议和偏好兼容性，次版本的新能力应有协商或可用的旧行为。发布说明明确列出已验证的混用范围。预发版建议只与同一个预发版本互通。
- v1.0.0 与旧 `0.x` 版本存在协议差异。遇到版本不兼容时，提示房主和成员统一升级，退出旧程序，再重新创建房间。版本提示以协议协商为依据，使用者可在发布包的 `版本与校验.txt` 或通过 `--version` 确认自己的发行版本。

## 正式发行流程

1. 确定本次版本，更新 CI、README、发布说明、宣传页和下载链接断言。构建同版本 Windows x64 EXE 并检查生成的第三方许可清单。
2. 跑 Go、Node、两轮离线实验室、前端、三人媒体、后台开销与宣传页回归。用用于发布的同一份 EXE 重拍实机界面、打包并校验。核对 `--version`、ZIP 文件名和内容，以及 `SHA256SUMS.txt` 的两个摘要。
3. 在通过验收的源码提交上创建带注释的 Git Tag `vX.Y.Z`（预发版带对应后缀），推送 Tag。将正式包、版本化 EXE 和 `SHA256SUMS.txt` 上传至对应 GitHub Release，使用 `docs/releases/vX.Y.Z.md` 作为发布说明。下载地址沿用 `releases/download/vX.Y.Z/lan-screen-sharing-X.Y.Z-windows-x64.zip`。
4. 确认 Release 附件可下载后，将新版 `website/` 同步到 `main`，由 Pages 工作流部署。检查主页的两个下载按钮、版本说明入口与正式版标识。

在项目根目录构建并打包 v1.0.0。发布包内有可离线打开的指南、项目协议、署名和第三方组件许可。

```powershell
$releaseVersion = '1.0.0'
$releaseExe = "dist/release-$releaseVersion/局域网屏幕共享-$releaseVersion.exe"
.\scripts\build.ps1 -BuildVersion $releaseVersion -OutputPath $releaseExe
.\scripts\package-release.ps1 -ExePath $releaseExe -Version $releaseVersion
```

由 `scripts/build.ps1` 为目标 EXE 生成 `.licenses.txt`。如运行时依赖或许可发生变化，运行 `scripts/write-third-party-notices.ps1 -OutputPath docs/third-party-notices.txt` 同步仓库中的许可清单。
