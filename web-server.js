const http = require('http');

// Tentar importar o Client
let Client;
try {
    const whatsappWeb = require('./');
    Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
} catch (e) {
    try {
        const whatsappWeb = require('./dist/index.js');
        Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
    } catch (e2) {
        console.error('❌ Erro ao carregar whatsapp-web.js:', e2.message);
        process.exit(1);
    }
}

const PORT = process.env.PORT || 8080;

// Configuração dos canais
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

// Estado global para múltiplos clientes
const clients = {};
const qrCodes = {};
const connectionStatus = {};
const reconnectAttempts = {};

// Função para iniciar cliente específico
async function startClient(porta) {
    if (clients[porta]) {
        console.log(`🔄 Cliente da porta ${porta} já existe`);
        return;
    }
    
    console.log(`�� Iniciando WhatsApp client para porta ${porta} (${CANAIS_CONFIG[porta]?.nome})`);
    
    try {
        clients[porta] = new Client({
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

// Função para verificar status real da conexão
async function checkConnectionStatus(porta) {
    if (!clients[porta]) return false;
    
    try {
        const state = await clients[porta].getState();
        const isConnected = state === 'CONNECTED';
        connectionStatus[porta] = isConnected;
        return isConnected;
    } catch (error) {
        console.error(`❌ Erro ao verificar status da porta ${porta}:`, error.message);
        connectionStatus[porta] = false;
        return false;
    }
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
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
        if (path === '/' || path === '/health') {
            const isConnected = await checkConnectionStatus(porta);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                status: 'OK',
                connected: isConnected,
                port: porta,
                numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                reconnectAttempts: reconnectAttempts[porta] || 0,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/qr') {
            // Se não está conectado e não tem cliente, iniciar
            if (!connectionStatus[porta] && !clients[porta]) {
                console.log(`🔄 Iniciando cliente para gerar QR Code na porta ${porta}...`);
                startClient(porta);
                
                // Aguardar QR Code
                let attempts = 0;
                while (!qrCodes[porta] && attempts < 10) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attempts++;
                    console.log(`⏳ Aguardando QR Code porta ${porta}... tentativa ${attempts}/10`);
                }
            }
            
            const isConnected = await checkConnectionStatus(porta);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                qr: qrCodes[porta] || 'QR code não disponível',
                connected: isConnected,
                port: porta,
                numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/status') {
            const isConnected = await checkConnectionStatus(porta);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: isConnected,
                port: porta,
                numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/connect') {
            if (!clients[porta]) {
                startClient(porta);
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Cliente iniciado',
                port: porta,
                numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/test') {
            const isConnected = await checkConnectionStatus(porta);
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Serviço funcionando',
                connected: isConnected,
                port: porta,
                numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/send') {
            const isConnected = await checkConnectionStatus(porta);
            if (!isConnected) {
                res.writeHead(400);
                res.end(JSON.stringify({ 
                    success: false,
                    error: 'WhatsApp não está conectado',
                    port: porta,
                    numero: CANAIS_CONFIG[porta]?.numero || 'N/A'
                }));
                return;
            }
            
            // Ler dados do POST
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { to, message } = data;
                    
                    if (!to || !message) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ 
                            success: false,
                            error: 'Destinatário e mensagem são obrigatórios',
                            port: porta
                        }));
                        return;
                    }
                    
                    console.log(`📤 Enviando mensagem da porta ${porta} para ${to}: ${message}`);
                    
                    // Enviar mensagem
                    const result = await clients[porta].sendMessage(to, message);
                    
                    console.log(`✅ Mensagem enviada com sucesso da porta ${porta} para ${to}`);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        message: 'Mensagem enviada com sucesso',
                        to: to,
                        port: porta,
                        numero: CANAIS_CONFIG[porta]?.numero || 'N/A',
                        nome: CANAIS_CONFIG[porta]?.nome || 'N/A',
                        timestamp: new Date().toISOString()
                    }));
                } catch (error) {
                    console.error(`❌ Erro ao enviar mensagem da porta ${porta}: ${error.message}`);
                    res.writeHead(500);
                    res.end(JSON.stringify({ 
                        success: false,
                        error: error.message,
                        port: porta
                    }));
                }
            });
            
            return;
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ 
                success: false,
                error: 'Endpoint não encontrado',
                available: ['/health', '/qr', '/status', '/connect', '/test', '/send'],
                canais: Object.keys(CANAIS_CONFIG)
            }));
        }
    } catch (error) {
        console.error('❌ Erro:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            success: false,
            error: error.message,
            port: porta
        }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health`);
    console.log(`📱 QR: http://localhost:${PORT}/qr`);
    
    // INICIAR AMBOS OS CLIENTES AUTOMATICAMENTE
    console.log('�� Iniciando clientes WhatsApp automaticamente...');
    startClient(3000); // Atendimento IA
    startClient(3001); // Atendimento Humano
    
    // Verificar status periodicamente
    setInterval(async () => {
        for (const porta of Object.keys(CANAIS_CONFIG)) {
            await checkConnectionStatus(parseInt(porta));
        }
    }, 30000);
});
