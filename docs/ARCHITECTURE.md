# 架构：DSH 的系统提示词是怎么装配的，以及本插件插在哪一层

## 1. 装配流水线

DSH 由一个 `systemPrompt` 服务（`@deepseek-ai/dsh-system-prompt`，0.2.1-rc.3）负责系统提示词。它的产物不是一段字符串，而是一个装配体：

```ts
PromptAssembly = {
  sections:  AssembledSection[]   // { name, text, interpolate? }
  contexts:  AssembledContext[]   // 运行时上下文，渲染成最后一条 user 消息
  tools:     ToolSchema[]         // 工具 schema
  variables: Record<string, string | undefined>
}
```

各插件通过两条通道往里加内容：

- `ctx.systemPrompt.section({ name, order, text, complete? })` —— 加一段提示词。同名冲突直接抛错；`order` 决定排位。
- `ctx.systemPrompt.context({ name, order, text, required? })` —— 加一条运行时上下文（工作目录、沙箱策略、审批策略、团队身份……）。**不属于 `sections`**。

装配时：

1. 服务按 `order` 收集所有 section，按顺序排列；
2. 跑 `system-prompt/assemble` 瀑布，每个监听器可以整个替换返回值；
3. 若存在生效的 `complete: true` 段，**装配体最终被替换为那一段**（官方提供的"整段接管"机制）；
4. 渲染：`sections` 用 `\n\n` 连接，`{{…}}` 走插值（`interpolate === false` 的段除外）；`contexts` 拼成 `Current runtime context…` 前置消息。

本插件在**第 2 步**动刀，所以第 3 步的 complete 逻辑碰不到它，`contexts` / `tools` / `variables` 也全部原样带过。

### 关键 order（摘自 `@deepseek-ai/dsh-system-prompt`）

| order | 段 |
| --- | --- |
| -1000 | `harness:identity`（"You are an AI agent powered by DeepSeek Harness."） |
| 0 | `deployment:persona-prefix` |
| 500 / 600 | 计划策略 / 团队策略 |
| 800 | PTC-only |
| 900 | 文件引用规则 |
| 1000–3000 | 各工具说明（`tool:bash` … `tool:computer-use`） |
| 3100 | MCP |
| 5000 | tools SDK |
| 9000 / 9900 | 交付文件引用 / 结构化输出 |
| 10000 / 10100 | Harness 源码说明 / Web 界面说明 |
| 10200 | `deployment:persona-suffix` |

本文档不硬编码这份表进代码：需要判断某个保全段的排位时，直接问注册表 `ctx.systemPrompt.getSectionOrder(name)`，DSH 重排段位时插件跟着动。

本插件自己的两个段：`<prefix>:identity`（默认 100）与 `<prefix>:prompt`（默认 950）。

## 2. 为什么不用 `complete: true`

官方写法是注册一个 `complete: true` 的段，装配体直接变成它。简单，但有两个硬伤：

1. **无法与 `keepSections` 共存。** complete 是把 `sections` 换成 `[这一段的]`，任何"保留另一个插件的身份段"的需求都做不了。而真实 profile 里往往装着在提示词上挂段的插件（身份锚点、语言包、人格层），一刀切会把它们全抹掉。
2. **会被 sunder 的守卫抢回。** 见下节。

## 3. sunder 的装配守卫，以及为什么本包必须排在它后面

`dsh-sunder` 做了两件事来保证"自己的提示词段永远在"：

```js
// 1) 属性包装：把 promptService.assemble 换成自己的包装函数
if (config.guard === false) return false
Object.defineProperty(promptService, 'assemble', { get, set })
  // 包装体内部：const assembled = await original(); return ensureSunderSections(assembled, …)

// 2) 瀑布监听：{ global: true, prepend: true }
ctx.on('system-prompt/assemble', async (...args) => {
  installGuard()
  const result = await next()
  return ensureSunderSections(result, config.guard === false ? … )   // 注意：不受 guard 影响
})
```

`ensureSunderSections` 的判定：

```js
if (assembly.sections.length === 1 && !SUNDER_SECTION_NAMES.has(assembly.sections[0]?.name))
  return { ...assembly, sections: [...sunderSections] }   // 认定被外来 complete 段接管，抢回
// 否则：把自己的三段补齐
```

后果：

- **任何 `complete: true` 的接管都会输**——单段结果正好命中第一条判定。
- **`guard: false` 只关掉属性包装**，瀑布监听照样跑。属性包装是最致命的：它包在 `assemble` 外面，本插件的监听器在 `assemble` 内部，无论排多前都只是"内层"，返回值还要过一遍它的后处理。所以装 sunder 的 profile 必须 `guard: false`。
- 关掉守卫后，只剩瀑布监听可比。**`prepend` 是 unshift**，后注册的排在数组最前；瀑布里第一个监听器在最外层，也就是对返回值有最终发言权。因此 bundle 顺序决定胜负：本包排 `dsh-sunder` 之后 → 本包赢。

测试 `test/assemble.test.mjs` 把这两种顺序都跑了，行为是写死的断言，不是注释里的承诺。

## 4. 段位保留（keepSections）

保留段按注册表 order 重新插回去：

```
order:  100           901                950               20000
        claudecode:   astra:identity     claudecode:       astra:identity
        identity      -head              prompt            (core)

注册表查不到 order 的保留段走两级兜底：先查内置表 `KNOWN_SECTION_ORDERS`（照抄 `@deepseek-ai/dsh-system-prompt` 0.2.1-rc.3 的 `SECTION_ORDERS`，键是包自己注册的段名），再查不到就取原始装配里的邻居——数组已按 order 排好序，向上取下一个已知 order、向下取上一个，落在两者之间；两头都没有邻居才放正文之前。

这条不是理论：真机首跑时 `getSectionOrder()` 对本插件作用域返回不了**任何**段的 order（连 DSH 自己的 `plan:policy`、`tool:read` 都是 null，debug 日志里 `orders …=null` 一长串），所有保留段一起塌到占位 order，sunder 的 rules/footer 就排到了 Claude Code 正文前面。现在内置表 + 邻居插值，`sunder:identity` 落在正文前、`sunder:rules`/`sunder:footer` 落在正文后，真机 debug 日志：
`sections 19 -> 5 [sunder:identity, claudecode:identity, claudecode:prompt, sunder:rules, sunder:footer]`。

`test/assemble.test.mjs` 有两条回归用例（"borrow their neighbours"、"static order table"），断言的就是这两个场景。
```

文本、`interpolate` 标志都原样传递，插件不重写别人的段。

## 5. 一条请求最后长什么样

```
system:
  You are a Claude agent, built on Anthropic's Claude Agent SDK.   ← claudecode:identity

  <Claude Code 主体提示词，27 kB 或 5.7 kB>                        ← claudecode:prompt

  [保留的其它段]

user:
  Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

  Current working directory: "…"                                  ← 原样，本插件不碰
  Current DSH file policy: …
  …
```

## 6. 怎么自己验证

- `node --test`：25 个测试，含假服务上的瀑布语义。
- 真机：`- id: claudecode-prompt config: { debug: true }` → 每次装配打印段数变化与段名。
- 想拿到运行时真实装配文本：目前 DSH 的 inspect provider 只有 `Service/Event/Config/Tool`（host）与 `Builtin/Slots/Theme`（client），没有 prompt 查看器；要么开 `debug`，要么临时挂一个记录装配体的探针插件。
