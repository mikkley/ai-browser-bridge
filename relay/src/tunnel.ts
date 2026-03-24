import cloudflared from 'cloudflared'

// 启动 Cloudflare Quick Tunnel，返回公网 WSS URL
export async function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tunnel timeout')), 30_000)

    // cloudflared 返回 any，用类型断言
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

