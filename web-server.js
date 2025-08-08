/**
 * Módulo Chat – Servidor Multi-Cliente (WhatsApp) com sessões persistentes
 * Suporta 2 canais: 3000 (pixel12_ia) e 3001 (pixel12_humano)
 * Endpoints:
 *  - GET  /health?port=3000
 *  - GET  /status?port=3000
 *  - GET  /connect?port=3000
 *  - GET  /qr?port=3000        (QR em texto base64)
 *  - GET  /qr.png?port=3000    (QR renderizado em PNG)
 *  - GET  /debug/chrome        (diagnóstico do Chrome/paths)
 *  - POST /send?port=3000      ({ to, text } ou { to, mediaBase64, mimeType, filename })
 *
 * Observações:
 * - Persistência das sessões em ./sessions (necessário Persistent Disk no Render).
 * - Compatível com execução dentro do repositório do whatsapp-web.js (usa require('./')).
 * - Chrome detection: ENV → cache do Puppeteer → caminhos de sistema; instala em runtime se faltar.
 * - Fallback: se não houver Chrome válido, não define executablePath (Puppeteer resolve).
 * - Melhorado: Logging aprimorado e tratamento de erros mais robusto.
 */

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const { execSync } = require('child_process');

// Ambiente Puppeteer para Render
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'false';
process.env.PUPPETEER_PRODUCT = process.env.PUPPETEER_PRODUCT || 'chrome';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';

// ---------- Carregar whatsapp-web.js mesmo se estivermos dentro do fork ----------
let Client, LocalAuth, MessageMedia;
try {
  const wweb = require('./'); // quando você está dentro do repo whatsapp-web.js
  Client = wweb.Client || wweb.default?.Client || wweb;
  LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth || wweb.AuthStrategy?.LocalAuth;
  MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
} catch (e) {
  try {
    const wweb = require('./dist/index.js');
    Client = wweb.Client || wweb.default?.Client || wweb;
    LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth || wweb.AuthStrategy?.LocalAuth;
    MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
  } catch (e2) {
    console.error('❌ Erro ao carregar whatsapp-web.js:', e2.message);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Pastas de sessão ----------
const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.ensureDirSync(SESSIONS_DIR);

// ---------- Config dos canais ----------
const CANAIS_CONFIG = {
  3000: { sessionId: 'session-pixel12_ia',     numero: '554797146908@c.us', nome: 'Atendimento IA' },
  3001: { sessionId: 'session-pixel12_humano', numero: '554797309525@c.us', nome: 'Atendimento Humano' },
};

// ---------- Estados em memória ----------
const clients = new Map();           // porta -> Client
const qrCodes = new Map();           // porta -> base64 string do QR
const connectionStatus = new Map();  // porta -> boolean
const lastState = new Map();         // porta -> state string

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Util ----------
function getPortFromQuery(req) {
  const p = parseInt(req.query.port, 10);
  return Number.isFinite(p) ? p : 3000;
}

// ---------- Resolvedor de Chrome (ENV → cache Puppeteer → sistema) ----------
function resolveChromePath() {
  const candidates = [];
  console.log('🔍 Iniciando resolução do caminho do Chrome...');

  // 1) Variáveis de ambiente comuns
  const envPaths = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.GOOGLE_CHROME_BIN, process.env.CHROME_PATH]
    .filter(Boolean);
  
  if (envPaths.length > 0) {
    console.log('📍 Caminhos do Chrome encontrados em variáveis de ambiente:', envPaths);
    candidates.push(...envPaths);
  }

  // 2) Cache do Puppeteer no Render (listar versões linux-* e pegar os paths)
  try {
    const root = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const chromeRoot = path.join(root, 'chrome');
    if (fs.existsSync(chromeRoot)) {
      console.log(`📁 Verificando cache do Puppeteer em: ${chromeRoot}`);
      const versions = fs.readdirSync(chromeRoot)
        .filter(d => d.startsWith('linux-'))
        .sort()
        .reverse(); // mais recente primeiro
      
      if (versions.length > 0) {
        console.log(`🔍 Versões do Chrome encontradas no cache: ${versions.join(', ')}`);
        for (const v of versions) {
          const p = path.join(chromeRoot, v, 'chrome-linux64', 'chrome');
          candidates.push(p);
        }
      } else {
        console.log('⚠️ Nenhuma versão do Chrome encontrada no cache do Puppeteer');
      }
    } else {
      console.log(`⚠️ Diretório de cache do Puppeteer não encontrado: ${chromeRoot}`);
    }
  } catch (error) {
    console.log(`⚠️ Erro ao verificar cache do Puppeteer: ${error.message}`);
  }

  // 3) Possíveis caminhos de sistema
  const systemPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium'
  ];
  console.log('🔍 Verificando caminhos do sistema:', systemPaths);
  candidates.push(...systemPaths);

  // Verificar cada candidato
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        console.log(`✅ Chrome encontrado: ${p}`);
        return p;
      }
    } catch (error) {
      console.log(`⚠️ Erro ao verificar caminho ${p}: ${error.message}`);
    }
  }
  
  console.log('❌ Nenhum Chrome válido encontrado');
  return null;
}

async function setupPuppeteer() {
  console.log('🔧 Configurando Puppeteer para Render.com...');
  
  // 1) tenta achar um Chrome válido já presente
  let chromePath = resolveChromePath();
  if (chromePath) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
    console.log('✅ Chrome detectado para Puppeteer:', chromePath);
    return chromePath;
  }

  // 2) não achou → tenta instalar via CLI em runtime
  try {
    console.log('⬇️ Chrome não encontrado. Instalando via Puppeteer CLI...');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const cmd = `npx puppeteer browsers install chrome --cache-dir=${cacheDir}`;
    console.log(`🔄 Executando comando: ${cmd}`);
    execSync(cmd, { stdio: 'inherit', timeout: 180000 });
    console.log('✅ Instalação do Chrome via CLI concluída');
  } catch (e) {
    console.log('⚠️ Falha ao instalar Chrome via CLI:', e.message || e);
  }

  // 3) revalida caminho após a instalação
  console.log('🔍 Revalidando caminho do Chrome após instalação...');
  chromePath = resolveChromePath();
  if (chromePath) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
    console.log('✅ Chrome instalado e detectado:', chromePath);
    return chromePath;
  }

  console.log('ℹ️ Ainda sem Chrome local. Puppeteer tentará resolver automaticamente.');
  return null;
}

// ---------- Criação do Client ----------
function buildClient(porta, chromePath = null) {
  const cfg = CANAIS_CONFIG[porta];
  if (!cfg) throw new Error(`Porta ${porta} não mapeada em CANAIS_CONFIG.`);

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
      '--mute-audio'
    ],
    headless: true,
    timeout: 120000,
    protocolTimeout: 120000,
  };

  // Define executablePath somente se existir MESMO
  if (chromePath) {
    try {
      if (fs.existsSync(chromePath) && fs.statSync(chromePath).isFile()) {
        puppeteerConfig.executablePath = chromePath;
        console.log(`🧭 Porta ${porta}: usando Chrome em ${chromePath}`);
      } else {
        console.log(`⚠️ Porta ${porta}: caminho do Chrome informado não é válido. Seguindo sem executablePath.`);
      }
    } catch {
      console.log(`⚠️ Porta ${porta}: falha ao validar ${chromePath}. Seguindo sem executablePath.`);
    }
  } else {
    console.log(`🧭 Porta ${porta}: sem executablePath (Puppeteer decide / cache).`);
  }

  const client = new Client({
    puppeteer: puppeteerConfig,
    authStrategy: new LocalAuth({
      clientId: cfg.sessionId,   // cada canal tem um clientId distinto
      dataPath: SESSIONS_DIR,    // todas sessões em ./sessions
    }),
  });

  // ---------- Eventos ----------
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
    try { await client.destroy(); } catch (destroyError) {
      console.log(`⚠️ Erro ao destruir cliente (porta ${porta}):`, destroyError.message);
    }
    clients.delete(porta);

    // Tentar reconectar após 5s
    setTimeout(() => {
      console.log(`🔄 Recriando cliente (porta ${porta})...`);
      startClient(porta, resolveChromePath()).catch(err => {
        console.error(`❌ Erro recriando ${porta}:`, err.message);
        setTimeout(() => {
          console.log(`🔄 Segunda tentativa de recriação (porta ${porta})...`);
          startClient(porta, null).catch(retryErr => {
            console.error(`❌ Falha também na segunda tentativa de recriação ${porta}:`, retryErr.message);
          });
        }, 10000);
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

// ---------- Inicializar cliente de uma porta ----------
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

    // Guard rail: checar estado real após inicialização
    try {
      const state = await client.getState();
      lastState.set(porta, state || 'UNKNOWN');
      connectionStatus.set(porta, state === 'CONNECTED');
      console.log(`✅ Cliente inicializado com sucesso (porta ${porta}) - Estado: ${state}`);
    } catch (stateError) {
      console.log(`⚠️ Erro ao verificar estado (porta ${porta}):`, stateError.message);
      lastState.set(porta, 'UNKNOWN');
    }

    return client;

  } catch (err) {
    console.error(`❌ Erro ao inicializar (porta ${porta}):`, err.message);
    console.error(`📋 Stack trace:`, err.stack);

    const msg = (err?.message || '').toLowerCase();
    const looksLikeChromePathIssue =
      msg.includes('browser was not found') ||
      msg.includes('could not find chrome') ||
      msg.includes('executablepath');

    if (looksLikeChromePathIssue) {
      console.log(`⚠️ Erro de Chrome detectado para porta ${porta}. Fallback sem executablePath...`);
      try {
        // Remover possível influência do ENV no fallback:
        delete process.env.PUPPETEER_EXECUTABLE_PATH;
        console.log(`🔄 Removida variável de ambiente PUPPETEER_EXECUTABLE_PATH para fallback`);

        clients.delete(porta);

        console.log(`↩️ Fallback na porta ${porta}: inicializando sem executablePath (Puppeteer decide).`);
        const fallbackClient = new Client({
          puppeteer: {
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
              '--mute-audio'
            ],
            headless: true,
            timeout: 120000,
            protocolTimeout: 120000,
          },
          authStrategy: new LocalAuth({
            clientId: CANAIS_CONFIG[porta].sessionId,
            dataPath: SESSIONS_DIR,
          }),
        });

        clients.set(porta, fallbackClient);
        connectionStatus.set(porta, false);
        qrCodes.set(porta, null);

        fallbackClient.on('qr', (qr) => {
          qrCodes.set(porta, qr);
          console.log(`📱 QR recebido (porta ${porta})`);
        });
        fallbackClient.on('authenticated', () => {
          console.log(`✅ Autenticado (porta ${porta})`);
        });
        fallbackClient.on('ready', async () => {
          connectionStatus.set(porta, true);
          qrCodes.set(porta, null);
          console.log(`✅ Pronto/Conectado (porta ${porta})`);
        });
        fallbackClient.on('disconnected', async (reason) => {
          console.log(`❌ Desconectado (porta ${porta}) → ${reason}`);
          connectionStatus.set(porta, false);
          qrCodes.set(porta, null);
          try { await fallbackClient.destroy(); } catch (_) {}
          clients.delete(porta);
          setTimeout(() => {
            console.log(`🔄 Recriando cliente (porta ${porta})...`);
            startClient(porta, resolveChromePath() || null).catch(e => console.error(`Erro recriando ${porta}:`, e.message));
          }, 5000);
        });
        fallbackClient.on('change_state', (state) => {
          lastState.set(porta, state);
          console.log(`ℹ️ State (porta ${porta}) = ${state}`);
        });
        fallbackClient.on('auth_failure', (msg2) => {
          console.log(`⚠️ Falha de autenticação (porta ${porta}) → ${msg2}`);
          connectionStatus.set(porta, false);
        });

        await fallbackClient.initialize();
        console.log(`✅ Cliente fallback inicializado com sucesso (porta ${porta})`);
        return fallbackClient;

      } catch (fallbackErr) {
        console.error(`❌ Erro também no fallback (porta ${porta}):`, fallbackErr.message);
        connectionStatus.set(porta, false);
        clients.delete(porta);
        throw fallbackErr;
      }
    }

    connectionStatus.set(porta, false);
    clients.delete(porta);
    throw err;
  }
}

// ---------- Validação de Configuração ----------
function validateConfiguration() {
  console.log('🔍 Validando configuração...');

  const configuredPorts = Object.keys(CANAIS_CONFIG).map(Number);
  if (configuredPorts.length === 0) {
    throw new Error('Nenhuma porta configurada em CANAIS_CONFIG');
  }
  console.log(`✅ Portas configuradas: ${configuredPorts.join(', ')}`);

  try {
    fs.ensureDirSync(SESSIONS_DIR);
    console.log(`✅ Pasta de sessões criada/verificada: ${SESSIONS_DIR}`);
  } catch (error) {
    console.error(`❌ Erro ao criar pasta de sessões: ${error.message}`);
    throw error;
  }

  if (!Client || !LocalAuth || !MessageMedia) {
    throw new Error('Falha ao carregar whatsapp-web.js - componentes essenciais não encontrados');
  }

  console.log('✅ whatsapp-web.js carregado corretamente');
  console.log('✅ Configuração validada com sucesso');
}

// ---------- Endpoints ----------
app.get('/health', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('❌ Erro no endpoint /health:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/status', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    const client = clients.get(porta);
    if (client) {
      try {
        const state = await client.getState();
        lastState.set(porta, state || 'UNKNOWN');
        connectionStatus.set(porta, state === 'CONNECTED');
      } catch (stateError) {
        console.log(`⚠️ Erro ao verificar estado (porta ${porta}):`, stateError.message);
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
  } catch (error) {
    console.error('❌ Erro no endpoint /status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/connect', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    await startClient(porta, resolveChromePath());
    res.json({
      success: true,
      message: 'Cliente iniciado',
      port: porta,
      numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
      nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Erro no endpoint /connect:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/qr', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);

    if (!clients.get(porta)) {
      try { await startClient(porta, resolveChromePath()); }
      catch (startError) { console.log(`⚠️ Erro ao iniciar cliente para QR (porta ${porta}):`, startError.message); }
      for (let i = 0; i < 10 && !qrCodes.get(porta); i++) await sleep(1000);
    }

    res.json({
      success: true,
      qr: qrCodes.get(porta) || 'QR indisponível. Tente novamente em alguns segundos.',
      connected: connectionStatus.get(porta) || false,
      port: porta,
      numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
      nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Erro no endpoint /qr:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/qr.png', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);

    if (!clients.get(porta)) {
      try { await startClient(porta, resolveChromePath()); }
      catch (startError) { console.log(`⚠️ Erro ao iniciar cliente para QR PNG (porta ${porta}):`, startError.message); }
      for (let i = 0; i < 10 && !qrCodes.get(porta); i++) await sleep(1000);
    }

    const qr = qrCodes.get(porta);
    if (!qr) {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send('QR indisponível. Tente novamente em alguns segundos.');
    }

    res.set('Content-Type', 'image/png');
    await QRCode.toFileStream(res, qr, { width: 320, margin: 1 });
  } catch (error) {
    console.error('❌ Erro no endpoint /qr.png:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Envio de mensagens
app.post('/send', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);
    const { to, text, mediaBase64, mimeType, filename } = req.body || {};

    if (!to) return res.status(400).json({ success: false, error: 'Campo "to" é obrigatório (ex: 559999999999@c.us).' });
    if (!clients.get(porta) || !connectionStatus.get(porta)) return res.status(400).json({ success: false, error: 'WhatsApp não está conectado.' });

    const client = clients.get(porta);
    if (!client) return res.status(400).json({ success: false, error: 'Cliente não encontrado.' });

    let result;
    if (mediaBase64 && mimeType && filename) {
      try {
        const media = new MessageMedia(mimeType, mediaBase64, filename);
        result = await client.sendMessage(to, media, { caption: text || '' });
      } catch (mediaError) {
        console.error(`❌ Erro ao enviar mídia (porta ${porta}):`, mediaError.message);
        return res.status(500).json({ success: false, error: `Erro ao enviar mídia: ${mediaError.message}` });
      }
    } else {
      try {
        result = await client.sendMessage(to, text || '');
      } catch (textError) {
        console.error(`❌ Erro ao enviar texto (porta ${porta}):`, textError.message);
        return res.status(500).json({ success: false, error: `Erro ao enviar texto: ${textError.message}` });
      }
    }

    res.json({
      success: true,
      message: 'Mensagem enviada',
      to,
      port: porta,
      result: { id: result?.id?._serialized || null },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`❌ Erro geral ao enviar mensagem:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- Debug Chrome ----------
app.get('/debug/chrome', (req, res) => {
  const current = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  let exists = false;
  try { exists = current ? (fs.existsSync(current) && fs.statSync(current).isFile()) : false; } catch (_) {}

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

// ---------- Limpeza de Recursos ----------
process.on('SIGINT', async () => {
  console.log('\n🛑 Recebido SIGINT. Encerrando servidor...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Recebido SIGTERM. Encerrando servidor...');
  await cleanup();
  process.exit(0);
});

async function cleanup() {
  console.log('🧹 Limpando recursos...');
  for (const [porta, client] of clients.entries()) {
    try {
      console.log(`🔄 Encerrando cliente (porta ${porta})...`);
      await client.destroy();
      console.log(`✅ Cliente encerrado (porta ${porta})`);
    } catch (error) {
      console.error(`❌ Erro ao encerrar cliente (porta ${porta}):`, error.message);
    }
  }
  clients.clear();
  qrCodes.clear();
  connectionStatus.clear();
  lastState.clear();
  console.log('✅ Limpeza concluída');
}

// ---------- Tratamento de Erros Não Capturados ----------
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
  console.error('Stack trace:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
  console.error('Promise:', promise);
});

// ---------- Servidor ----------
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);

  try {
    // Validar configuração
    validateConfiguration();

    // Configurar Puppeteer antes de iniciar os clientes
    console.log('🔧 Iniciando configuração do Puppeteer...');
    const chromePath = await setupPuppeteer();
    console.log('✅ Configuração do Puppeteer concluída');

    // Sobe os 2 canais automaticamente
    console.log('🚀 Iniciando canais automaticamente...');
    for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
      console.log(`🔄 Iniciando canal ${porta}...`);
      startClient(porta, chromePath).catch((err) => {
        console.error(`❌ Falha ao iniciar canal ${porta}:`, err.message);
        setTimeout(() => {
          console.log(`🔄 Tentando novamente canal ${porta} sem chromePath...`);
          startClient(porta, resolveChromePath() || null).catch((retryErr) => {
            console.error(`❌ Falha também na segunda tentativa do canal ${porta}:`, retryErr.message);
          });
        }, 5000);
      });
    }
  } catch (error) {
    console.error('❌ Erro crítico ao inicializar servidor:', error.message);
    console.log('🔄 Tentando continuar sem configuração específica do Puppeteer...');
    for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
      console.log(`🔄 Iniciando canal ${porta} sem configuração específica...`);
      startClient(porta, resolveChromePath() || null).catch((err) => {
        console.error(`❌ Falha ao iniciar canal ${porta}:`, err.message);
      });
    }
  }
});
