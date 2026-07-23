// 启动 Cloudflare Quick Tunnel，返回公网 WSS URL。
// cloudflared 是 optionalDependencies —— 设了 PUBLIC_URL 的生产部署根本不会调到这里，
// 因此境内服务器可以 `npm install --ignore-scripts` 跳过 cloudflared 二进制下载。
// 走 dynamic import，模块顶层不依赖 cloudflared。
export async function startTunnel(port: number): Promise<string> {
  let cloudflared: typeof import('cloudflared')
  try {
    cloudflared = await import('cloudflared')
  } catch (err) {
    throw new Error(
      'cloudflared not installed. Either set PUBLIC_URL env var to skip the tunnel, ' +
      'or install cloudflared explicitly: npm install cloudflared'
    )
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tunnel timeout')), 30_000)

    const result = (cloudflared.tunnel({ '--url': `http://localhost:${port}` }) as unknown) as {
      url: Promise<string>
      child: { kill: () => void }
    }

    result.url.then((tunnelUrl: string) => {
      clearTimeout(timeout)
      const wsUrl = tunnelUrl.replace(/^https?:\/\//, 'wss://') + '/ws'
      resolve(wsUrl)

      process.on('exit', () => result.child.kill())
      process.on('SIGINT', () => { result.child.kill(); process.exit() })
      process.on('SIGTERM', () => { result.child.kill(); process.exit() })
    }).catch((err: Error) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

