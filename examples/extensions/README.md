# 离线能力包开发模板

- report-skill：SKILL.md 与参考资料。
- local-mcp：使用 Agent 内嵌 Node 的真实 stdio MCP 服务。
- http-mcp：内网 HTTP MCP 连接配置，使用前修改地址和环境变量名称。
- echo-plugin：原生 Cordis 插件，effect 注册工具并自动清理。

每个目录单独打包：

```
node scripts/pack-extension.js examples/extensions/report-skill /tmp/report-guide.agentpkg
```

manifest.json 为开发模板；files 摘要表由打包器生成。包安装后默认停用。详情见 docs/EXTENSION-PACKAGES.md。
