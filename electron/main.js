const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mainWindow;
let frontendServer;
const frontendSockets = new Set();
const auxiliaryWindows = new Set();
let shutdownPromise;
let shutdownComplete = false;
const FIREBASE_AUTH_HANDLER_ORIGIN = 'https://noaiverdad-72aba.firebaseapp.com';

function stopLocalServices() {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = new Promise(resolve => {
    // OAuth popups and any other child windows must not keep Electron alive.
    for (const childWindow of auxiliaryWindows) {
      if (!childWindow.isDestroyed()) childWindow.destroy();
    }
    auxiliaryWindows.clear();

    const server = frontendServer;
    frontendServer = null;
    if (!server) return resolve();

    const sockets = [...frontendSockets];
    const finish = () => {
      frontendSockets.clear();
      resolve();
    };

    if (server.listening) server.close(finish);
    else finish();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
  });

  return shutdownPromise;
}

// Firebase Web Auth rejects file:// origins. Serve the packaged UI on a local
// HTTP origin so Google popup and Web Storage work in Electron.
function startFrontendServer() {
  const frontendRoot = path.resolve(app.getAppPath(), 'frontend');
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
  };

  frontendServer = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end('Bad request'); return; }
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(frontendRoot, requested);
    if (filePath !== frontendRoot && !filePath.startsWith(frontendRoot + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) { response.writeHead(404).end('Not found'); return; }
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      response.end(content);
    });
  });
  frontendServer.on('connection', socket => {
    frontendSockets.add(socket);
    socket.once('close', () => frontendSockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    frontendServer.once('error', reject);
    frontendServer.listen(0, 'localhost', () => {
      frontendServer.removeListener('error', reject);
      resolve(`http://localhost:${frontendServer.address().port}/`);
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: "NoAIVerdad - Plataforma Cívica para Monitoreo Electoral en Ecuador",
    icon: path.join(__dirname, '../frontend/img/icon.png'),
    backgroundColor: '#0b0f19',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  // Cargar la interfaz desde HTTP en vez de file:// para habilitar Firebase Auth.
  const frontendUrl = await startFrontendServer();
  console.log(`[Electron] Cargando interfaz desde ${frontendUrl}`);
  mainWindow.loadURL(frontendUrl);
  mainWindow.webContents.once('did-finish-load', async () => {
    const pageUrl = await mainWindow.webContents.executeJavaScript('window.location.href');
    console.log(`[Electron] Origen activo: ${pageUrl}`);
  });

  // Firebase necesita que su OAuth popup permanezca vinculado a esta ventana.
  // Enviar ese handler al navegador externo rompe el opener y pierde el estado.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let target;
    try { target = new URL(url); } catch { return { action: 'deny' }; }

    if (
      target.origin === FIREBASE_AUTH_HANDLER_ORIGIN &&
      target.pathname.startsWith('/__/auth/')
    ) {
      console.log(`[Electron] Permitiendo popup Firebase: ${target.pathname}`);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 650,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            session: mainWindow.webContents.session
          }
        }
      };
    }

    // Abrir los demás enlaces externos en el navegador predeterminado.
    console.log(`[Electron] Abriendo enlace externo: ${url}`);
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (popup, details) => {
    auxiliaryWindows.add(popup);
    popup.once('closed', () => auxiliaryWindows.delete(popup));
    console.log(`[Electron] Popup creado: ${details.url}`);
  });

  // Menú superior nativo de la aplicación
  const menuTemplate = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Reiniciar aplicación', role: 'reload' },
        { label: 'Forzar recarga', role: 'forceReload' },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Pantalla completa', role: 'togglefullscreen' },
        { label: 'Acercar zoom', role: 'zoomIn' },
        { label: 'Alejar zoom', role: 'zoomOut' },
        { label: 'Restablecer zoom', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Herramientas de Desarrollador', role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Repositorio GitHub',
          click: () => shell.openExternal('https://github.com/Katthon/NoAIVerdad')
        },
        {
          label: 'Acerca de NoAIVerdad',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(`
                document.getElementById('nav-btn-acerca')?.click();
              `);
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  mainWindow.on('close', () => {
    stopLocalServices();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// Inicialización de la aplicación
app.whenReady().then(() => {
  createWindow().catch(error => {
    console.error('[Electron] No se pudo iniciar la ventana:', error);
    stopLocalServices();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  stopLocalServices()
    .catch(error => console.error('[Electron] Error cerrando servicios locales:', error))
    .then(() => {
      shutdownComplete = true;
      app.quit();
    });
});
