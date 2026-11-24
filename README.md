# ASR Transcription QA Workbench

语音转写质检与校准工作台。支持导入音频和参考转写 JSON、使用 Gemini 执行转写校准、人声段识别、批量查看及导出结果。

## 环境要求

- Node.js 20.19+ 或 22.12+
- npm
- Gemini API key（运行 AI 校准和人声识别时需要）

## 本地开发

1. 安装依赖：

   ```bash
   npm ci
   ```

2. 复制 `.env.example` 为 `.env`，填入 Gemini API key：

   ```dotenv
   GEMINI_API_KEY=your_api_key
   ```

3. 启动开发服务：

   ```bash
   npm run dev
   ```

   默认在 `http://localhost:3000` 打开工作台。

## 桌面版打包

桌面版使用 Electron 打开工作台，并在本机启动 API 服务。

### Windows

在 Windows 上运行：

```bash
npm ci
npm run desktop:win
```

### macOS

在 Mac 上运行（不能在 Windows 上生成 macOS `.dmg`）：

```bash
npm ci
npm run desktop:mac
```

安装包输出到 `release/`。打包默认使用当前电脑的 Mac 架构。未签名和公证的 macOS 安装包可能会显示开发者验证提示；公开分发前应使用 Apple Developer ID 签名并完成公证。

桌面版首次启动时会提示输入 Gemini API key，并使用操作系统安全存储加密保存。不要把真实 API key 提交到代码仓库。

## 本地作业与音频存储

桌面版会保存作业记录和原始音频；默认一直保留，直到用户手动删除。保存目录使用英文名称：

- Windows：`%LOCALAPPDATA%\ASR-Workbench\Job-History`
- macOS：`~/Library/Application Support/ASR-Workbench/Job-History`
- Linux：`$XDG_DATA_HOME/ASR-Workbench/Job-History`；未设置 `XDG_DATA_HOME` 时为 `~/.local/share/ASR-Workbench/Job-History`

“批量汇总”页面会显示当前使用的完整目录。删除作业目录中的单个记录文件夹可删除对应作业和音频；删除整个 `Job-History` 文件夹可清空全部历史。将作业从当前队列移除不会删除磁盘上的记录。

旧版中文目录中的历史记录会在新版首次读取历史时复制到新目录，旧目录会保留；确认新目录中的记录完整后，可手动删除旧目录。

如需指定其他保存位置，可在启动服务前设置 `ASR_HISTORY_DIR` 环境变量。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地开发服务 |
| `npm run lint` | 运行 TypeScript 类型检查 |
| `npm run build` | 构建 Web 前端 |
| `npm run desktop:win` | 构建 Windows `.exe` 安装程序 |
| `npm run desktop:mac` | 在 macOS 上构建 `.dmg` 安装程序 |
