export type DesktopTarget = 'win-x64' | 'mac-arm64' | 'mac-x64' | 'linux-x64' | 'linux-arm64'
export interface RuntimeVersions {
  readonly electron: '22.3.27'
  readonly node: '16.17.1'
  readonly chromium: '108'
}
export interface BuildMetadata extends RuntimeVersions {
  readonly formatVersion: 1
  readonly target: DesktopTarget
  readonly version: string
  readonly sourceCommit: string
  readonly uiBuild: string
  readonly packageBuildId: string
}
export interface SourceProtectionRecord {
  readonly path: string
  readonly mode: 'plain' | 'aes-256-gcm' | 'obfuscated'
  readonly sourceSha256: string
  readonly entrySha256: string
}
export interface SourceProtectionReport {
  readonly policy: 'agent-source-v1'
  readonly tools: { readonly terser: '5.31.0'; readonly 'javascript-obfuscator': '4.1.1' }
  readonly records: readonly SourceProtectionRecord[]
}
export interface DistributionReport {
  readonly formatVersion: 1
  readonly target: DesktopTarget
  readonly version: string
  readonly sourceCommit: string
  readonly buildMetadata: BuildMetadata
  readonly runtime: RuntimeVersions
  readonly verification: string
  readonly targetMachineTest: string
}
