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

// Função para iniciar cliente
async function startClient() {
    if (client || isConnected) return;
    
    console.log('🚀 Iniciando WhatsApp client...');
    
    try {
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
                timeout: 30000,
                protocolTimeout: 30000
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
        });

        client.on('disconnected', () => {
            console.log('❌ WhatsApp desconectado');
            isConnected = false;
            currentQR = null;
        });

        await client.initialize();
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error.message);
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
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                status: 'OK',
                connected: isConnected,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/qr') {
            // SEMPRE tentar gerar QR Code se não estiver conectado
            if (!isConnected) {
                if (!client) {
                    console.log('🔄 Iniciando cliente para gerar QR Code...');
                    startClient();
                    
                    // Aguardar 5 segundos para o QR code ser gerado
                    let attempts = 0;
                    while (!currentQR && attempts < 5) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        console.log(`⏳ Aguardando QR Code... tentativa ${attempts}/5`);
                    }
                } else if (!currentQR) {
                    // Se já tem cliente mas não tem QR, aguardar mais um pouco
                    let attempts = 0;
                    while (!currentQR && attempts < 3) {
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
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: isConnected,
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
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Serviço funcionando',
                connected: isConnected,
                timestamp: new Date().toISOString()
            }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ 
                success: false,
                error: 'Endpoint não encontrado',
                available: ['/health', '/qr', '/status', '/connect', '/test']
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
    console.log('🔄 Iniciando WhatsApp client automaticamente...');
    startClient();
});
