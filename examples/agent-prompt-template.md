# AI Agent Prompt Template — Bridge Integration

> ⚠️ **已过期 (2026-07-22)**：device flow 授权已删除，改成 PAT 模型 (`Authorization: Bearer bpt_xxx`)。请看 [`../docs/AI_INTEGRATION.md`](../docs/AI_INTEGRATION.md)。

把这段塞到任何需要操作用户浏览器的 AI 系统提示里。AI 全程不需要 RELAY_SECRET、不需要 connect code，授权由用户在浏览器插件里主动给。

---

## 简版（直接复制给 AI）

```
你可以通过 ai-browser-bridge 操作我的真实浏览器。授权流程：

1. 当你需要浏览器能力时，调用：
   POST https://bridge.mikeyzhou.xin/device/authorize
   Body: { "agentId": "<给自己起一个有意义的名字，比如 'kol-analyzer'>" }
   返回: { user_code, device_code, expires_in, interval }

2. 把 user_code（形如 "ABCD-1234"）告诉我，让我去 Chrome 插件 popup 里输码授权。
   原话:「请打开 Chrome 右上角的 AI Browser Bridge 插件 → 点 "Authorize an AI agent" → 输入 ABCD-1234 → 选时长 → Approve」

3. 每 3 秒轮询一次拿 token：
   POST https://bridge.mikeyzhou.xin/device/token
   Body: { "device_code": "<上一步的 device_code>" }
   返回:
     { ok: false, error: "authorization_pending" } → 继续等
     { ok: true, token, userId, expires_in }       → 成功
     { ok: false, error: "expired_token" }         → 用户没在 10 分钟内授权
     { ok: false, error: "access_denied" }         → 用户拒绝

4. 拿到 token 后调用浏览器命令：
   POST https://bridge.mikeyzhou.xin/command
   Headers: { Authorization: "Bearer <token>" }
   Body: { userId: <步骤 3 返回的 userId>, action, params }

可用 action:
  - tabs:            列出当前打开的 tab
  - navigate:        新建 tab 跳转 URL（默认不抢用户当前 tab）
                     params: { url, newTab?, tabId? }
  - waitForSelector: 等 SPA 元素出现（必备）
                     params: { tabId, selector, timeout?, visible? }
  - extract:         读 DOM (text/html/title)，可选 waitFor 一站式等+提取
                     params: { tabId, type, waitFor?, waitTimeout? }
  - evalScript:      执行任意 JS（受目标页面 CSP 约束）
                     params: { tabId, script }
  - cookies:         按 domain 取 cookies
                     params: { domain }
  - screenshot:      截图（PNG dataURL）
                     params: { windowId? }

错误处理（必须区分这几种）:
  - { ok: false, error: "User paused AI access" }    → 用户暂停了，不要重试，告诉我并等我点 Resume
  - HTTP 401                                          → token 过期或无效，重新走授权流程
  - HTTP 503 + "User browser not connected"          → 浏览器离线，等几分钟或告诉我开浏览器
  - HTTP 429 + retryAfterMs                           → 频控，按 retryAfterMs sleep 后重试

操作 SPA 时的标准序列:
  navigate → waitForSelector → extract（不要 navigate 后立即 extract，会拿到空骨架）

注意:
  - 不要直接 navigate 那种"账户绑定后台"页面（如腾讯互选 /trade/selection/xxx/...）
    SPA router 会把新 tab 重定向。让我先在浏览器手动进到目标页，你再用 tabs 找到那个 tab 操作
  - 抓 echarts 图表数据用 evalScript 调 window.echarts.getInstanceByDom(el).getOption().dataset[0].source
    不需要 OCR
```

---

## 完整版（含错误处理、SPA、echarts 抓取）

把上面那段 + `DEPLOYMENT.md §3.0 §3.1` + `PLATFORM_COMMANDS.md` 一起塞 system prompt。

## 替换变量

把上面所有 `https://bridge.mikeyzhou.xin` 替换成你自己 relay 的 PUBLIC_URL（如果 relay 部署在别处）。

## 给 AI 端开发者的最小代码

完整可跑的 JS 模板：

```js
const RELAY_URL = 'https://bridge.mikeyzhou.xin'

async function authorize(agentId) {
  const auth = await fetch(`${RELAY_URL}/device/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  }).then(r => r.json())

  console.log(`📋 请用户在 Chrome 插件输入: ${auth.user_code}`)

  const deadline = Date.now() + auth.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, auth.interval * 1000))
    const r = await fetch(`${RELAY_URL}/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: auth.device_code }),
    }).then(r => r.json())
    if (r.ok) return { token: r.token, userId: r.userId }
    if (r.error === 'expired_token') throw new Error('用户超时未授权')
    if (r.error === 'access_denied') throw new Error('用户拒绝授权')
    // authorization_pending → 继续轮询
  }
  throw new Error('授权超时')
}

async function call(token, userId, action, params = {}) {
  const r = await fetch(`${RELAY_URL}/command`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, action, params }),
  })
  const json = await r.json()
  if (json.error === 'User paused AI access') throw new UserPausedError()
  if (!r.ok || json.ok === false) throw new Error(json.error || `HTTP ${r.status}`)
  return json.data
}

class UserPausedError extends Error {
  constructor() { super('User paused AI access') }
}

// 用法：
async function main() {
  const { token, userId } = await authorize('kol-analyzer')

  // 在用户已登录的 huxuan tab 上抓 echarts 数据
  const tabs = await call(token, userId, 'tabs')
  const huxuanTab = tabs.find(t => t.url?.includes('huxuan.qq.com') && t.url?.includes('detail'))
  if (!huxuanTab) {
    console.log('请先在浏览器打开互选博主详情页')
    return
  }

  const charts = await call(token, userId, 'evalScript', {
    tabId: huxuanTab.id,
    script: `(()=>{
      const out=[]
      document.querySelectorAll('[_echarts_instance_]').forEach((el,i)=>{
        const inst = window.echarts?.getInstanceByDom(el)
        if (!inst) return
        const opt = inst.getOption()
        let header = ''
        let p = el
        for (let k = 0; k < 6 && p; k++) {
          p = p.parentElement; if (!p) break
          const sib = [...p.querySelectorAll('h1,h2,h3,h4,h5,[class*=title]')].slice(0,1).map(s=>s.textContent.trim()).filter(t=>t.length<40)
          if (sib.length) { header = sib[0]; break }
        }
        out.push({ header, source: opt.dataset?.[0]?.source || null })
      })
      return JSON.stringify(out)
    })()`,
  })
  const data = JSON.parse(charts)
  console.log(data)  // [{header:'城市 TOP20', source:[{label:'上海市',value:31,customPercent:'20%'},...]}, ...]
}
```

---

## FAQ

**Q：为什么 AI 不能自己保存 token？**
A：可以保存。token 在 ttl 期间（默认 1h）有效，AI 应该缓存避免每次都让用户重输码。但 token 过期或用户关闭浏览器后，必须重新走 authorize。

**Q：用户拒绝授权怎么办？**
A：`/device/token` 会返 `access_denied`（如果用户拒绝）或 `expired_token`（10 分钟没操作）。AI 应该礼貌告诉用户失败原因。

**Q：能不能让一个 token 操作多个用户？**
A：不能。一个 agent-jwt 只能操作签发时绑定的 `userId`。需要操作多个用户时，每个用户走一次 device flow。

**Q：用户能撤销吗？**
A：能。用户在插件 popup 上点 "Pause AI access" 立即冻结所有命令；或者去 `View AI activity` 看哪个 agent 在干啥。
