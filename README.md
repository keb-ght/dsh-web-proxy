# dsh-web-proxy

> 把 chat.deepseek.com 网页版包装成 OpenAI / Anthropic 兼容 API，并作为 DeepSeek Harness（DSH）插件运行。
> 自带账号池、PoW 求解、工具调用协议、多模态图片输入、管理界面与热加载。

---

## ⚠️ 先读这一段：这不是给所有人用的

**这个项目做的事，本质上是「用网页版的额度，冒充 API」。** 在你动手之前，请把下面每一条都读一遍。

### 1. 这违反 DeepSeek 的服务条款

DeepSeek 网页版的用户协议明确限制「使用自动化程序访问、抓取、批量调用」。本项目通过复现其前端协议
（PoW 挑战、设备指纹、SSE 增量格式）来达成自动化访问，**属于条款禁止的行为**。

后果自负，且可能包括：

- 账号被限流（表现为 `40029 IP_ACCESS_RESTRICTED`，前端提示「操作太快」）
- 账号被临时或永久封禁（`40012 USER_IS_BANNED`）
- 同一网络出口下的其他账号被连带风控

**不要用你的主力账号跑这个。** 如果一定要试，用小号。

### 2. 你的 token 等同于账号登录态

反代需要你的 `userToken`。持有它的人可以：

- 读取你的全部会话历史
- 以你的身份发消息（消耗你的额度）
- 看到你的账号基本信息

它**不能**改密码、不能看支付信息、不能删除账号——但这已经足够危险。

本项目把 token 明文存在 `~/.dsh/dsh-web-proxy/accounts.json`，权限 `0600`。
如果你在共享机器、多用户环境、或者会备份整个 home 目录的场景下使用，**先想清楚**。

想立刻作废：DeepSeek 网页版 → 设置 → 退出所有设备。

### 3. token 会频繁失效

实测从早到晚高强度使用，一天内失效 3 次。原因可能是：

- 网页版 token 本身寿命短
- 多设备登录互顶
- 风控主动踢下线

失效后请求会返回 `INVALID_TOKEN`，账号状态变成 `needs_login`，需要重新走一次网页登录。
本项目**不提供自动登录**（那是另一回事，见下方「不做什么」）。

### 4. 别把它暴露到公网

默认只监听 `127.0.0.1`，管理 API 用独立 token 校验，CORS 只放行回环来源。
**不要**改成 `0.0.0.0` 然后端口映射出去——那等于把你账号的免费额度开放给整个互联网，
并且管理界面的导出功能会泄露明文 token。

### 5. 上游随时可能改协议

这不是官方 API，没有版本承诺。DeepSeek 前端改一次 PoW 算法、改一次 SSE 格式、
改一次工具调用标记，本项目就可能整体失效。

项目里的 `scripts/fetch-assets.mjs` 会从线上拉最新的静态资源，
但如果协议本身变了，需要重新逆向——这部分维护成本由使用者承担。

---

## 它到底是什么

```
┌──────────────┐   OpenAI / Anthropic 协议    ┌──────────────┐
│  你的客户端   │ ──────────────────────────▶ │  dsh-web-proxy│
│ (SDK / DSH)  │                              │   :8787       │
└──────────────┘ ◀────────────────────────── └──────┬───────┘
                 SSE / JSON                          │
                                                     │ 复现网页版协议
                                                     ▼
                                          ┌────────────────────┐
                                          │ chat.deepseek.com  │
                                          │  PoW 挑战 / SSE 流  │
                                          └────────────────────┘
```

中间那一层做的事情：

1. **协议翻译** —— 把 OpenAI 的 `messages` 拍平成网页版单输入框的 prompt
2. **PoW 求解** —— 每个请求现取挑战，用官方 wasm 算出 `X-DS-PoW-Response`
3. **SSE 解析** —— 网页版的增量是 `{p,o,v}` 补丁 + `{"v":"字"}` 简写，翻译成标准 chunk
4. **工具调用** —— 网页版没有原生 function calling，靠提示词协议 + 6 种格式兜底解析
5. **多模态** —— 图片先上传拿 `file_id`，再带 `ref_file_ids` 发对话
6. **账号管理** —— 轮转、冷却、限速、熔断、定时探活

## 功能状态

| 能力 | 状态 | 备注 |
|---|---|---|
| OpenAI `/v1/chat/completions` | ✅ | 流式 / 非流式 |
| Anthropic `/v1/messages` | ✅ | 含 `message_start/delta/stop` 全事件 |
| DeepSeekHashV1 PoW | ✅ | 复用官方 worker + wasm，不重写算法 |
| SSE 增量解析 | ✅ | 全量包 + `{p,o,v}` 补丁 + `{"v":"x"}` 简写 + BATCH |
| 工具调用（function calling） | ✅ | 标记协议 + 6 种自然格式兜底 |
| 多模态图片输入 | ✅ | base64 / http URL，单图 8MB 上限 |
| 账号池 | ✅ | 轮转 / 冷却 / 限速 / 熔断 / 每小时探活 |
| 管理界面 | ✅ | 账号池 / 请求日志 / 模型映射 / 设置 |
| 网页登录（自动抓 token） | ✅ | 同源代理登录页，密码不经过本项目代码 |
| 热加载 | ✅ | 改代码自动重启子进程，端口稳定 |
| 自动登录 / 刷新 token | ❌ | 见下方「不做什么」 |
| 多模态图片**输出** | ❌ | 网页版本身不支持 |

## 安装

### 作为 DSH 插件

```bash
dsh plugin --profile web add link:/path/to/dsh-web-proxy
```

重启 DSH 后：
- 插件页出现 `dsh-web-proxy`
- 设置 → **反代** 里是完整管理界面

### 独立运行

```bash
npm run fetch-assets      # 首次：拉 PoW 依赖（第三方 CDN 产物，不随仓库分发）
cp config.example.json config.json
npm start                 # → http://127.0.0.1:8787
```

## 导入账号

**方式一：网页登录（推荐）**

打开 `http://127.0.0.1:8787/login`，在里面正常登录。
页面被同源代理到本机，登录成功后脚本读 `localStorage.userToken` 自动入库。
**你的密码只在这个页面里流转，不经过本项目的任何代码。**

**方式二：手动粘贴**

浏览器登录 chat.deepseek.com → F12 → Application → Local Storage → `userToken`
→ 复制里面对应的 token → 管理界面「导入账号」。

## 使用

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")
print(c.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "1+1"}],
).choices[0].message.content)
```

图片：

```python
c.chat.completions.create(model="deepseek-chat", messages=[{
    "role": "user",
    "content": [
        {"type": "text", "text": "这张图什么颜色？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
    ],
}])
```

模型：`deepseek-chat`（快速）/ `deepseek-reasoner`（深度思考）。
思考强度只有开/关两态（上游限制），`reasoning_effort: "off"` 才真正关闭。

## 架构

```
dsp/
├── server.mjs        HTTP 服务 + 路由 + 管理 API
├── upstream.mjs      上游请求、header 整形、PoW 调度、SSE 直读
├── chat.mjs          会话编排、prompt 拼装、工具协议、重试熔断
├── sse.mjs           SSE 解析 + 补丁应用 + 文本抽取
├── tool-parser.mjs   工具调用解析（移植自 ds-free-api，GPL-3.0）
├── vision.mjs        图片上传 + 状态轮询
├── anthropic.mjs     Anthropic Messages 兼容层
├── accounts.mjs      账号池
├── models.mjs        模型映射
├── metrics.mjs       运行指标
├── errors.mjs        上游错误码 → 语义 + 动作
├── browser.mjs       慢路径（Playwright，可选）
├── providers/        凭证获取扩展点
├── pow/              PoW 求解（worker_threads + 官方 wasm）
└── admin/            管理界面（单文件 HTML + 登录页注入脚本）
```

## 不做什么

明确**不提供**的能力，PR 也不会接受：

- 自动登录、批量注册、验证码识别
- 任何硬编码的第三方密钥、公钥、证书
- 账号池以外的凭证获取方式

`dsp/providers/` 是留给扩展的接口，你想接自己的凭证获取方式，写在本地，不要提交。

## 已知问题

| 问题 | 说明 |
|---|---|
| token 频繁失效 | 网页版限制，需定期重登 |
| 8MB body 上限 | 对应原图约 6MB |
| 大图解析慢 | 上传后轮询最长 25s |
| 上游改版即失效 | 非官方 API，无兼容承诺 |

## 许可证

**GPL-3.0**

`dsp/tool-parser.mjs` 移植自 [NIyueeE/ds-free-api](https://github.com/NIyueeE/ds-free-api)（GPL-3.0）
的 `src/openai_adapter/response/tool_parser.rs`。依 GPL-3.0 第 5 条，本作品整体以 GPL-3.0 发布。

若你需要宽松许可证，可以删除该文件并自行实现工具解析——其余部分是独立编写的。

## 免责声明

本项目仅供**个人学习与本地便利**使用。

作者不对以下情况承担任何责任：账号被封、额度损失、数据泄露、服务中断、
以及因违反第三方服务条款而产生的任何后果。

**使用即表示你已知悉上述全部风险，并自行承担。**
