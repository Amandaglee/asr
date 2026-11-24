const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');

const appName = 'ASR 语音转写质检与校准工作台';
const credentialsPath = () => path.join(app.getPath('userData'), 'credentials.json');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let pendingKeyResolution;
let setupWindow;

if (!hasSingleInstanceLock) {
  app.quit();
}

ipcMain.handle('desktop:save-api-key', async (_event, value) => {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) {
    throw new Error('请输入有效的 Gemini API 密钥。');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全保存 API 密钥。');
  }

  const filePath = credentialsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const encryptedKey = safeStorage.encryptString(apiKey);
  fs.writeFileSync(filePath, JSON.stringify({ encryptedKey: encryptedKey.toString('base64') }), {
    mode: 0o600,
  });

  if (pendingKeyResolution) {
    const resolve = pendingKeyResolution;
    pendingKeyResolution = undefined;
    resolve(apiKey);
  }
  if (setupWindow) {
    setupWindow.close();
    setupWindow = undefined;
  }
});

function readSavedApiKey() {
  const filePath = credentialsPath();
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法读取已保存的 API 密钥。');
  }

  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof saved.encryptedKey !== 'string') {
    throw new Error('本机保存的 API 密钥配置无效，请删除配置后重新设置。');
  }
  return safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'));
}

function requestApiKey() {
  return new Promise((resolve, reject) => {
    pendingKeyResolution = resolve;
    setupWindow = new BrowserWindow({
      width: 520,
      height: 390,
      resizable: false,
      autoHideMenuBar: true,
      title: `${appName} - 配置`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });

    setupWindow.on('closed', () => {
      setupWindow = undefined;
      if (pendingKeyResolution) {
        pendingKeyResolution = undefined;
        reject(new Error('未配置 Gemini API 密钥，应用已退出。'));
      }
    });

    setupWindow.loadFile(path.join(__dirname, 'key-setup.html')).catch(reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`本机服务健康检查返回 ${response.status}。`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`本机服务启动失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function openWorkbench() {
  const apiKey = process.env.GEMINI_API_KEY || readSavedApiKey() || (await requestApiKey());
  process.env.GEMINI_API_KEY = apiKey;
  process.env.ASR_DESKTOP = 'true';
  process.env.ASR_WEB_ROOT = path.join(app.getAppPath(), 'dist');
  process.env.NODE_ENV = 'production';

  const { startServer } = require(path.join(app.getAppPath(), 'dist', 'server.cjs'));
  const server = await startServer(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法读取本机服务监听地址。');
  }

  const url = `http://127.0.0.1:${address.port}`;
  await waitForServer(url);

  const workbenchWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: appName,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await workbenchWindow.loadURL(url);
  workbenchWindow.once('ready-to-show', () => workbenchWindow.show());
}

app.whenReady()
  .then(() => (hasSingleInstanceLock ? openWorkbench() : undefined))
  .catch((error) => {
    dialog.showErrorBox(`${appName} 启动失败`, error instanceof Error ? error.message : String(error));
    app.quit();
  });

app.on('window-all-closed', () => app.quit());
