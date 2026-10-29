/** 平台 → 官方 release 资源名（zk 的 GitHub Actions 文件名，别再猜）。 */
export interface ZkAsset {
  asset: string
  bin: string
  url: string
}

const PLATFORMS: Record<string, string> = {
  'linux-x64': 'linux-amd64',
  'linux-arm64': 'linux-arm64',
  'linux-ia32': 'linux-i386',
  'darwin-x64': 'macos-x86_64',
  'darwin-arm64': 'macos-arm64',
  'win32-x64': 'windows-x86_64',
}

export function zkAsset(version: string): ZkAsset | null {
  const tag = PLATFORMS[`${process.platform}-${process.arch}`]
  if (!tag) return null
  const base = (process.env.ZK_DOWNLOAD_BASE || 'https://github.com').replace(/\/+$/, '')
  const asset = `zk-v${version}-${tag}.tar.gz`
  return {
    asset,
    bin: process.platform === 'win32' ? 'zk.exe' : 'zk',
    url: `${base}/zk-org/zk/releases/download/v${version}/${asset}`,
  }
}
