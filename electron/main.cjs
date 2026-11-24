// Optional desktop shell for ABCkit (Electron).
// Not installed by default. To try it:
//   npm run build
//   npm i -D electron@latest
//   npx electron electron/main.cjs
// For installers use electron-builder (see README → "Desktop (Electron) packaging").
const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#000000',
    title: 'ABCkit',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The app uses a HashRouter and relative asset paths, so it runs from file:// unchanged.
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  // Open external links (signed document URLs, email links) in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
