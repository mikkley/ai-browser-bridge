# opencli 平台命令清单

> ⚠️ **依赖的 adapter.mjs 已过期 (2026-07-22)**：`adapter.mjs` 走的是已删除的 agent-jwt 认证，改成 PAT 模型后需要更新 adapter 才能用。命令清单本身（选择器/交互逻辑）仍可参考，但认证部分见 [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)。

本文档供 AI Agent 端集成 opencli 时参考。所有命令通过本地 `adapter.mjs` daemon 转发到远端用户浏览器执行。

> 前置：`adapter.mjs` 已启动，监听 `OPENCLI_DAEMON_PORT=19826`（详见 `DEPLOYMENT.md` §3.2）

## 平台命令

### 小红书 (xiaohongshu)

```bash
# 搜索笔记
OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu search "关键词" --limit 20

# 获取笔记评论（主评论，不含楼中楼）
OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu comments <note-id> --limit 20
# note-id 从搜索结果的 URL 中提取，如 /explore/69aadbcb000000002202f131

# 用户主页笔记列表
OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu user <user-id>
```

### B 站 (bilibili)

```bash
# 搜索视频
OPENCLI_DAEMON_PORT=19826 opencli bilibili search "关键词" --limit 20

# 获取视频评论（官方 API + WBI 签名，最稳定）
OPENCLI_DAEMON_PORT=19826 opencli bilibili comments <bvid> --limit 20
# bvid 格式：BV1WtAGzYEBm

# 用户投稿视频
OPENCLI_DAEMON_PORT=19826 opencli bilibili user-videos <uid>
```

### 微博 (weibo)

```bash
# 搜索帖子
OPENCLI_DAEMON_PORT=19826 opencli weibo search "关键词" --limit 10

# 获取单条帖子详情（含 numeric id）
OPENCLI_DAEMON_PORT=19826 opencli weibo post <mblogid>

# 获取帖子评论（需要数字 id，不是 mblogid）
OPENCLI_DAEMON_PORT=19826 opencli weibo comments <numeric-id> --limit 20
# 先用 weibo post <mblogid> 获取 numeric id
```

### 其他平台

opencli 还内置了 `zhihu / twitter / youtube / instagram / reddit / tiktok / douyin` 等命令，调用方式同上。完整命令以 opencli 仓库自身的 `SKILL.md` 为准。

## 输出格式

```bash
# 默认表格
opencli xiaohongshu search "AI眼镜" --limit 5

# CSV（适合后续处理）
opencli xiaohongshu search "AI眼镜" --limit 5 -f csv > output.csv

# JSON
opencli bilibili comments BV1xxx -f json > comments.json
```

## 频控（自动）

opencli 自带的 `rate-limiter` 插件在每条命令后随机 sleep 5~30s，无需手动加。

```bash
# 调整间隔（秒）
OPENCLI_RATE_MIN=3 OPENCLI_RATE_MAX=15 opencli ...

# 本地调试跳过等待
OPENCLI_NO_RATE=1 opencli ...
```

## 典型工作流：批量采集

```bash
# 1. 搜索，拿到内容列表
OPENCLI_DAEMON_PORT=19826 opencli bilibili search "AI眼镜" --limit 10 -f json > search.json

# 2. 提取 ID 列表，逐一抓评论
for bvid in $(jq -r '.[].bvid' search.json); do
  OPENCLI_DAEMON_PORT=19826 opencli bilibili comments "$bvid" --limit 20 -f csv >> all_comments.csv
done
```

## 平台特性 & 注意事项

| 平台 | 数据稳定性 | 特殊事项 |
|---|---|---|
| B 站 | 高 | 走官方 API + WBI 签名，不受 DOM 变化影响 |
| 小红书 | 中 | 笔记搜索/评论需用户已登录；DOM 变更可能导致命令需更新 |
| 微博 | 中 | search 第一条常是营销帖，先用 `post` 确认；评论必须用 numeric id |
| 抖音/TikTok | 中 | 视频评论受平台分桶影响，部分内容可能限制访问 |

**通用风险**：高频操作仍有封号风险，rate-limiter 降低风险但不能消除。建议生产环境单用户每分钟 ≤ 10 次命令（relay 默认 30 RPM 是上限，不是建议值）。

## CSP 限制

opencli 大多数命令底层走 `evalScript`，受目标页面 CSP 约束。中文社媒（小红书、B 站、微博、抖音）都没问题；严格 CSP 站点（Twitter/X、GitHub、Stripe 等）会被拒绝。详见 `DEPLOYMENT.md` §3.2 末尾。
