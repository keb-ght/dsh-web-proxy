# 贡献指南

## 能提什么

- 反代链路本身的 bug（PoW、SSE 解析、工具调用协议）
- 管理界面、文档、错误处理
- 新协议的适配层（例如别的兼容格式）
- 性能与稳定性

## 不接收什么

以下内容**不进仓库**，PR 会被关闭：

- **任何硬编码的第三方密钥、公钥、证书**
- 自动登录 / 批量注册 / 验证码绕过的实现
- 账号池以外的凭证窃取、会话劫持相关代码
- 从他人账号导出的 token、cookie、设备指纹

## 扩展点：`src/providers/`

凭证获取做成插件接口，仓库只带 `manual`（用户自己从浏览器复制 token）。

想接入别的获取方式，**自己写在本地，不要提交**：

```js
// 你本地自己的文件，不进仓库
import { registerProvider } from './src/providers/index.mjs';

registerProvider({
  name: 'my-provider',
  async acquire(ctx) {
    // 自己实现：从哪拿 token、怎么拿
    return { token: '...', deviceId: 'uuid-v4' };
  },
});
```

接口约定见 [docs/PROVIDERS.md](docs/PROVIDERS.md)。
仓库里不会提供任何具体实现、密钥或协议细节。

## 提交前自查

```bash
# 别把运行时产物带进去
git status --short | grep -E 'secrets/|accounts\.json|\.log' && echo '有敏感文件！'
```

## 代码风格

- ESM，Node 18+
- 不加构建步骤，`.mjs` 直接跑
- 改完跑一遍自检：`node test/selftest.mjs`
- 涉及协议解析的改动，附上真实样例（脱敏）作为测试用例
