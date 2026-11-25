const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopSettings', {
  saveApiKey: (apiKey) => ipcRenderer.invoke('desktop:save-api-key', apiKey),
  skipApiKey: () => ipcRenderer.invoke('desktop:skip-api-key'),
});
