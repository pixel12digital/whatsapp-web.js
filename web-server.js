/**
 * Módulo Chat – Servidor Multi-Cliente (WhatsApp) com sessões persistentes
 * Canais: 3000 (pixel12_ia) e 3001 (pixel12_humano)
 *
 * Endpoints:
 *  - GET  /health?port=3000
 *  - GET  /status?port=3000
 *  - GET  /connect?port=3000
 *  - GET  /qr?port=3000        (QR em texto base64; espera até 30s)
 *  - GET  /qr.png?port=3000    (QR em PNG; espera até 30s)
 *  - GET  /debug/chrome
 *  - GET  /logout?port=3000            (faz logout e reinicia)
 *  - GET  /session/reset?port=3000     (apaga pasta da sessão e reinicia)
 *  - POST /send?port=3000      ({ to, text } ou { to, mediaBase64, mimeType, filename })
 *
 * Observações:
 * - Sessões em /opt/render/project/src/sessions (Persistent Disk do Render).
 * - Compatível com execução dentro do repo do whatsapp-web.js (usa require('./')).
 * - Chrome detection: ENV → cache Puppeteer → paths do sistema → instala em runtime.
 * - Timeouts Puppeteer: protocolTimeout=0 (sem limite) e timeout=240000 (4 min).
 */

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const { execSync } = require('child_process');

// ===== Ambiente Puppeteer / Render =====
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'false';
process.env.PUPPETEER_PRODUCT = process.env.PUPPETEER_PRODUCT || 'chrome';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';

// ===== Carregar whatsapp-web.js (mesmo dentro do próprio repo) =====
let Client, LocalAuth, MessageMedia;
try {
  const wweb = require('./');
  Client = wweb.Client || wweb.default?.Client || wweb;
  LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth || wweb.AuthStrategy?.LocalAuth;
  MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
} catch {
  const wweb = require('./dist/index.js');
  Client = wweb.Client || wweb.default?.Client || wweb;
  LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth || wweb.AuthStrategy?.LocalAuth;
  MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
}

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===== Pastas de sessão (Render: caminho absoluto) =====
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/opt/render/project/src/sessions';
fs.ensureDirSync(SESSIONS_DIR);

// ===== Config dos canais =====
const CANAIS_CONFIG = {
  3000: { sessionId: 'pixel12_ia',     numero: '554797146908@c.us', nome: 'Atendimento IA' },
  3001: { sessionId: 'pixel12_humano', numero: '554797309525@c.us', nome: 'Atendimento Humano' },
};

// ===== Estados em memória =====
const clients = new Map();           // porta -> Client
const qrCodes = new Map();           // porta -> base64 do QR
const connectionStatus = new Map();  // porta -> boolean
const lastState = new Map();         // porta -> state string
const lastGetStateAt = new Map();    // porta -> timestamp para throttling

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ===== Utils =====
function getPortFromQuery(req) {
  const p = parseInt(req.query.port, 10);
  return Number.isFinite(p) ? p : 3000;
}
function sessionPathFor(porta) {
  const cfg = CANAIS_CONFIG[porta];
  return path.join(SESSIONS_DIR, `session-${cfg.sessionId}`);
}

// ===== Resolvedor de Chrome =====
function resolveChromePath() {
  const candidates = [];
  console.log('🔍 Resolvendo caminho do Chrome...');

  const envPaths = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.GOOGLE_CHROME_BIN, process.env.CHROME_PATH].filter(Boolean);
  if (envPaths.length) {
    console.log('📍 ENV paths:', envPaths);
    candidates.push(...envPaths);
  }

  try {
    const root = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const chromeRoot = path.join(root, 'chrome');
    if (fs.existsSync(chromeRoot)) {
      const versions = fs.readdirSync(chromeRoot).filter(d => d.startsWith('linux-')).sort().reverse();
      if (versions.length) {
        console.log('📁 Cache Puppeteer versões:', versions);
        for (const v of versions) candidates.push(path.join(chromeRoot, v, 'chrome-linux64', 'chrome'));
      }
    }
  } catch (e) {
    console.log('⚠️ Erro cache Puppeteer:', e.message);
  }

  candidates.push(
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium'
  );

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        console.log('✅ Chrome:', p);
        return p;
      }
    } catch {}
  }
  console.log('❌ Chrome não encontrado');
  return null;
}

async function setupPuppeteer() {
  console.log('🔧 Configurando Puppeteer...');
  let chromePath = resolveChromePath();
  if (chromePath) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
    return chromePath;
  }
  try {
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const cmd = `npx puppeteer browsers install chrome --cache-dir=${cacheDir}`;
    console.log('⬇️ Instalando Chrome via CLI:', cmd);
    execSync(cmd, { stdio: 'inherit', timeout: 180000 });
  } catch (e) {
    console.log('⚠️ Falha instalação CLI:', e.message || e);
  }
  chromePath = resolveChromePath();
  if (chromePath) process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
  return chromePath;
}

// ===== Criação do Client =====
function buildClient(porta, chromePath = null) {
  const cfg = CANAIS_CONFIG[porta];
  if (!cfg) throw new Error(`Porta ${porta} não mapeada`);

  const puppeteerConfig = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-extensions',
      '--disable-plugins',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
    ],
    headless: true,
    timeout: 240000,        // 4 min
    protocolTimeout: 0,     // sem limite
  };

  if (chromePath && fs.existsSync(chromePath)) {
    puppeteerConfig.executablePath = chromePath;
    console.log(`🧭 Porta ${porta}: usando Chrome em ${chromePath}`);
  } else {
    console.log(`🧭 Porta ${porta}: sem executablePath (Puppeteer decide)`);
  }

  const client = new Client({
    puppeteer: puppeteerConfig,
    authStrategy: new LocalAuth({
      clientId: cfg.sessionId,        // nomes limpos (pixel12_ia / pixel12_humano)
      dataPath: SESSIONS_DIR,
    }),
  });

  client.on('qr', (qr) => {
    qrCodes.set(porta, qr);
    console.log(`📱 QR recebido (porta ${porta})`);
  });

  client.on('authenticated', () => {
    console.log(`✅ Autenticado (porta ${porta})`);
  });

  client.on('ready', async () => {
    connectionStatus.set(porta, true);
    qrCodes.set(porta, null);
    console.log(`✅ Pronto/Conectado (porta ${porta})`);
  });

  client.on('disconnected', async (reason) => {
    console.log(`❌ Desconectado (porta ${porta}) → ${reason}`);
    connectionStatus.set(porta, false);
    qrCodes.set(porta, null);
    try { await client.destroy(); } catch {}
    clients.delete(porta);

    setTimeout(() => {
      console.log(`🔄 Recriando cliente (porta ${porta})...`);
      startClient(porta, resolveChromePath()).catch(err => {
        console.error(`❌ Erro ao recriar ${porta}:`, err.message);
        setTimeout(() => startClient(porta, null).catch(e2 => console.error(`❌ Segunda falha ${porta}:`, e2.message)), 10000);
      });
    }, 5000);
  });

  client.on('change_state', (state) => {
    lastState.set(porta, state);
    console.log(`ℹ️ State (porta ${porta}) = ${state}`);
  });

  client.on('auth_failure', (msg) => {
    console.log(`⚠️ Falha de autenticação (porta ${porta}) → ${msg}`);
    connectionStatus.set(porta, false);
  });

  return client;
}

// ===== Inicializar cliente de uma porta =====
async function startClient(porta, chromePath = null) {
  if (!CANAIS_CONFIG[porta]) throw new Error(`Porta ${porta} não configurada.`);
  if (clients.has(porta)) {
    console.log(`🔄 Cliente já existe (porta ${porta})`);
    return clients.get(porta);
  }

  console.log(`🚀 Iniciando WhatsApp client (porta ${porta}) [${CANAIS_CONFIG[porta].nome}]`);

  try {
    const client = buildClient(porta, chromePath);
    clients.set(porta, client);
    connectionStatus.set(porta, false);
    qrCodes.set(porta, null);

    await client.initialize();

    // Guard rail de estado
    try {
      const state = await client.getState();
      lastState.set(porta, state || 'UNKNOWN');
      connectionStatus.set(porta, state === 'CONNECTED');
      console.log(`✅ Cliente inicializado (porta ${porta}) - Estado: ${state}`);
    } catch (e) {
      console.log(`⚠️ Erro getState (porta ${porta}):`, e.message);
      lastState.set(porta, 'UNKNOWN');
    }

    return client;

  } catch (err) {
    console.error(`❌ Erro ao inicializar (porta ${porta}):`, err.message);
    const msg = (err?.message || '').toLowerCase();
    if (msg.includes('browser was not found') || msg.includes('executablepath') || msg.includes('could not find chrome')) {
      console.log(`↩️ Fallback sem executablePath (porta ${porta})`);
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
      const fallback = buildClient(porta, null);
      clients.set(porta, fallback);
      connectionStatus.set(porta, false);
      qrCodes.set(porta, null);
      await fallback.initialize();
      console.log(`✅ Cliente fallback inicializado (porta ${porta})`);
      return fallback;
    }
    clients.delete(porta);
    throw err;
  }
}

// ===== Validação =====
function validateConfiguration() {
  console.log('🔍 Validando configuração...');
  const ports = Object.keys(CANAIS_CONFIG).map(Number);
  if (!ports.length) throw new Error('Nenhuma porta configurada');
  console.log('✅ Portas:', ports.join(', '));

  fs.ensureDirSync(SESSIONS_DIR);
  console.log('✅ Sessões em:', SESSIONS_DIR);

  if (!Client || !LocalAuth || !MessageMedia) throw new Error('whatsapp-web.js não carregou');
  console.log('✅ whatsapp-web.js OK');
}

// ===== Endpoints =====
app.get('/health', (req, res) => {
  const porta = getPortFromQuery(req);
  res.json({
    success: true,
    status: 'OK',
    connected: connectionStatus.get(porta) || false,
    port: porta,
    numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
    nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
    lastState: lastState.get(porta) || 'UNKNOWN',
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', async (req, res) => {
  const porta = getPortFromQuery(req);
  const client = clients.get(porta);

  // Throttling leve de getState (evita "flood" durante OPENING/PAIRING)
  const last = lastGetStateAt.get(porta) || 0;
  const delta = now() - last;
  const shouldCall = delta > 4000 || ['CONNECTED', 'UNKNOWN'].includes(lastState.get(porta));

  if (client && shouldCall) {
    try {
      lastGetStateAt.set(porta, now());
      const state = await client.getState();
      lastState.set(porta, state || 'UNKNOWN');
      connectionStatus.set(porta, state === 'CONNECTED');
    } catch (e) {
      // Não derruba o cliente por falha no getState
      console.log(`⚠️ getState falhou (porta ${porta}):`, e.message);
    }
  }

  res.json({
    success: true,
    connected: connectionStatus.get(porta) || false,
    port: porta,
    numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
    nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
    timestamp: new Date().toISOString(),
  });
});

app.get('/connect', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    await startClient(porta, resolveChromePath());
    res.json({ success: true, message: 'Cliente iniciado', port: porta, numero: CANAIS_CONFIG[porta]?.numero, nome: CANAIS_CONFIG[porta]?.nome, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Espera QR até 30s
async function waitQR(porta, maxMs = 30000) {
  const start = now();
  while (!qrCodes.get(porta) && now() - start < maxMs) {
    await sleep(1000);
  }
}

app.get('/qr', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    if (!clients.get(porta)) {
      try { await startClient(porta, resolveChromePath()); } catch {}
    }
    await waitQR(porta, 30000);
    res.json({
      success: true,
      qr: qrCodes.get(porta) || 'QR indisponível. Tente novamente em alguns segundos.',
      connected: connectionStatus.get(porta) || false,
      port: porta,
      numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
      nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/qr.png', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    if (!clients.get(porta)) {
      try { await startClient(porta, resolveChromePath()); } catch {}
    }
    await waitQR(porta, 30000);
    const qr = qrCodes.get(porta);
    if (!qr) {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send('QR indisponível. Tente novamente em alguns segundos.');
    }
    res.set('Content-Type', 'image/png');
    await QRCode.toFileStream(res, qr, { width: 320, margin: 1 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Envio de mensagens
app.post('/send', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    const { to, text, mediaBase64, mimeType, filename } = req.body || {};
    if (!to) return res.status(400).json({ success: false, error: 'Campo "to" é obrigatório (ex: 559999999999@c.us).' });

    if (!clients.get(porta) || !connectionStatus.get(porta)) {
      return res.status(400).json({ success: false, error: 'WhatsApp não está conectado.' });
    }

    const client = clients.get(porta);
    let result;
    if (mediaBase64 && mimeType && filename) {
      const media = new MessageMedia(mimeType, mediaBase64, filename);
      result = await client.sendMessage(to, media, { caption: text || '' });
    } else {
      result = await client.sendMessage(to, text || '');
    }

    res.json({ success: true, message: 'Mensagem enviada', to, port: porta, result: { id: result?.id?._serialized || null }, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== Manutenção =====
app.get('/logout', async (req, res) => {
  const porta = getPortFromQuery(req);
  const client = clients.get(porta);
  try {
    if (client) {
      await client.logout().catch(()=>{});
      await client.destroy().catch(()=>{});
      clients.delete(porta);
    }
    // não apaga a pasta – só logout; ao iniciar de novo, gera QR
    await startClient(porta, resolveChromePath());
    res.json({ success: true, message: 'Logout feito e cliente reiniciado', port: porta, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/session/reset', async (req, res) => {
  const porta = getPortFromQuery(req);
  try {
    const client = clients.get(porta);
    if (client) {
      try { await client.destroy(); } catch {}
      clients.delete(porta);
    }
    const p = sessionPathFor(porta);
    try {
      await fs.remove(p);
      console.log(`🧹 Sessão removida: ${p}`);
    } catch (e) {
      console.log(`⚠️ Falha ao remover sessão ${p}:`, e.message);
    }
    await startClient(porta, resolveChromePath());
    res.json({ success: true, message: 'Sessão resetada e cliente reiniciado', port: porta, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== Debug =====
app.get('/debug/chrome', (req, res) => {
  const current = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  let exists = false;
  try { exists = current ? (fs.existsSync(current) && fs.statSync(current).isFile()) : false; } catch {}
  res.json({
    success: true,
    PUPPETEER_EXECUTABLE_PATH: current,
    exists,
    cacheDir: process.env.PUPPETEER_CACHE_DIR,
    sessionsDir: SESSIONS_DIR,
    sessionsDirExists: fs.existsSync(SESSIONS_DIR),
    timestamp: new Date().toISOString(),
  });
});

// ===== Encerramento =====
async function cleanup() {
  console.log('🧹 Limpando recursos...');
  for (const [porta, client] of clients.entries()) {
    try { await client.destroy(); } catch {}
  }
  clients.clear(); qrCodes.clear(); connectionStatus.clear(); lastState.clear();
  console.log('✅ Limpeza concluída');
}
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('uncaughtException', (e) => { console.error('❌ uncaughtException:', e); });
process.on('unhandledRejection', (r, p) => { console.error('❌ unhandledRejection:', r); });

// ===== Servidor =====
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  try {
    validateConfiguration();
    const chromePath = await setupPuppeteer();
    console.log('✅ Puppeteer pronto');

    console.log('🚀 Iniciando canais...');
    for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
      startClient(porta, chromePath).catch((err) => {
        console.error(`❌ Falha ao iniciar ${porta}:`, err.message);
        setTimeout(() => startClient(porta, resolveChromePath() || null).catch(e2 => console.error(`❌ Segunda falha ${porta}:`, e2.message)), 5000);
      });
    }
  } catch (e) {
    console.error('❌ Erro crítico:', e.message);
    for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
      startClient(porta, resolveChromePath() || null).catch(err => console.error(`❌ Falha ao iniciar ${porta}:`, err.message));
    }
  }
});
