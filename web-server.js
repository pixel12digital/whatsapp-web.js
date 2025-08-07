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

const PORT = process.env.PORT || 3000;
let clients = {}; // Objeto para gerenciar múltiplos clientes por porta
let qrCodes = {}; // QR Codes por porta
let connectionStatus = {}; // Status de conexão por porta
let reconnectAttempts = {}; // Tentativas de reconexão por porta
let maxReconnectAttempts = 5;

// Função para verificar se realmente está conectado
async function checkConnectionStatus(port) {
    const client = clients[port];
    if (!client) return false;
    
    try {
        // Verificar se o cliente está realmente conectado
        const state = await client.getState();
        const isReallyConnected = state === 'CONNECTED' || state === 'READY';
        
        if (isReallyConnected !== connectionStatus[port]) {
            console.log(`🔄 Status mudou na porta ${port}: ${connectionStatus[port]} -> ${isReallyConnected}`);
            connectionStatus[port] = isReallyConnected;
            if (isReallyConnected) {
                qrCodes[port] = null; // Limpar QR quando conectado
                reconnectAttempts[port] = 0; // Resetar tentativas de reconexão
                console.log(`✅ Conexão estabelecida e estável na porta ${port}`);
            } else {
                console.log(`⚠️ Conexão perdida na porta ${port}, iniciando reconexão...`);
                scheduleReconnect(port);
            }
        }
        
        return isReallyConnected;
    } catch (error) {
        console.log(`❌ Erro ao verificar status na porta ${port}:`, error.message);
        if (connectionStatus[port]) {
            connectionStatus[port] = false;
            scheduleReconnect(port);
        }
        return false;
    }
}

// Função para agendar reconexão
function scheduleReconnect(port) {
    if (!reconnectAttempts[port]) {
        reconnectAttempts[port] = 0;
    }
    
    if (reconnectAttempts[port] < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts[port]), 30000); // Exponential backoff, max 30s
        console.log(`🔄 Agendando reconexão na porta ${port} em ${delay/1000}s (tentativa ${reconnectAttempts[port] + 1}/${maxReconnectAttempts})`);
        
        setTimeout(() => {
            reconnectAttempts[port]++;
            startClient(port);
        }, delay);
    } else {
        console.log(`❌ Máximo de tentativas de reconexão atingido na porta ${port}`);
    }
}

// Função para iniciar cliente
async function startClient(port) {
    if (clients[port] && connectionStatus[port]) return;
    
    console.log(`�� Iniciando WhatsApp client na porta ${port}...`);
    
    try {
        // Se já tem cliente nesta porta, destruir primeiro
        if (clients[port]) {
            try {
                await clients[port].destroy();
            } catch (e) {
                console.log(`Cliente anterior na porta ${port} já destruído`);
            }
            delete clients[port];
            connectionStatus[port] = false;
            qrCodes[port] = null;
        }
        
        clients[port] = new Client({
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

        clients[port].on('qr', (qr) => {
            console.log(`📱 QR Code recebido na porta ${port}!`);
            qrCodes[port] = qr;
        });

        clients[port].on('ready', () => {
            console.log(`✅ WhatsApp conectado na porta ${port}!`);
            connectionStatus[port] = true;
            qrCodes[port] = null;
            reconnectAttempts[port] = 0;
        });

        clients[port].on('authenticated', () => {
            console.log(`🔐 WhatsApp autenticado na porta ${port}!`);
            connectionStatus[port] = true;
            qrCodes[port] = null;
            reconnectAttempts[port] = 0;
        });

        clients[port].on('disconnected', (reason) => {
            console.log(`❌ WhatsApp desconectado na porta ${port}:`, reason);
            connectionStatus[port] = false;
            qrCodes[port] = null;
            scheduleReconnect(port);
        });

        clients[port].on('auth_failure', (msg) => {
            console.log(`❌ Falha na autenticação na porta ${port}:`, msg);
            connectionStatus[port] = false;
            qrCodes[port] = null;
            scheduleReconnect(port);
        });

        await clients[port].initialize();
    } catch (error) {
        console.error(`❌ Erro ao inicializar na porta ${port}:`, error.message);
        connectionStatus[port] = false;
        scheduleReconnect(port);
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
    const requestedPort = parseInt(urlParams.get('port')) || PORT;
    
    console.log(`📡 ${req.method} ${path} (porta: ${requestedPort})`);
    
    try {
        if (path === '/' || path === '/health') {
            // Verificar status real antes de responder
            await checkConnectionStatus(requestedPort);
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                status: 'OK',
                connected: connectionStatus[requestedPort] || false,
                port: requestedPort,
                reconnectAttempts: reconnectAttempts[requestedPort] || 0,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/qr') {
            // SEMPRE verificar status real primeiro
            await checkConnectionStatus(requestedPort);
            
            // Se não está conectado, tentar gerar QR Code
            if (!connectionStatus[requestedPort]) {
                if (!clients[requestedPort]) {
                    console.log(`🔄 Iniciando cliente para gerar QR Code na porta ${requestedPort}...`);
                    startClient(requestedPort);
                    
                    // Aguardar 8 segundos para o QR code ser gerado
                    let attempts = 0;
                    while (!qrCodes[requestedPort] && attempts < 8) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        console.log(`⏳ Aguardando QR Code na porta ${requestedPort}... tentativa ${attempts}/8`);
                    }
                } else if (!qrCodes[requestedPort]) {
                    // Se já tem cliente mas não tem QR, aguardar mais um pouco
                    let attempts = 0;
                    while (!qrCodes[requestedPort] && attempts < 5) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                    }
                }
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                qr: qrCodes[requestedPort] || 'QR code não disponível',
                connected: connectionStatus[requestedPort] || false,
                port: requestedPort,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/status') {
            // SEMPRE verificar status real
            await checkConnectionStatus(requestedPort);
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: connectionStatus[requestedPort] || false,
                port: requestedPort,
                reconnectAttempts: reconnectAttempts[requestedPort] || 0,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/connect') {
            if (!clients[requestedPort]) {
                startClient(requestedPort);
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: `Cliente iniciado na porta ${requestedPort}`,
                port: requestedPort,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/test') {
            // Verificar status real antes de responder
            await checkConnectionStatus(requestedPort);
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Serviço funcionando',
                connected: connectionStatus[requestedPort] || false,
                port: requestedPort,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/send') {
            // Verificar status real antes de enviar
            await checkConnectionStatus(requestedPort);
            
            if (!connectionStatus[requestedPort]) {
                res.writeHead(400);
                res.end(JSON.stringify({ 
                    success: false,
                    error: `WhatsApp não está conectado na porta ${requestedPort}`
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
                            error: 'Destinatário e mensagem são obrigatórios'
                        }));
                        return;
                    }
                    
                    console.log(`📤 Enviando mensagem para ${to} via porta ${requestedPort}: ${message}`);
                    
                    // Enviar mensagem
                    const result = await clients[requestedPort].sendMessage(to, message);
                    
                    console.log(`✅ Mensagem enviada com sucesso para ${to} via porta ${requestedPort}`);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        message: 'Mensagem enviada com sucesso',
                        to: to,
                        port: requestedPort,
                        timestamp: new Date().toISOString()
                    }));
                } catch (error) {
                    console.error(`❌ Erro ao enviar mensagem via porta ${requestedPort}: ${error.message}`);
                    res.writeHead(500);
                    res.end(JSON.stringify({ 
                        success: false,
                        error: error.message
                    }));
                }
            });
            
            return; // Importante: retornar aqui para não executar o código abaixo
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ 
                success: false,
                error: 'Endpoint não encontrado',
                available: ['/health', '/qr', '/status', '/connect', '/test', '/send'],
                usage: 'Adicione ?port=3000 ou ?port=3001 para especificar a porta'
            }));
        }
    } catch (error) {
        console.error('❌ Erro:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            success: false,
            error: error.message
        }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health`);
    console.log(`📱 QR: http://localhost:${PORT}/qr`);
    console.log(`🔧 Para porta específica: http://localhost:${PORT}/qr?port=3000 ou http://localhost:${PORT}/qr?port=3001`);
    
    // INICIAR CLIENTES AUTOMATICAMENTE
    console.log('�� Iniciando WhatsApp clients automaticamente...');
    startClient(3000); // Canal IA
    startClient(3001); // Canal Humano
    
    // Verificar conexões a cada 30 segundos
    setInterval(async () => {
        await checkConnectionStatus(3000);
        await checkConnectionStatus(3001);
    }, 30000);
});
