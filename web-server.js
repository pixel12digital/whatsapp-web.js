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
 * - Chrome detection: Tenta encontrar Chrome no sistema, se não encontrar usa Chrome do Puppeteer.
 * - Fallback: Se Chrome não for encontrado, usa configuração mínima sem executablePath.
 */

// Configuração do Puppeteer para Render.com
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'false'; // Permitir download do Chromium se necessário

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');

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
 * Verifica se o Chrome está disponível no ambiente Render
 */
async function checkChromeAvailability() {
  try {
    console.log('🔍 Verificando disponibilidade do Chrome...');
    
    // Lista de possíveis caminhos do Chrome no sistema (priorizando o cache do Render)
    const possiblePaths = [
      '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
      '/usr/bin/chrome',
      '/usr/bin/chrome-browser',
      '/usr/bin/google-chrome-stable'
    ];
    
    console.log('🔍 Verificando caminhos do Chrome...');
    for (const chromePath of possiblePaths) {
      try {
        if (fs.existsSync(chromePath)) {
          console.log('✅ Chrome encontrado em:', chromePath);
          return chromePath;
        } else {
          console.log(`❌ Chrome não encontrado em: ${chromePath}`);
        }
      } catch (pathError) {
        console.log(`⚠️ Erro ao verificar caminho ${chromePath}:`, pathError.message);
      }
    }
    
    console.log('⚠️ Chrome não encontrado em caminhos específicos. Usando Chrome do Puppeteer...');
    return null;
    
  } catch (error) {
    console.log('❌ Erro ao verificar Chrome:', error.message);
    return null;
  }
}

/**
 * Verifica e configura o Puppeteer para o ambiente Render
 */
async function setupPuppeteer() {
  console.log('🔧 Configurando Puppeteer para Render.com...');
  
  try {
    // Verificar se o Chrome está disponível
    const chromePath = await checkChromeAvailability();
    
    if (chromePath) {
      console.log('✅ Chrome encontrado e configurado para Render.com:', chromePath);
      return chromePath;
    } else {
      console.log('ℹ️ Usando Chrome do Puppeteer (download automático se necessário)...');
      return null;
    }
    
  } catch (error) {
    console.error('❌ Erro ao configurar Puppeteer:', error.message);
    return null;
  }
}

// ---------- Criação do Client ----------
function buildClient(porta, chromePath = null) {
  const cfg = CANAIS_CONFIG[porta];
  if (!cfg) throw new Error(`Porta ${porta} não mapeada em CANAIS_CONFIG.`);

  // Configuração do Puppeteer otimizada para Render
  const puppeteerConfig = {
    // Argumentos do Chrome para ambiente Render
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
    timeout: 120000, // Aumentado para 2 minutos
    protocolTimeout: 120000, // Aumentado para 2 minutos
  };

  // Adicionar executablePath apenas se o Chrome for encontrado E existir
  if (chromePath && fs.existsSync(chromePath)) {
    puppeteerConfig.executablePath = chromePath;
    console.log(`🧭 Configurando cliente para porta ${porta} com Chrome: ${chromePath}`);
  } else {
    console.log(`🧭 Configurando cliente para porta ${porta} com Chrome do Puppeteer (sem executablePath)`);
  }

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
    try { 
      await client.destroy(); 
    } catch (destroyError) {
      console.log(`⚠️ Erro ao destruir cliente (porta ${porta}):`, destroyError.message);
    }
    clients.delete(porta);
    
    // Tentar reconectar após 5 segundos
    setTimeout(() => {
      console.log(`🔄 Recriando cliente (porta ${porta})...`);
      startClient(porta, null).catch(err => {
        console.error(`❌ Erro recriando ${porta}:`, err.message);
        // Tentar novamente após mais 10 segundos
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
    
    // Verificar se é um erro relacionado ao Chrome
    if (err.message.includes('Browser was not found') || err.message.includes('executablePath') || err.message.includes('Could not find Chrome')) {
      console.log(`⚠️ Erro de Chrome detectado para porta ${porta}. Tentando sem executablePath...`);
      
      // Tentar recriar o cliente sem executablePath
      try {
        clients.delete(porta);
        
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
            timeout: 60000,
            protocolTimeout: 60000,
            // Remover executablePath para usar Chrome do Puppeteer
          },
          authStrategy: new LocalAuth({
            clientId: CANAIS_CONFIG[porta].sessionId,
            dataPath: SESSIONS_DIR,
          }),
        });
        
        clients.set(porta, fallbackClient);
        connectionStatus.set(porta, false);
        qrCodes.set(porta, null);
        
        // Configurar eventos para o cliente fallback
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
            startClient(porta, null).catch(err => console.error(`Erro recriando ${porta}:`, err.message));
          }, 5000);
        });
        
        fallbackClient.on('change_state', (state) => {
          lastState.set(porta, state);
          console.log(`ℹ️ State (porta ${porta}) = ${state}`);
        });
        
        fallbackClient.on('auth_failure', (msg) => {
          console.log(`⚠️ Falha de autenticação (porta ${porta}) → ${msg}`);
          connectionStatus.set(porta, false);
        });
        
        await fallbackClient.initialize();
        console.log(`✅ Cliente fallback inicializado com sucesso (porta ${porta})`);
        return fallbackClient;
        
      } catch (fallbackErr) {
        console.error(`❌ Erro também no fallback (porta ${porta}):`, fallbackErr.message);
        
        // Se ainda falhar, tentar uma última vez com configuração mínima
        try {
          console.log(`🔄 Tentativa final para porta ${porta} com configuração mínima...`);
          clients.delete(porta);
          
          const minimalClient = new Client({
            puppeteer: {
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-background-networking',
                '--disable-sync',
                '--hide-scrollbars',
                '--mute-audio'
              ],
              headless: true,
              timeout: 120000,
              protocolTimeout: 120000,
              // Remover executablePath para usar Chrome do Puppeteer
            },
            authStrategy: new LocalAuth({
              clientId: CANAIS_CONFIG[porta].sessionId,
              dataPath: SESSIONS_DIR,
            }),
          });
          
          clients.set(porta, minimalClient);
          connectionStatus.set(porta, false);
          qrCodes.set(porta, null);
          
          // Configurar eventos para o cliente mínimo
          minimalClient.on('qr', (qr) => {
            qrCodes.set(porta, qr);
            console.log(`📱 QR recebido (porta ${porta})`);
          });
          
          minimalClient.on('authenticated', () => {
            console.log(`✅ Autenticado (porta ${porta})`);
          });
          
          minimalClient.on('ready', async () => {
            connectionStatus.set(porta, true);
            qrCodes.set(porta, null);
            console.log(`✅ Pronto/Conectado (porta ${porta})`);
          });
          
          minimalClient.on('disconnected', async (reason) => {
            console.log(`❌ Desconectado (porta ${porta}) → ${reason}`);
            connectionStatus.set(porta, false);
            qrCodes.set(porta, null);
            try { await minimalClient.destroy(); } catch (_) {}
            clients.delete(porta);
            setTimeout(() => {
              console.log(`🔄 Recriando cliente (porta ${porta})...`);
              startClient(porta, null).catch(err => console.error(`Erro recriando ${porta}:`, err.message));
            }, 5000);
          });
          
          minimalClient.on('change_state', (state) => {
            lastState.set(porta, state);
            console.log(`ℹ️ State (porta ${porta}) = ${state}`);
          });
          
          minimalClient.on('auth_failure', (msg) => {
            console.log(`⚠️ Falha de autenticação (porta ${porta}) → ${msg}`);
            connectionStatus.set(porta, false);
          });
          
          await minimalClient.initialize();
          console.log(`✅ Cliente mínimo inicializado com sucesso (porta ${porta})`);
          return minimalClient;
          
        } catch (minimalErr) {
          console.error(`❌ Erro também na tentativa mínima (porta ${porta}):`, minimalErr.message);
          connectionStatus.set(porta, false);
          clients.delete(porta);
          throw minimalErr;
        }
      }
    }
    
    connectionStatus.set(porta, false);
    clients.delete(porta);
    throw err;
  }
}

// ---------- Util ----------
function getPortFromQuery(req) {
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  return parseInt(url.searchParams.get('port')) || 3000;
}

// ---------- Validação de Configuração ----------
function validateConfiguration() {
  console.log('🔍 Validando configuração...');
  
  // Verificar se as portas estão configuradas
  const configuredPorts = Object.keys(CANAIS_CONFIG).map(Number);
  if (configuredPorts.length === 0) {
    throw new Error('Nenhuma porta configurada em CANAIS_CONFIG');
  }
  
  console.log(`✅ Portas configuradas: ${configuredPorts.join(', ')}`);
  
  // Verificar se as pastas de sessão existem
  try {
    fs.ensureDirSync(SESSIONS_DIR);
    console.log(`✅ Pasta de sessões criada/verificada: ${SESSIONS_DIR}`);
  } catch (error) {
    console.error(`❌ Erro ao criar pasta de sessões: ${error.message}`);
    throw error;
  }
  
  // Verificar se o whatsapp-web.js foi carregado corretamente
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
    await startClient(porta, null);
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

    // Se ainda não existe cliente, inicializa para gerar QR
    if (!clients.get(porta)) {
      try { 
        await startClient(porta, null); 
      } catch (startError) {
        console.log(`⚠️ Erro ao iniciar cliente para QR (porta ${porta}):`, startError.message);
      }
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
  } catch (error) {
    console.error('❌ Erro no endpoint /qr:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/qr.png', async (req, res) => {
  try {
    const porta = getPortFromQuery(req);

    if (!clients.get(porta)) {
      try { 
        await startClient(porta, null); 
      } catch (startError) {
        console.log(`⚠️ Erro ao iniciar cliente para QR PNG (porta ${porta}):`, startError.message);
      }
      for (let i = 0; i < 10 && !qrCodes.get(porta); i++) {
        await sleep(1000);
      }
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

    if (!to) {
      return res.status(400).json({ success: false, error: 'Campo "to" é obrigatório (ex: 559999999999@c.us).' });
    }

    if (!clients.get(porta) || !(connectionStatus.get(porta))) {
      return res.status(400).json({ success: false, error: 'WhatsApp não está conectado.' });
    }

    const client = clients.get(porta);
    if (!client) {
      return res.status(400).json({ success: false, error: 'Cliente não encontrado.' });
    }

    let result;
    if (mediaBase64 && mimeType && filename) {
      // Envio de mídia em base64
      try {
        const media = new MessageMedia(mimeType, mediaBase64, filename);
        result = await client.sendMessage(to, media, { caption: text || '' });
      } catch (mediaError) {
        console.error(`❌ Erro ao enviar mídia (porta ${porta}):`, mediaError.message);
        return res.status(500).json({ success: false, error: `Erro ao enviar mídia: ${mediaError.message}` });
      }
    } else {
      // Envio de texto
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
  
  // Encerrar todos os clientes
  for (const [porta, client] of clients.entries()) {
    try {
      console.log(`🔄 Encerrando cliente (porta ${porta})...`);
      await client.destroy();
      console.log(`✅ Cliente encerrado (porta ${porta})`);
    } catch (error) {
      console.error(`❌ Erro ao encerrar cliente (porta ${porta}):`, error.message);
    }
  }
  
  // Limpar mapas
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
        // Tentar novamente sem chromePath
        setTimeout(() => {
          console.log(`🔄 Tentando novamente canal ${porta} sem chromePath...`);
          startClient(porta, null).catch((retryErr) => {
            console.error(`❌ Falha também na segunda tentativa do canal ${porta}:`, retryErr.message);
          });
        }, 5000);
      });
    }
  } catch (error) {
    console.error('❌ Erro crítico ao inicializar servidor:', error.message);
    // Tentar continuar mesmo com erro
    console.log('🔄 Tentando continuar sem configuração específica do Puppeteer...');
    
    for (const porta of Object.keys(CANAIS_CONFIG).map(Number)) {
      console.log(`🔄 Iniciando canal ${porta} sem configuração específica...`);
      startClient(porta, null).catch((err) => {
        console.error(`❌ Falha ao iniciar canal ${porta}:`, err.message);
      });
    }
  }
});
