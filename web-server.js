// ========================================================================
// Módulo Chat (multicanal) - Pixel12Digital
// - QR em PNG:        GET /qr.png?port=3000|3001
// - QR (texto):       GET /qr?port=3000|3001
// - Health:           GET /health?port=3000|3001
// - Status:           GET /status?port=3000|3001
// - Conectar:         GET /connect?port=3000|3001
// - Enviar texto:     POST /send?port=...
// - Enviar mídia:     POST /sendMedia?port=...
// Sessões: ./sessions/pixel12_ia e ./sessions/pixel12_humano
// ========================================================================

const http = require('http');
const QRCode = require('qrcode');

let Client, LocalAuth, MessageMedia;
try {
  const wweb = require('./');
  Client = wweb.Client || wweb.default?.Client || wweb;
  LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth;
  MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
} catch (e) {
  try {
    const wweb = require('./dist/index.js');
    Client = wweb.Client || wweb.default?.Client || wweb;
    LocalAuth = wweb.LocalAuth || wweb.default?.LocalAuth;
    MessageMedia = wweb.MessageMedia || wweb.default?.MessageMedia;
  } catch (e2) {
    console.error('❌ Erro ao carregar whatsapp-web.js:', e2.message);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;

// Configuração dos canais (por porta)
const CANAIS_CONFIG = {
  3000: {
    numero: '554797146908@c.us',
    nome: 'Atendimento IA',
    descricao: 'Pixel12Digital - IA'
  },
  3001: {
    numero: '554797309525@c.us',
    nome: 'Atendimento Humano',
    descricao: 'Pixel - Comercial'
  }
};

// Sessões persistentes por porta (ficam em ./sessions/<clientId>)
const SESSION_IDS = {
  3000: 'pixel12_ia',
  3001: 'pixel12_humano'
};

// Estado global
const clients = {};
const qrCodes = {};
const connectionStatus = {};
const reconnectAttempts = {};

// ------------------------------------------------------------------------
// Inicialização de cliente por porta (com persistência de sessão)
// ------------------------------------------------------------------------
async function startClient(porta) {
  if (clients[porta]) {
    console.log(`🔄 Cliente da porta ${porta} já existe`);
    return;
  }

  console.log(`🚀 Iniciando WhatsApp client para porta ${porta} (${CANAIS_CONFIG[porta]?.nome})`);

  try {
    clients[porta] = new Client({
      authStrategy: new LocalAuth({
        clientId: SESSION_IDS[porta],
        dataPath: './sessions'
      }),
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
          '--single-process'
        ],
        timeout: 60000,
        protocolTimeout: 60000
      }
    });

    clients[porta].on('qr', (qr) => {
      console.log(`📱 QR Code recebido para porta ${porta}!`);
      qrCodes[porta] = qr;
      connectionStatus[porta] = false;
    });

    clients[porta].on('ready', () => {
      console.log(`✅ WhatsApp conectado na porta ${porta} (${CANAIS_CONFIG[porta]?.numero})!`);
      connectionStatus[porta] = true;
      qrCodes[porta] = null;
    });

    clients[porta].on('authenticated', () => {
      console.log(`🔐 WhatsApp autenticado na porta ${porta}!`);
      connectionStatus[porta] = true;
      qrCodes[porta] = null;
    });

    clients[porta].on('disconnected', (reason) => {
      console.log(`❌ WhatsApp desconectado na porta ${porta}: ${reason}`);
      connectionStatus[porta] = false;
      qrCodes[porta] = null;
      delete clients[porta];
    });

    clients[porta].on('auth_failure', (msg) => {
      console.log(`❌ Falha na autenticação na porta ${porta}: ${msg}`);
      connectionStatus[porta] = false;
      qrCodes[porta] = null;
      delete clients[porta];
    });

    await clients[porta].initialize();
  } catch (error) {
    console.error(`❌ Erro ao inicializar porta ${porta}:`, error.message);
    connectionStatus[porta] = false;
    delete clients[porta];
  }
}

// ------------------------------------------------------------------------
// Verificar status real da conexão
// ------------------------------------------------------------------------
async function checkConnectionStatus(porta) {
  if (!clients[porta]) return false;
  try {
    const state = await clients[porta].getState().catch(() => null);
    const isConnected = state === 'CONNECTED';
    connectionStatus[porta] = !!isConnected;
    return !!isConnected;
  } catch (error) {
    console.error(`❌ Erro ao verificar status da porta ${porta}: ${error.message}`);
    connectionStatus[porta] = false;
    return false;
  }
}

// ------------------------------------------------------------------------
// Servidor HTTP
// ------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS / JSON
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const path = req.url.split('?')[0];
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const porta = parseInt(urlParams.get('port')) || 3000;

  console.log(`📡 ${req.method} ${path} (porta: ${porta})`);

  try {
    // --------------------------------------------------------------------
    if (path === '/' || path === '/health') {
      const isConnected = await checkConnectionStatus(porta);
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        status: 'OK',
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        reconnectAttempts: reconnectAttempts[porta] || 0,
        timestamp: new Date().toISOString()
      }));
    }

    // --------------------------------------------------------------------
    else if (path === '/qr') {
      // Se não está conectado e não tem cliente, iniciar
      if (!connectionStatus[porta] && !clients[porta]) {
        console.log(`🔄 Iniciando cliente para gerar QR Code na porta ${porta}...`);
        startClient(porta);

        // Aguardar geração do QR por alguns segundos
        let attempts = 0;
        while (!qrCodes[porta] && attempts < 10) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
          console.log(`⏳ Aguardando QR Code porta ${porta}... tentativa ${attempts}/10`);
        }
      }

      const isConnected = await checkConnectionStatus(porta);
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        qr: qrCodes[porta] || 'QR code não disponível',
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString()
      }));
    }

    // --------------------------------------------------------------------
    else if (path === '/qr.png') {
      // QR como imagem PNG
      const qr = qrCodes[porta];
      if (!qr) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('QR indisponível. Tente novamente em alguns segundos.');
      }
      try {
        const png = await QRCode.toBuffer(qr, { width: 320, margin: 1 });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Erro ao gerar PNG: ' + err.message);
      }
    }

    // --------------------------------------------------------------------
    else if (path === '/status') {
      const isConnected = await checkConnectionStatus(porta);
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString()
      }));
    }

    // --------------------------------------------------------------------
    else if (path === '/connect') {
      if (!clients[porta]) startClient(porta);
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: 'Cliente iniciado',
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString()
      }));
    }

    // --------------------------------------------------------------------
    else if (path === '/test') {
      const isConnected = await checkConnectionStatus(porta);
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: 'Serviço funcionando',
        connected: isConnected,
        port: porta,
        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
        timestamp: new Date().toISOString()
      }));
    }

    // --------------------------------------------------------------------
    else if (path === '/send') {
      const isConnected = await checkConnectionStatus(porta);
      if (!isConnected) {
        res.writeHead(400);
        return res.end(JSON.stringify({
          success: false,
          error: 'WhatsApp não está conectado',
          port: porta,
          numero: CANAIS_CONFIG[porta]?.numero || 'N/A'
        }));
      }

      // Ler dados do POST
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const { to, message } = data;

          if (!to || !message) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              success: false,
              error: 'Destinatário (to) e mensagem são obrigatórios',
              port: porta
            }));
          }

          console.log(`📤 Enviando mensagem da porta ${porta} para ${to}: ${message}`);
          await clients[porta].sendMessage(to, message);

          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            message: 'Mensagem enviada com sucesso',
            to, port: porta,
            numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
            nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
            timestamp: new Date().toISOString()
          }));
        } catch (error) {
          console.error(`❌ Erro ao enviar mensagem da porta ${porta}: ${error.message}`);
          res.writeHead(500);
          return res.end(JSON.stringify({
            success: false,
            error: error.message,
            port: porta
          }));
        }
      });
      return;
    }

    // --------------------------------------------------------------------
    else if (path === '/sendMedia') {
      const isConnected = await checkConnectionStatus(porta);
      if (!isConnected) {
        res.writeHead(400);
        return res.end(JSON.stringify({
          success: false,
          error: 'WhatsApp não está conectado',
          port: porta
        }));
      }

      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });

      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const { to, mediaUrl, caption, mediaBase64, mimeType } = data;

          if (!to || (!mediaUrl && !mediaBase64)) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              success: false,
              error: 'Parâmetros obrigatórios: to e (mediaUrl OU mediaBase64+mimeType)'
            }));
          }

          let media;
          if (mediaUrl) {
            media = await MessageMedia.fromUrl(mediaUrl);
          } else {
            if (!mimeType) throw new Error('mimeType é obrigatório quando usar mediaBase64');
            media = new MessageMedia(mimeType, mediaBase64, 'arquivo');
          }

          const opts = {};
          if (media.mimetype?.startsWith('audio/')) {
            // Envia como mensagem de voz (PTT)
            opts.sendAudioAsVoice = true;
          }
          if (caption) opts.caption = caption;

          await clients[porta].sendMessage(to, media, opts);

          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, port: porta, to }));
        } catch (err) {
          console.error(`❌ Erro em /sendMedia [${porta}]:`, err);
          res.writeHead(500);
          return res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    // --------------------------------------------------------------------
    // 404
    else {
      res.writeHead(404);
      return res.end(JSON.stringify({
        success: false,
        error: 'Endpoint não encontrado',
        available: ['/health', '/qr', '/qr.png', '/status', '/connect', '/test', '/send', '/sendMedia'],
        canais: Object.keys(CANAIS_CONFIG)
      }));
    }
  } catch (error) {
    console.error('❌ Erro:', error.message);
    res.writeHead(500);
    return res.end(JSON.stringify({
      success: false,
      error: error.message,
      port: porta
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`📱 QR texto: http://localhost:${PORT}/qr?port=3000`);
  console.log(`🖼️  QR PNG : http://localhost:${PORT}/qr.png?port=3000`);

  // Iniciar os dois clientes automaticamente
  console.log('🔄 Iniciando clientes WhatsApp automaticamente...');
  startClient(3000); // Atendimento IA
  startClient(3001); // Atendimento Humano

  // Verificar status periodicamente
  setInterval(async () => {
    for (const p of Object.keys(CANAIS_CONFIG)) {
      await checkConnectionStatus(parseInt(p, 10));
    }
  }, 30000);
});
