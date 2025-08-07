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
let client = null;
let isConnected = false;
let currentQR = null;

// Função para iniciar cliente
async function startClient() {
    if (client) return;
    
    console.log('�� Iniciando WhatsApp client...');
    
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
                timeout: 60000,
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
        });

        client.on('authenticated', () => {
            console.log('🔐 WhatsApp autenticado!');
            isConnected = true;
            currentQR = null;
        });

        client.on('disconnected', (reason) => {
            console.log('❌ WhatsApp desconectado:', reason);
            isConnected = false;
            currentQR = null;
        });

        client.on('auth_failure', (msg) => {
            console.log('❌ Falha na autenticação:', msg);
            isConnected = false;
            currentQR = null;
        });

        await client.initialize();
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error.message);
        isConnected = false;
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
                port: PORT,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/qr') {
            // Se não está conectado e não tem cliente, iniciar
            if (!isConnected && !client) {
                console.log('🔄 Iniciando cliente para gerar QR Code...');
                startClient();
                
                // Aguardar QR Code
                let attempts = 0;
                while (!currentQR && attempts < 10) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attempts++;
                    console.log(`⏳ Aguardando QR Code... tentativa ${attempts}/10`);
                }
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                qr: currentQR || 'QR code não disponível',
                connected: isConnected,
                port: PORT,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/status') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: isConnected,
                port: PORT,
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
                port: PORT,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/test') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Serviço funcionando',
                connected: isConnected,
                port: PORT,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/send') {
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
                        port: PORT,
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
            
            return;
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
    
    // INICIAR CLIENTE AUTOMATICAMENTE
    console.log('�� Iniciando WhatsApp client automaticamente...');
    startClient();
});
