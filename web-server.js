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
let currentQR = null;
let client = null;
let isConnected = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectInterval = null;

// Função para verificar se realmente está conectado
async function checkConnectionStatus() {
    if (!client) return false;
    
    try {
        // Verificar se o cliente está realmente conectado
        const state = await client.getState();
        const isReallyConnected = state === 'CONNECTED' || state === 'READY';
        
        if (isReallyConnected !== isConnected) {
            console.log(`�� Status mudou: ${isConnected} -> ${isReallyConnected}`);
            isConnected = isReallyConnected;
            if (isConnected) {
                currentQR = null; // Limpar QR quando conectado
                reconnectAttempts = 0; // Resetar tentativas de reconexão
                console.log('✅ Conexão estabelecida e estável');
            } else {
                console.log('⚠️ Conexão perdida, iniciando reconexão...');
                scheduleReconnect();
            }
        }
        
        return isReallyConnected;
    } catch (error) {
        console.log('❌ Erro ao verificar status:', error.message);
        if (isConnected) {
            isConnected = false;
            scheduleReconnect();
        }
        return false;
    }
}

// Função para agendar reconexão
function scheduleReconnect() {
    if (reconnectInterval) {
        clearTimeout(reconnectInterval);
    }
    
    if (reconnectAttempts < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff, max 30s
        console.log(`🔄 Agendando reconexão em ${delay/1000}s (tentativa ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
        
        reconnectInterval = setTimeout(() => {
            reconnectAttempts++;
            startClient();
        }, delay);
    } else {
        console.log('❌ Máximo de tentativas de reconexão atingido');
    }
}

// Função para iniciar cliente
async function startClient() {
    if (client && isConnected) return;
    
    console.log('�� Iniciando WhatsApp client...');
    
    try {
        // Se já tem cliente, destruir primeiro
        if (client) {
            try {
                await client.destroy();
            } catch (e) {
                console.log('Cliente anterior já destruído');
            }
            client = null;
            isConnected = false;
            currentQR = null;
        }
        
        client = new Client({
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
                timeout: 60000, // Aumentado para 60 segundos
                protocolTimeout: 60000
            }
        });

        client.on('qr', (qr) => {
            console.log('📱 QR Code recebido!');
            currentQR = qr;
        });

        client.on('ready', () => {
            console.log('✅ WhatsApp conectado!');
            isConnected = true;
            currentQR = null;
            reconnectAttempts = 0;
        });

        client.on('authenticated', () => {
            console.log('🔐 WhatsApp autenticado!');
            isConnected = true;
            currentQR = null;
            reconnectAttempts = 0;
        });

        client.on('disconnected', (reason) => {
            console.log('❌ WhatsApp desconectado:', reason);
            isConnected = false;
            currentQR = null;
            scheduleReconnect();
        });

        client.on('auth_failure', (msg) => {
            console.log('❌ Falha na autenticação:', msg);
            isConnected = false;
            currentQR = null;
            scheduleReconnect();
        });

        await client.initialize();
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error.message);
        isConnected = false;
        scheduleReconnect();
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
    console.log(`📡 ${req.method} ${path}`);
    
    try {
        if (path === '/' || path === '/health') {
            // Verificar status real antes de responder
            await checkConnectionStatus();
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                status: 'OK',
                connected: isConnected,
                reconnectAttempts: reconnectAttempts,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/qr') {
            // SEMPRE verificar status real primeiro
            await checkConnectionStatus();
            
            // Se não está conectado, tentar gerar QR Code
            if (!isConnected) {
                if (!client) {
                    console.log('🔄 Iniciando cliente para gerar QR Code...');
                    startClient();
                    
                    // Aguardar 8 segundos para o QR code ser gerado
                    let attempts = 0;
                    while (!currentQR && attempts < 8) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        console.log(`⏳ Aguardando QR Code... tentativa ${attempts}/8`);
                    }
                } else if (!currentQR) {
                    // Se já tem cliente mas não tem QR, aguardar mais um pouco
                    let attempts = 0;
                    while (!currentQR && attempts < 5) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                    }
                }
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                qr: currentQR || 'QR code não disponível',
                connected: isConnected,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/status') {
            // SEMPRE verificar status real
            await checkConnectionStatus();
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: isConnected,
                reconnectAttempts: reconnectAttempts,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/connect') {
            if (!client) {
                startClient();
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Cliente iniciado',
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/test') {
            // Verificar status real antes de responder
            await checkConnectionStatus();
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Serviço funcionando',
                connected: isConnected,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/send') {
            // Verificar status real antes de enviar
            await checkConnectionStatus();
            
            if (!isConnected) {
                res.writeHead(400);
                res.end(JSON.stringify({ 
                    success: false,
                    error: 'WhatsApp não está conectado'
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
                    
                    console.log(`📤 Enviando mensagem para ${to}: ${message}`);
                    
                    // Enviar mensagem
                    const result = await client.sendMessage(to, message);
                    
                    console.log(`✅ Mensagem enviada com sucesso para ${to}`);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        message: 'Mensagem enviada com sucesso',
                        to: to,
                        timestamp: new Date().toISOString()
                    }));
                } catch (error) {
                    console.error(`❌ Erro ao enviar mensagem: ${error.message}`);
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
                available: ['/health', '/qr', '/status', '/connect', '/test', '/send']
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
    
    // INICIAR CLIENTE AUTOMATICAMENTE QUANDO O SERVIDOR INICIA
    console.log('�� Iniciando WhatsApp client automaticamente...');
    startClient();
    
    // Verificar conexão a cada 30 segundos
    setInterval(async () => {
        await checkConnectionStatus();
    }, 30000);
});
