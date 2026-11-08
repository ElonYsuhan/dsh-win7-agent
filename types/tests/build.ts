import type { BuildMetadata, DesktopTarget, DistributionReport, RuntimeVersions, SourceProtectionReport } from '../build/desktop'
const runtime: RuntimeVersions = { electron: '22.3.27', node: '16.17.1', chromium: '108' }
const target: DesktopTarget = 'mac-arm64'
const build: BuildMetadata = { ...runtime, formatVersion: 1, target, version: '0.4.4', sourceCommit: 'abc', uiBuild: 'def', packageBuildId: 'ghi' }
const protection: SourceProtectionReport = {
  policy: 'agent-source-v1', tools: { terser: '5.31.0', 'javascript-obfuscator': '4.1.1' },
  records: [{ path: 'main.js', mode: 'aes-256-gcm', sourceSha256: 'a', entrySha256: 'b' }]
}
const report: DistributionReport = { formatVersion: 1, target, version: build.version, sourceCommit: build.sourceCommit, buildMetadata: build, runtime, verification: 'ok', targetMachineTest: 'not performed' }
void report; void protection
// @ts-expect-error targets are the fixed delivery set
const badTarget: DesktopTarget = 'win-arm64'
// @ts-expect-error runtime versions are locked literals
const badRuntime: RuntimeVersions = { ...runtime, chromium: '120' }
void badTarget; void badRuntime
