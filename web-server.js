/**
 * Módulo Chat – Servidor Multi-Cliente (WhatsApp) com sessões persistentes
 * Suporta 2 canais: 3000 (pixel12_ia) e 3001 (pixel12_humano)
 * Endpoints:
 *  - GET  /health?port=3000
 *  - GET  /status?port=3000
 *  - GET  /connect?port=3000
 *  - GET  /qr?port=3000        (QR em texto base64)
 *  - GET  /qr.png?port=3000    (QR renderizado em PNG)
 *  - POST /send?port=3000      ({ to, text } ou { to, mediaBase64, mimeType, filename })
 *
 * Observações:
 * - Persistência das sessões em ./sessions (necessário Disk no Render).
 * - Compatível com execução dentro do repositório do whatsapp-web.js (usa require('./')).
 * - Configuração otimizada para Render.com com Puppeteer.
 */

// Configuração para Render.com - usar Puppeteer gerenciado

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');

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
  3000: {
    sessionId: 'session-pixel12_ia',
    numero: '554797146908@c.us',
    nome: 'Atendimento IA',
  },
  3001: {
    sessionId: 'session-pixel12_humano',
    numero: '554797309525@c.us',
    nome: 'Atendimento Humano',
  },
};

// ---------- Estados em memória ----------
const clients = new Map();           // porta -> Client
const qrCodes = new Map();           // porta -> base64 string do QR
const connectionStatus = new Map();  // porta -> boolean
const lastState = new Map();         // porta -> state string

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Obtém o caminho do Chrome para uso com Puppeteer
 * Prioriza PUPPETEER_EXECUTABLE_PATH, senão usa puppeteer.executablePath()
 */
function getChromePath() {
  try {
    // Usar variável de ambiente se definida
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      console.log(`🎯 Chrome encontrado em: ${process.env.PUPPETEER_EXECUTABLE_PATH} (PUPPETEER_EXECUTABLE_PATH)`);
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    // Usar Chrome baixado pelo Puppeteer
    const executablePath = puppeteer.executablePath();
    console.log(`🎯 Chrome encontrado em: ${executablePath} (puppeteer.executablePath())`);
    return executablePath;
  } catch (error) {
    console.log(`⚠️ Erro ao obter caminho do Chrome: ${error.message}`);
    return null;
  }
}

/**
 * Configura o Puppeteer para o ambiente de deploy
 */
async function setupPuppeteer() {
  console.log('🔧 Configurando Puppeteer...');
  
  try {
    const chromePath = getChromePath();
    
    if (!chromePath) {
      console.warn('⚠️ Chrome não configurado. Puppeteer pode falhar na inicialização.');
      return false;
    }
    
    console.log('✅ Puppeteer configurado com sucesso');
    return true;
    
  } catch (error) {
    console.error('❌ Erro ao configurar Puppeteer:', error.message);
    return false;
  }
}

// ---------- Criação do Client ----------
function buildClient(porta) {
  const cfg = CANAIS_CONFIG[porta];
  if (!cfg) throw new Error(`Porta ${porta} não mapeada em CANAIS_CONFIG.`);

  // Configuração do Puppeteer com fallback inteligente
  const chromePath = getChromePath();
  const puppeteerConfig = {
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
    headless: true,
    timeout: 60000,
    protocolTimeout: 60000,
  };

  console.log(`🧭 Configurando cliente para porta ${porta} com Chrome: ${chromePath || 'padrão do sistema'}`);

  const client = new Client({
    puppeteer: puppeteerConfig,
    // Persistência de sessão - REMOVIDO userDataDir para compatibilidade com LocalAuth
    authStrategy: new LocalAuth({
      clientId: cfg.sessionId,            // cada canal tem um clientId distinto
      dataPath: SESSIONS_DIR,             // todas sessões em ./sessions
    }),
  });

  // ---------- Eventos ----------
  client.on('qr', (qr) => {
    qrCodes.set(porta, qr);
    console.log(`📱 QR pronto (canal ${porta})`);
  });

  client.on('authenticated', () => {
    console.log(`�� Autenticado (porta ${porta})`);
  });

  client.on('ready', async () => {
    connectionStatus.set(porta, true);
    qrCodes.set(porta, null);
    console.log(`✅ Canal ${porta} conectado e pronto`);
  });

  client.on('disconnected', async (reason) => {
    console.log(`❌ Desconectado (porta ${porta}) → ${reason}`);
    connectionStatus.set(porta, false);
    qrCodes.set(porta, null);

    try { await client.destroy(); } catch (_) {}
    clients.delete(porta);

    // Tenta recomeçar sozinho após breve espera
    setTimeout(() => {
      console.log(`🔄 Recriando cliente (porta ${porta})...`);
      startClient(porta).catch(err => console.error(`Erro recriando ${porta}:`, err.message));
    }, 5000);
  });

  client.on('change_state', (state) => {
    lastState.set(porta, state);
    console.log(`ℹ️  State (porta ${porta}) = ${state}`);
  });

  client.on('auth_failure', (msg) => {
    console.log(`⚠️  Falha de autenticação (porta ${porta}) → ${msg}`);
    connectionStatus.set(porta, false);
  });

  return client;
}

// ---------- Inicializar cliente de uma porta ----------
async function startClient(porta) {
  if (!CANAIS_CONFIG[porta]) throw new Error(`Porta ${porta} não configurada.`);
  if (clients.has(porta)) {
    console.log(`🔄 Cliente já existe (porta ${porta})`);
    return clients.get(porta);
  }

  console.log(`🚀 Iniciando WhatsApp client (porta ${porta}) [${CANAIS_CONFIG[porta].nome}]`);
  const client = buildClient(porta);
  clients.set(porta, client);
  connectionStatus.set(porta, false);
  qrCodes.set(porta, null);

  try {
    await client.initialize();
  } catch (err) {
    console.error(`❌ Erro ao inicializar (porta ${porta}):`, err.message);
    connectionStatus.set(porta, false);
    clients.delete(porta);
    throw err;
  }

  // Guard rail: checar estado real após inicialização
  try {
    const state = await client.getState();
    lastState.set(porta, state || 'UNKNOWN');
    connectionStatus.set(porta, state === 'CONNECTED');
  } catch {
    lastState.set(porta, 'UNKNOWN');
  }

  return client;
}

// ---------- Util ----------
function getPortFromQuery(req) {
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  return parseInt(url.searchParams.get('port')) || 3000;
}

// ---------- Endpoints ----------
app.get('/health', async (req, res) => {
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
  try {
    const client = clients.get(porta);
    if (client) {
      try {
        const state = await client.getState();
        lastState.set(porta, state || 'UNKNOWN');
        connectionStatus.set(porta, state === 'CONNECTED');
      } catch (_) {}
    }
    res.json({
      success: true,
      connected: connectionStatus.get(porta) || false,
      port: porta,
      numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
      nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/connect', async (req, res) => {
  const porta = getPortFromQuery(req);
  try {
    await startClient(porta);
    res.json({
      success: true,
      message: 'Cliente iniciado',
      port: porta,
      numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
      nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/qr', async (req, res) => {
  const porta = getPortFromQuery(req);

  // Se ainda não existe cliente, inicializa para gerar QR
  if (!clients.get(porta)) {
    try { await startClient(porta); } catch (_) {}
    // espera um pouco pelo evento 'qr'
    for (let i = 0; i < 10 && !qrCodes.get(porta); i++) {
      await sleep(1000);
    }
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
});

app.get('/qr.png', async (req, res) => {
  const porta = getPortFromQuery(req);

  if (!clients.get(porta)) {
    try { await startClient(porta); } catch (_) {}
    for (let i = 0; i < 10 && !qrCodes.get(porta); i++) {
      await sleep(1000);
    }
  }

  const qr = qrCodes.get(porta);
  if (!qr) {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send('QR indisponível. Tente novamente em alguns segundos.');
  }

  try {
    res.set('Content-Type', 'image/png');
    await QRCode.toFileStream(res, qr, { width: 320, margin: 1 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Envio de mensagens
app.post('/send', async (req, res) => {
  const porta = getPortFromQuery(req);
  const { to, text, mediaBase64, mimeType, filename } = req.body || {};

  if (!to) return res.status(400).json({ success: false, error: 'Campo "to" é obrigatório (ex: 559999999999@c.us).' });

  if (!clients.get(porta) || !(connectionStatus.get(porta))) {
    return res.status(400).json({ success: false, error: 'WhatsApp não está conectado.' });
  }

  try {
    const client = clients.get(porta);

    let result;
    if (mediaBase64 && mimeType && filename) {
      // Envio de mídia em base64
      const media = new MessageMedia(mimeType, mediaBase64, filename);
      result = await client.sendMessage(to, media, { caption: text || '' });
    } else {
      // Envio de texto
      result = await client.sendMessage(to, text || '');
    }

    res.json({
      success: true,
      message: 'Mensagem enviada',
      to,
      port: porta,
      result: { id: result?.id?._serialized || null },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Erro ao enviar (porta ${porta}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Servidor ----------
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);

  // Configurar Puppeteer antes de iniciar os clientes
  await setupPuppeteer();

  // Sobe os 2 canais automaticamente
  for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
    console.log(`🔌 Iniciando canal ${porta} (${CANAIS_CONFIG[porta].nome})...`);
    startClient(porta).catch((err) =>
      console.error(`Falha ao iniciar canal ${porta}:`, err.message)
    );
  }
});
