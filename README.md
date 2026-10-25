# dsh-claudecode-prompt

> 让 DeepSeek Harness 用 Claude Code 的系统提示词跑。**只换提示词**，工具、运行时上下文、模型、UI、其他插件一律不动。

一个 DSH bundle（Cordis 插件）。它在 `system-prompt/assemble` 瀑布的**最外层**接管整份系统提示词，把它换成真实捕获的 Claude Code v2.1.310 系统提示词，然后把 `contexts`（工作目录 / 沙箱策略 / 审批策略）、`tools`（工具 schema）、`variables` 原样放回。

```
替换前（DSH）                                替换后（本插件）
harness:identity                             claudecode:identity   ← "You are a Claude agent, …"
plan:policy / team:policy / ptc              claudecode:prompt     ← Claude Code 主体提示词
tool:bash / tool:read / tool:edit / …        （DSH 的 tool:* 段全部移除）
mcp:servers / deliverable / harness-source   [keepSections 指定要保留的段]
```

工具 schema 仍然照常下发，所以模型手上还是 `ops_bash`、`read`、`edit`、`subagent` 这些——只是它被告知的是 Claude Code 的行为准则。

---

## 快速开始

前提：DSH 桌面版，profile 目录形如 `~/.dsh/profiles/<name>/`。

### 1. 把包放进 profile

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": {
    "dsh-claudecode-prompt": "link:D:/dsh/dsh-claudecode-prompt"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … 其它 bundle …
        "dsh-sunder",              // ← 必须在它后面
        "dsh-claudecode-prompt"    // ← 放在最后
      ]
    }
  }
}
```

或者直接从 GitHub 装：

```bash
npm install --save "github:menghuanshiguang/dsh-claudecode-prompt"
```

**顺序很重要。** 两个 bundle 都用 `prepend: true` 注册瀑布监听，后注册的在最外层、对返回值有最终发言权。把本包排在 `dsh-sunder` 之后，它才拿得到最后一手。

### 2. 关掉 sunder 的装配守卫

`sunder` 默认 `guard: true`，会包住 `assemble` 方法本身：它看到不是自己产出的提示词就把自己的三段抢回去。**任何监听器都压不过它**，只能关掉：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: sunder
  config:
    guard: false
```

sunder 其它功能（工具、每轮 rule card、公告）不受影响，只是它不再往系统提示词里塞 `sunder:identity / rules / footer` 三段。

> 如果你不装 sunder，这一步不需要。

想留着 sunder 那三段（身份头、规则卡、页脚），把它们加进 `keepSections`，本插件会按原始顺序把它们插回去：`sunder:identity` 落在正文之前，`sunder:rules` / `sunder:footer` 落在正文之后。

```yaml
- id: claudecode-prompt
  config:
    keepSections: ["astra:identity-head", "astra:identity", "sunder:identity", "sunder:rules", "sunder:footer"]
```

### 3. 重启 DSH

bundle 列表变化需要重启（只改配置的话 patch 会热载）。

验证：把 `debug` 打开，看装配时的日志。

```yaml
- id: claudecode-prompt
  config:
    debug: true
```

一条真实 DSH 启动（`dsh --profile headless`，插件首次装配）的输出：

```
[dsh-claudecode-prompt] active — variant=cli source=…\node_modules\dsh-claudecode-prompt\prompt\claude-code-cli.md chars=13557 identity=on tools=dsh rewrites=7 dropped=[memory] keep=[]
[dsh-claudecode-prompt] sections 16 -> 2 [claudecode:identity, claudecode:prompt]
PROBE-OK
```

16 段 DSH 提示词被换成 2 段，模型随后正常回了话。`chars=13557` 是清洗后的正文长度：27,036 的原始正文减去 memory 段、动态尾、改名，再减去 `rewrites=7` 删掉的那几句指向不存在工具的话。

装了 `dsh-sunder` 并保留它三段的真机启动（第二次探针，`guard: false` + `keepSections`）：

```
[dsh-sunder] v1.6.1 active — … guard=off
[dsh-claudecode-prompt] active — variant=cli … keep=[sunder:identity, sunder:rules, sunder:footer]
[dsh-claudecode-prompt] sections 19 -> 5 [sunder:identity, claudecode:identity, claudecode:prompt, sunder:rules, sunder:footer]
```

`debug: true` 还会再打一行 `orders …`（每段的 order，查不到的显示 `null`），排位不对时先看它。

---

## 配置

全部可选项，`cordis.patch.yml` 里按 `- id: claudecode-prompt` 覆盖即可。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 完全不接管，注册都不注册 |
| `variant` | `cli` | `cli`（27 kB，`claude -p` / SDK 入口）或 `vscode`（5.7 kB，VSCode 扩展入口） |
| `promptPath` | `null` | 换成一任意 `.md`：绝对路径或相对 cwd |
| `identity` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | 身份行，独立成段 |
| `includeIdentity` | `true` | 关掉后只剩正文一段 |
| `stripDynamicTail` | `true` | 去掉 Claude Code 每次请求都追加的 `<total_tokens>…</total_tokens>` |
| `dropSections` | `[memory]` | 按 H1 标题丢弃整段（整词匹配，`memory` 同时命中 `# Memory` 和 `# auto memory`） |
| `toolNames` | `dsh` | `dsh` = 把提示词里的 Claude Code 工具名换成 Harness 名字；`verbatim` = 原样 |
| `toolNameMap` | `{}` | 追加/覆盖映射，如 `{ Agent: subagent_fork }` |
| `rewrites` | 7 条默认规则 | 改名之后整句改写。`false` = 一句不改；给数组 = **替换**默认规则，不是追加 |
| `keepSections` | `[]` | 要保留的其它插件的段名，例如 `[astra:identity-head, astra:identity]` |
| `sectionPrefix` | `claudecode` | 段名 = `<prefix>:identity` / `<prefix>:prompt` |
| `identityOrder` | `100` | 身份段的排序位 |
| `promptOrder` | `950` | 正文段的排序位（DSH 的 `tool:*` 段在 1000+） |
| `debug` | `false` | 每次装配打印段列表 + 各段 order |

### 例子：保留另一个插件的身份锚点

装了 `@local/dsh-astra-identity` 之类在 `system-prompt` 上挂段的插件，希望它别被抹掉：

```yaml
- id: claudecode-prompt
  config:
    keepSections: ["astra:identity-head", "astra:identity"]
```

保留段按 order 重新排位：`astra:identity-head`（901）落在正文之前，`astra:identity`（20000）落在正文之后（recency 位置）。order 优先问注册表 `getSectionOrder()`，但真机实测从插件作用域里它对**所有**段都返回空（连 DSH 自己的 `tool:read` 也是），所以实际以包内置的 order 表兜底（照抄 `dsh-system-prompt` 的 `SECTION_ORDERS`），表里没有的段取它在原始装配里的邻居——装配数组本身已按 order 排好，落在上一个已知 order 与下一个之间；两头都没有邻居才放正文之前。

### 例子：完全不动提示词的工具名

```yaml
- id: claudecode-prompt
  config:
    toolNames: verbatim
    rewrites: false         # 连句子也别改，逐字用 CC 原文
    dropSections: []        # 连 memory 段也保留
```

### 为什么要改写句子

改名只换了词，句子还在讲这里没有的东西：`Calling Agent with subagent_type: "fork"`、`invoke it via Skill`、`Get help with using Claude Code`、`report the issue at https://github.com/anthropics/claude-code/issues`、`claude.ai/code` 上的 web app、`/fast`、以及 Claude 5 系列模型名。模型读到这些会去试着调不存在的东西，所以 `rewrites` 在改名之后整句处理，默认 7 条：

```yaml
- id: claudecode-prompt
  config:
    rewrites:
      - pattern: '^  - /help: Get help with using Claude Code\r?\n'
        replace: ''
      - pattern: 'Better to run it via (?:the )?Skill'
        replace: 'better to run it via the skill tool'
        flags: gi           # 可省，默认 g
```

`pattern` 是 JS 正则源码，`replace` 支持 `$1`。**给数组是替换默认规则**：一套规则只对付一个 CC 版本，悄悄追加会让人无法从配置回答"这句是谁删的"。规则在装配时按顺序跑，跑完把 3 个以上连续空行压成 2 个、去掉首尾空行；`rewrites: false` 时连这个清理也不做——说不动就不动。正则全部在配置归一化时预编译，写错了 boot 时就报 `invalid rewrite pattern …` 并带上出错的那条 `pattern`。

---

## 提示词是怎么来的

不是从 296 MB 的 `claude.exe` 里抠字符串（那里面字符串是碎片化的，拼不出整段），而是**起一个本地 mock Anthropic API，让 Claude Code 把真实请求发过来，抓 `system[]` 字段**。脚本在 `tools/capture_cc_prompt.py`，两种入口：

```bash
# claude -p（SDK / CLI 入口）
python tools/capture_cc_prompt.py

# VSCode 扩展入口（--input-format stream-json + CLAUDE_CODE_ENTRYPOINT=claude-vscode）
CAPTURE_MODE=vscode python tools/capture_cc_prompt.py
```

抓到的 `system[]` 是三段：计费头、身份行、正文。本包 vendored 的是**正文与身份行，逐字未改**：

| 文件 | 入口 | 字符数 |
| --- | --- | --- |
| `prompt/claude-code-cli.md` | `claude -p` / SDK | 27,036 |
| `prompt/claude-code-vscode.md` | VSCode 扩展 | 5,665 |

VSCode 那次额外抓到一条 `role: "system"` 的 10,036 字符消息（`# Environment` 动态环境 + 延迟工具清单）——那是**动态**部分，没进静态提示词，Harness 用自己的 runtime context 顶上，所以本包不塞它。

所有清洗都在运行时、按配置执行，vendored 文件保持原样，方便审计"Anthropic 发的是什么"和"这里发出去的是什么"的差异：

1. `<total_tokens>` 尾巴——抓取机冻结的余量数字，在 Harness 里是错的。
2. `# auto memory` / `# Memory` 段——Claude Code 的文件记忆库，Harness 没有，且正文里带着抓取机的绝对路径。
3. 提示词正文里出现的 4 处工具名（`PowerShell` / `Read, Edit, Write, Glob, Grep` / `TaskCreate` / `Agent` / `Skill`）→ Harness 名字（`pwsh` / `read, edit, write, glob, grep` / `todo_write` / `subagent` / `skill`）。单遍正则替换，不会连锁（`A→B` 不会再被 `B→C` 吃掉）。

---

## 兼容性与已知差异

- **模型自我认知**：提示词会让模型自称 Claude agent。这是"换提示词"的题中之义；要改就改 `identity`。
- **工具语义只对齐了名字**：`todo_write` 不等于 Claude Code 的 `TaskCreate`（没有 task 生命周期），`subagent` 的 `subagent_type: "fork"` 在 Harness 里对应 `subagent_fork`。语义差异用 `toolNameMap` 或自己的补丁段收敛。
- **运行时上下文仍在**：`Current runtime context`（工作目录 / 沙箱 / 审批）由 Harness 作为最后一条 user 消息发给模型，不属于 `systemPrompt.sections`，本插件不碰。
- **sunder 的每轮 rule card** 也是 user 消息，不在系统提示词里，照旧生效。
- **提示词缓存**：装上的那一刻系统前缀变了，缓存重建一次；之后稳定。
- **坏配置不炸 boot**：`variant` 写错、`promptPath` 不存在、`rewrites` 里的正则写坏，都只打两行错（`disabled — …` + `the harness will use its own prompt`），注册 0 个监听，DSH 用自己的提示词继续跑。装配时（瀑布里）抛的错照旧往外抛：半改写的提示词比不替换更糟。
- **别的插件注册 `complete: true` 段**会整段覆盖回来（装配瀑布里 complete 段最终成为唯一段）。同理，谁最后注册谁赢——所以顺序那件事是真的。

卸载 = 从 `bundles` 里删掉本包，`guard: false` 也可以还原。没有残留配置。

---

## 开发

```bash
node --test            # 43 个测试
npm run verify         # 起一个一次性 profile，真 boot 一次，断言替换生效
node --test 2>&1 | tail
```

- `test/transform.test.mjs`：纯文本层（动态尾、整词丢段、单遍改名、组合、配置归一化），并断言产出的提示词确实干净（无 token 尾、无 memory 段、无抓取机路径、无 Claude Code 工具名）。
- `test/assemble.test.mjs`：对着假 `systemPrompt` 服务跑真的 `apply()`，模拟瀑布语义（`prepend` 后注册者最外层），验证：替换生效、contexts/tools/variables 原样、`keepSections` 按 order 排位、`interpolate:false`、以及守卫先/后注册各是什么结果；另外覆盖坏配置不炸 boot（`variant` 写错、`promptPath` 不存在）——日志两行、注册 0 个监听、DSH 用回自己的提示词。
- `test/drift.test.mjs`：两份"别人的数据"的防腐检查。`prompt/*.md` 用 `prompt/VERSION.json` 的 sha256/字节数/行数钉住，改一个字就报 `prompt files changed; refresh prompt/VERSION.json`；`KNOWN_SECTION_ORDERS` 是 `SECTION_ORDERS` 的手抄本，测试直接从 `app.asar` 里读出真包（纯 Node 的 `readFileSync` 打不开 asar，头部 pickle 由 `readAsarEntry` 手解），按命名约定对完 32 个常量，order 一动就报 `section orders moved … update KNOWN_SECTION_ORDERS in index.js`。
- `npm run verify`：单元测试喂的是假服务，只有真 boot 才能证明插件在真装配里生效。它建一个 pid 唯一的临时 profile（**不碰 `desktop`**），junction 进仓库，跑一句 headless prompt，断言 `active —` 行和 `sections N -> 2 [claudecode:identity, claudecode:prompt]` 行；`dsh` 不在 PATH 上时打印 SKIP 并退出 0，断言本身用假 `dsh` 反证过（不会空过）。

目录：

```
index.js             插件本体（system-prompt/assemble 监听）
lib/transform.js     纯文本变换
lib/config.js        配置归一化 + 提示词文件解析
prompt/*.md          逐字 vendored 的 CC 提示词
cordis.patch.yml     bundle 层：只挂一行
tools/capture_cc_prompt.py  抓取脚本（复现用）
tools/verify.mjs     真机 boot 验证（npm run verify）
prompt/VERSION.json  提示词指纹（sha256/字节数/行数 + 来源版本）
docs/ARCHITECTURE.md 装配流水线、守卫、为什么不用 complete 段
```

---

## 授权与来源

本仓库**代码**：MIT（见 `LICENSE`）。

`prompt/` 下的提示词文本来自 Anthropic 的 Claude Code（v2.1.310，本机安装的 VSCode 扩展 / 原生二进制），**版权归 Anthropic**。这里原样收录是为了互操作性研究、提示词工程对比和本地个人使用，MIT 不覆盖这部分文本。要转载/再分发提示词正文，请自行确认授权。
