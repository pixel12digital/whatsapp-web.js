// web-server.js
const http = require('http');
const QRCode = require('qrcode');

// --- Carregar whatsapp-web.js (fork) de forma defensiva
let whatsappWeb;
try {
  whatsappWeb = require('./'); // repo raiz
} catch (e) {
  try {
    whatsappWeb = require('./dist/index.js'); // build
  } catch (e2) {
    console.error('❌ Erro ao carregar whatsapp-web.js:', e2.message);
    process.exit(1);
  }
}

const Client =
  whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
const LocalAuth =
  whatsappWeb.LocalAuth || whatsappWeb.default?.LocalAuth || undefined;
const MessageMedia =
  whatsappWeb.MessageMedia || whatsappWeb.default?.MessageMedia || undefined;

const PORT = process.env.PORT || 3000;

// ===================== CONFIG DOS CANAIS =====================
const CANAIS_CONFIG = {
  3000: {
    numero: '554797146908@c.us',
    nome: 'Atendimento IA',
    descricao: 'Pixel12Digital - IA',
  },
  3001: {
    numero: '554797309525@c.us',
    nome: 'Atendimento Humano',
    descricao: 'Pixel - Comercial',
  },
};

// ===================== ESTADO GLOBAL =====================
const clients = {};
const qrCodes = {};
const connectionStatus = {};
const reconnectAttempts = {};

// ===================== UTILS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Proteção simples via header X-API-TOKEN (opcional)
function checkToken(req) {
  const token = process.env.API_TOKEN;
  if (!token) return true; // se não configurado, libera
  return req.headers['x-api-token'] === token;
}

// ===================== WHATSAPP CLIENT =====================
async function startClient(porta) {
  if (clients[porta]) {
    console.log(`🔄 Cliente ${porta} já existe.`);
    return;
  }

  console.log(`🚀 Iniciando WhatsApp client para porta ${porta} (${CANAIS_CONFIG[porta]?.nome})`);

  try {
    clients[porta] = new Client({
      // Sessão persistente (vai para ./sessions => Disk do Render)
      authStrategy: LocalAuth
        ? new LocalAuth({
            dataPath: './sessions',
            clientId: `pixel12_${porta}`, // sessão única por canal
          })
        : undefined,
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-images',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--mute-audio',
          '--no-zygote',
          '--single-process',
        ],
        timeout: 60000,
        protocolTimeout: 60000,
      },
    });

    clients[porta].on('qr', (qr) => {
      console.log(`📱 QR recebido (porta ${porta})`);
      qrCodes[porta] = qr; // string para gerar o PNG
    });

    clients[porta].on('ready', () => {
      console.log(`✅ Conectado (porta ${porta})`);
      connectionStatus[porta] = true;
      qrCodes[porta] = null;
    });

    clients[porta].on('authenticated', () => {
      console.log(`🔐 Autenticado (porta ${porta})`);
      connectionStatus[porta] = true;
      qrCodes[porta] = null;
    });

    clients[porta].on('disconnected', (reason) => {
      console.log(`❌ Desconectado (porta ${porta}): ${reason}`);
      connectionStatus[porta] = false;
      qrCodes[porta] = null;
      delete clients[porta];
    });

    clients[porta].on('auth_failure', (msg) => {
      console.log(`❌ Falha na autenticação (porta ${porta}): ${msg}`);
      connectionStatus[porta] = false;
      qrCodes[porta] = null;
      delete clients[porta];
    });

    await clients[porta].initialize();
  } catch (error) {
    console.error(`❌ Erro ao iniciar porta ${porta}:`, error.message);
    connectionStatus[porta] = false;
    delete clients[porta];
  }
}

async function checkConnectionStatus(porta) {
  if (!clients[porta]) return false;
  try {
    const state = await clients[porta].getState();
    const ok = state === 'CONNECTED';
    connectionStatus[porta] = ok;
    return ok;
  } catch (e) {
    connectionStatus[porta] = false;
    return false;
  }
}

// ===================== HTTP SERVER =====================
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-TOKEN');
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  // Token (exceto health)
  const path = req.url.split('?')[0];
  if (!checkToken(req) && path !== '/health') {
    return json(res, 401, { success: false, error: 'unauthorized' });
  }

  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const porta = parseInt(urlParams.get('port')) || 3000;

  console.log(`📡 ${req.method} ${path} (porta: ${porta})`);

  try {
    // ---------- HEALTH ----------
    if (path === '/' || path === '/health') {
      const isConnected = await checkConnectionStatus(porta);
      return json(res, 200, {
        success: true,
        status: 'OK',
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        reconnectAttempts: reconnectAttempts[porta] || 0,
        timestamp: new Date().toISOString(),
      });
    }

    // ---------- CONNECT ----------
    if (path === '/connect') {
      if (!clients[porta]) startClient(porta);
      return json(res, 200, {
        success: true,
        message: 'Cliente iniciado',
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString(),
      });
    }

    // ---------- STATUS ----------
    if (path === '/status') {
      const isConnected = await checkConnectionStatus(porta);
      return json(res, 200, {
        success: true,
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString(),
      });
    }

    // ---------- QR (TEXTO) ----------
    if (path === '/qr') {
      // garanta um cliente rodando e aguarde o QR por alguns segundos
      if (!connectionStatus[porta] && !clients[porta]) startClient(porta);

      let attempts = 0;
      while (!qrCodes[porta] && attempts < 12 && !connectionStatus[porta]) {
        await sleep(1000);
        attempts++;
      }

      const isConnected = await checkConnectionStatus(porta);
      return json(res, 200, {
        success: true,
        qr: qrCodes[porta] || 'QR code não disponível',
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString(),
      });
    }

    // ---------- QR (PNG) ----------
    if (path === '/qr.png') {
      // Gera/espera QR
      if (!connectionStatus[porta] && !clients[porta]) startClient(porta);

      let attempts = 0;
      while (!qrCodes[porta] && attempts < 12 && !connectionStatus[porta]) {
        await sleep(1000);
        attempts++;
      }

      if (!qrCodes[porta]) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('QR indisponível. Tente novamente em alguns segundos.');
      }

      try {
        const png = await QRCode.toBuffer(qrCodes[porta], {
          type: 'png',
          scale: 8,
          margin: 2,
        });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Falha ao renderizar QR.');
      }
    }

    // ---------- TEST ----------
    if (path === '/test') {
      const ok = await checkConnectionStatus(porta);
      return json(res, 200, {
        success: true,
        message: 'Serviço funcionando',
        connected: ok,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString(),
      });
    }

    // ---------- SEND (TEXTO) ----------
    if (path === '/send' && req.method === 'POST') {
      const ok = await checkConnectionStatus(porta);
      if (!ok) return json(res, 400, { success: false, error: 'WhatsApp não está conectado' });

      let body = '';
      req.on('data', (c) => (body += c.toString()));
      req.on('end', async () => {
        try {
          const { to, message } = JSON.parse(body || '{}');
          if (!to || !message) return json(res, 400, { success: false, error: 'Destinatário e mensagem são obrigatórios' });

          await clients[porta].sendMessage(to, message);
          return json(res, 200, {
            success: true,
            message: 'Mensagem enviada',
            to,
            port: porta,
            numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
            nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          return json(res, 500, { success: false, error: e.message });
        }
      });
      return;
    }

    // ---------- SEND MEDIA (URL ou BASE64) ----------
    if (path === '/sendMedia' && req.method === 'POST') {
      const ok = await checkConnectionStatus(porta);
      if (!ok) return json(res, 400, { success: false, error: 'WhatsApp não está conectado' });

      let body = '';
      req.on('data', (c) => (body += c.toString()));
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const { to, mediaUrl, base64, mimeType, filename, caption, sendAudioAsVoice } = data || {};
          if (!to) return json(res, 400, { success: false, error: 'Destinatário é obrigatório' });

          let media;
          if (mediaUrl && MessageMedia?.fromUrl) {
            media = await MessageMedia.fromUrl(mediaUrl);
          } else if (base64 && mimeType) {
            media = new MessageMedia(mimeType, base64, filename || 'file');
          } else {
            return json(res, 400, { success: false, error: 'Informe mediaUrl OU base64+mimeType' });
          }

          await clients[porta].sendMessage(to, media, {
            caption: caption || '',
            sendAudioAsVoice: !!sendAudioAsVoice, // true = PTT
          });

          return json(res, 200, {
            success: true,
            message: 'Mídia enviada',
            to,
            port: porta,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          return json(res, 500, { success: false, error: e.message });
        }
      });
      return;
    }

    // ---------- 404 ----------
    return json(res, 404, {
      success: false,
      error: 'Endpoint não encontrado',
      available: ['/health', '/connect', '/status', '/qr', '/qr.png', '/test', '/send', '/sendMedia'],
      canais: Object.keys(CANAIS_CONFIG),
    });
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return json(res, 500, { success: false, error: error.message, port: porta });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🧪 Health: http://localhost:${PORT}/health`);
  console.log(`🖼️  QR PNG 3000: http://localhost:${PORT}/qr.png?port=3000`);
  console.log(`🖼️  QR PNG 3001: http://localhost:${PORT}/qr.png?port=3001`);

  console.log('🔄 Iniciando clientes automaticamente...');
  // sobe 3000 e 8s depois 3001 (ajuda no consumo de RAM/CPU)
  startClient(3000);
  setTimeout(() => startClient(3001), 8000);

  // verificação periódica
  setInterval(async () => {
    for (const p of Object.keys(CANAIS_CONFIG)) {
      await checkConnectionStatus(parseInt(p, 10));
    }
  }, 30000);
});
