# Workflow Registry PRD

**版本**：v0.1  
**状态**：草稿  
**作者**：MK  

> ⚠️ 文中 `Authorization: Bearer <agent-jwt>` 示例已过期，认证已改成 PAT 模型 (`Bearer bpt_xxx`)，见 [`../docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)。不影响本文档主体的 workflow registry 设计。

---

## 一、背景与问题

当前 bridge 架构中，每个业务项目独立部署一套 relay + extension。AI Agent 可以通过 relay 向浏览器下发单步命令（navigate/extract/click 等），但**没有工作流层的抽象**：

- Agent 每次执行多步任务都要自己推理步骤，重复消耗 LLM tokens
- 多个项目部署了各自的 relay，各自发现的操作路径无法共享
- 页面改版后没有标准化的重新发现机制
- 缺少"已验证可用"的操作路径沉淀

**核心问题**：Agent 每次都从零探索，已发现的路径没有被复用。

---

## 二、目标

1. 让 Agent 发现的多步操作路径可以被**持久化、检索、复用**
2. 通用 workflow 可以**跨项目、跨组织共享**，降低新项目接入成本
3. 页面改版后能**低摩擦地重新发现**，不需要人工维护脚本
4. 私有业务流程**默认不对外暴露**，保证数据安全

---

## 三、核心概念

### Workflow

一个 workflow 是一个**命名的、可参数化的 bridge 命令序列**，由 Agent 探索后保存，供后续直接调用。

```yaml
id: feishu-submit-approval
name: 飞书提交审批
domain: feishu.cn
visibility: private          # private | pending-review | public
generalizability: high       # Agent 评估的可移植性
verified_at: 2026-05-14
failure_count: 0
steps:
  - action: navigate
    params:
      url: "{{approval_url}}"
  - action: execute
    params:
      scriptId: page.clickSelector
      scriptParams:
        selector: ".submit-btn"
  - action: extract
    params:
      type: title
```

`{{...}}` 为运行时变量，调用时传入。

### 三层存储

```
优先级（高 → 低）：

1. 本地私有          .data/workflows/          只有当前 relay 可访问
2. Org 私有 Registry  git private repo          同组织多项目可共享
3. 公共 Registry      git public repo           所有人可读
```

查找顺序：本地命中 → Org Registry → 公共 Registry → miss（触发 Agent POC）。

### Workflow 生命周期

```
Agent POC 探索
     ↓
保存为 private（本地）
     ↓
人工审核
  ├─ 业务强绑定 / 内网域名 → 保持 private
  └─ 通用性高 → publish → Org 或 Public Registry
     ↓
执行失败（failure_count 超阈值）
     ↓
标记 stale → 下次调用触发重新探索 → 覆盖旧 workflow
```

---

## 四、使用场景

### 场景 1：命中缓存（主路径）

```
业务 Agent: POST /workflow/run
  { workflowId: "feishu-submit-approval", vars: { approval_url: "..." } }
  
relay: 查找本地 → 命中 → 执行 steps → 返回结果
```

Agent 无需推理步骤，直接复用已验证路径。

### 场景 2：首次发现（POC 路径）

```
业务 Agent: POST /workflow/run
  { workflowId: "feishu-submit-approval", ... }
  
relay: 本地 miss → Org Registry miss → Public Registry miss
     → 返回 { ok: false, reason: "workflow_not_found" }
     
业务 Agent: 开启录制模式
  POST /command { action: "navigate", ... }   ← 正常执行
  POST /command { action: "execute", ... }    ← relay 同时录制
  POST /command { action: "extract", ... }
  
  POST /workflow/save { workflowId, steps, metadata }
  
relay: 保存为本地 private workflow
```

### 场景 3：改版重新发现

```
relay: failure_count >= 3 → 标记 stale

业务 Agent: POST /workflow/run
  → relay 返回 { ok: false, reason: "workflow_stale" }
  
业务 Agent: 走 POC 路径 → 生成新 workflow → 覆盖旧版本
```

### 场景 4：发布到 Registry

```
人工审核确认通用性
  POST /workflow/publish
  { workflowId: "feishu-submit-approval", target: "org" | "public" }
  
relay: 将 YAML push 到对应 Registry（PR 或直接 push）
```

---

## 五、私有 / 公有判断逻辑

**不需要人工逐个分类**，relay 保存时自动分析并给出建议，人工只需确认。

| 信号 | 判断 | 说明 |
|------|------|------|
| URL 域名是内网 | 强制 private | 外部无法访问，发布无意义 |
| params 含硬编码 ID / org token | 建议 private | 可参数化后再考虑发布 |
| 操作平台是公共 SaaS（feishu.cn、jd.com 等）| 候选 public | 需人工确认通用性 |
| steps 无业务特定数据 | 候选 public | Agent 给出 generalizability 评分 |

**默认全部 private，主动发布才变 public。私有 workflow 物理上不存在于 Registry，无需访问控制。**

---

## 六、API 设计

### 执行 workflow

```
POST /workflow/run
Authorization: Bearer <agent-jwt>

{
  "workflowId": "feishu-submit-approval",
  "vars": { "approval_url": "https://..." },
  "allowFallbackPOC": false   // true 时 miss 也不报错，让 Agent 自行 POC
}

Response:
{
  "ok": true,
  "source": "local" | "org-registry" | "public-registry",
  "result": { ... }
}

// miss 时：
{
  "ok": false,
  "reason": "workflow_not_found" | "workflow_stale",
  "workflowId": "feishu-submit-approval"
}
```

### 保存 workflow（POC 结束后）

```
POST /workflow/save
Authorization: Bearer <agent-jwt>

{
  "workflowId": "feishu-submit-approval",
  "name": "飞书提交审批",
  "steps": [ ... ],
  "vars": ["approval_url"],
  "domain": "feishu.cn",
  "agentNotes": "通用审批提交流程，无业务特定字段"
}
```

### 开启录制模式

```
POST /workflow/record/start  { "workflowId": "..." }
// 后续 /command 调用同时被记录

POST /workflow/record/stop
// 停止录制，生成 workflow draft，等待 /workflow/save 确认
```

### 发布到 Registry

```
POST /workflow/publish
Authorization: Bearer <agent-jwt>

{
  "workflowId": "feishu-submit-approval",
  "target": "org",            // org | public
  "registryUrl": "https://github.com/myorg/bridge-workflows"
}
```

### 查看 workflow 状态

```
GET /workflow/:workflowId
GET /workflow             // 列出所有本地 workflow（含 stale 状态）
```

---

## 七、relay 配置

```bash
# .env

# Registry 查找顺序（逗号分隔，本地始终第一）
WORKFLOW_REGISTRY_URLS=https://raw.githubusercontent.com/myorg/private-workflows/main,https://raw.githubusercontent.com/community/bridge-workflows/main

# 私有 Registry 认证（GitHub token）
WORKFLOW_REGISTRY_TOKEN=ghp_xxx

# failure_count 超过多少触发 stale
WORKFLOW_STALE_THRESHOLD=3

# 是否允许 Agent 直接 publish（false 则需要人工调用 API）
WORKFLOW_AUTO_PUBLISH=false
```

---

## 八、Workflow YAML Schema

```yaml
# 必填字段
id: string                    # 全局唯一，建议 {platform}-{action}
name: string                  # 人可读名称
domain: string                # 主操作域名，用于私有判断
steps:                        # 命令序列
  - action: string            # bridge action（navigate/execute/extract 等）
    params: object            # 支持 {{var}} 模板变量

# 自动生成字段
visibility: private | pending-review | public
verified_at: ISO8601
failure_count: number
created_by: string            # agentId 或 userId
source_relay: string          # 哪个 relay 发现的

# 可选字段
vars:                         # 声明模板变量及描述
  - name: approval_url
    description: 审批详情页 URL
    required: true
generalizability: low | medium | high   # Agent 评估
agent_notes: string           # Agent 的探索备注，辅助人工审核
tags: [string]
```

---

## 九、网络效应机制

```
新项目接入 bridge
     ↓
配置 WORKFLOW_REGISTRY_URLS（指向 Org + Public Registry）
     ↓
Agent 第一次运行时，多数常见平台操作已有现成 workflow
     ↓
POC 成本趋近于零（只有业务特有流程需要探索）
     ↓
探索结果沉淀为新 workflow → 发布回 Registry
     ↓
后续项目受益
```

贡献门槛：Agent 自动生成 YAML draft，人工只需审核"这个可以公开吗"，不需要手写脚本。

---

## 十、MVP 范围

**Phase 1（核心路径）**：
- [ ] `POST /workflow/run` — 本地查找 + 执行
- [ ] `POST /workflow/save` — 保存本地 private workflow
- [ ] Workflow YAML 格式定义 + vars 模板替换
- [ ] `failure_count` 累积 + stale 标记

**Phase 2（Registry 集成）**：
- [ ] `WORKFLOW_REGISTRY_URLS` 配置 + HTTP pull
- [ ] `POST /workflow/publish` — push 到 Registry
- [ ] 录制模式（`/workflow/record/start` + `/stop`）

**Phase 3（治理）**：
- [ ] `pending-review` 状态 + 审核 UI 或 CLI
- [ ] generalizability 自动评估（调 LLM 分析 steps）
- [ ] Registry 版本管理（workflow 更新时保留历史）

---

## 十一、不在范围内

- Workflow 可视化编辑器（业务方通过 YAML 或 Agent 生成，不做 GUI）
- 跨平台执行引擎（不支持非 bridge action，如直接调 API）
- Workflow 权限细粒度控制（私有 = 本地，公有 = Registry，不做中间态 ACL）
