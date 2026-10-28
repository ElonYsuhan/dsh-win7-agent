# 最新离线安装程序 / Latest offline installer

- Windows x64：[Agent.exe](Agent-win-x64/Agent.exe)
- 校验文件：[SHA256SUMS.txt](SHA256SUMS.txt)
- 构建记录：[build-info.json](build-info.json)

通过 Git 拉取仓库后，直接打开 `installers/Agent-win-x64/Agent.exe` 安装运行，无需另行上传安装附件，无需目标机安装 Node.js、npm 或 Python。按发布包授权策略激活使用。

After cloning or pulling this repository, open `installers/Agent-win-x64/Agent.exe` to install and run the application. No separate attachment upload or target-side Node.js, npm or Python installation is required. Release licensing still applies.

PowerShell 校验 / verification:

```powershell
Get-FileHash ./installers/Agent-win-x64/Agent.exe -Algorithm SHA256
Get-Content ./installers/SHA256SUMS.txt
```

比较两处 SHA-256 值是否相同。哈希用于检测文件变化，不能替代可信签名。文件为完整 Git 二进制内容，不使用需要额外下载的 LFS 指针。

Compare the SHA-256 values. Checksums detect file changes and do not replace trusted signatures. The installer is stored as a complete Git binary, not an LFS pointer requiring an additional download.

每个平台仅保留最新版固定文件名，不在此堆积历史安装包、解压运行目录或构建缓存。Git 历史仍会保留旧二进制版本；更新会增加仓库体积。原始构建与验证报告继续保存在被忽略的 `release/` 目录。

Keep only the latest fixed-name installer for each platform here. Git history retains earlier binaries and repository size grows with updates. Build intermediates and validation reports remain in the ignored `release/` directory.
