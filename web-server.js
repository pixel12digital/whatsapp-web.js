const http = require('http');

// Tentar diferentes formas de importar o Client
let Client;
try {
    // Tentar importar do módulo principal
    const whatsappWeb = require('./src/Client.js');
    Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
} catch (e) {
    try {
        // Tentar importar do dist
        const whatsappWeb = require('./dist/index.js');
        Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
    } catch (e2) {
        try {
            // Tentar importar do módulo raiz
            const whatsappWeb = require('./');
            Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
        } catch (e3) {
            console.error('❌ Não foi possível carregar o módulo whatsapp-web.js');
            console.error('Erro 1:', e.message);
            console.error('Erro 2:', e2.message);
            console.error('Erro 3:', e3.message);
            process.exit(1);
        }
    }
}

// Verificar se Client foi carregado corretamente
if (typeof Client !== 'function') {
    console.error('❌ Client não é uma função construtora');
    console.error('Client type:', typeof Client);
    process.exit(1);
}

console.log('✅ Client carregado com sucesso!');

const PORT = process.env.PORT || 3000;

// Variáveis globais para gerenciar o estado
let currentQR = null;
let client = null;
let isConnected = false;
let isInitializing = false;

// Função para processar requisições POST
function parsePostData(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                resolve(data);
            } catch (e) {
                resolve({});
            }
        });
    });
}

// Função para extrair path da URL
function getPathFromUrl(url) {
    const questionMarkIndex = url.indexOf('?');
    if (questionMarkIndex !== -1) {
        return url.substring(0, questionMarkIndex);
    }
    return url;
}

// Função para iniciar WhatsApp client
async function startWhatsAppClient() {
    if (isInitializing) {
        console.log('⚠️ Cliente já está sendo inicializado...');
        return;
    }
    
    if (client && isConnected) {
        console.log('✅ Cliente já está conectado!');
        return;
    }
    
    isInitializing = true;
    console.log('🚀 Iniciando WhatsApp client...');
    
    try {
        // Se já temos um cliente, destruir primeiro
        if (client) {
            try {
                await client.destroy();
            } catch (e) {
                console.log('Cliente anterior já destruído');
            }
        }
        
        client = new Client({
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    '--disable-default-apps',
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
                timeout: 120000,
                protocolTimeout: 120000,
                executablePath: process.env.CHROME_BIN || undefined
            }
        });

        client.on('qr', (qr) => {
            console.log('QR RECEIVED:', qr);
            console.log('📱 Escaneie este QR code com seu WhatsApp:');
            console.log('==========================================');
            console.log(qr);
            console.log('==========================================');
            
            // Salvar QR code para acesso via API
            currentQR = qr;
            isInitializing = false;
        });

        client.on('ready', () => {
            console.log('✅ Client is ready!');
            console.log('💬 WhatsApp conectado com sucesso!');
            isConnected = true;
            currentQR = null; // Limpar QR code quando conectado
            isInitializing = false;
        });

        client.on('message', async (msg) => {
            if (msg.fromMe) return;
            console.log('📨 MESSAGE RECEIVED:', msg.body);
            console.log('   From:', msg.from);
            console.log('   To:', msg.to);
        });

        client.on('disconnected', (reason) => {
            console.log('Client was disconnected', reason);
            isConnected = false;
            currentQR = null;
            isInitializing = false;
        });

        client.on('auth_failure', (msg) => {
            console.error('Authentication failed:', msg);
            isConnected = false;
            currentQR = null;
            isInitializing = false;
        });

        await client.initialize();
        console.log('✅ WhatsApp client initialized successfully!');
    } catch (error) {
        console.error('Failed to initialize WhatsApp client:', error);
        isConnected = false;
        isInitializing = false;
    }
}

// Criar servidor HTTP simples
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const path = getPathFromUrl(req.url);
    console.log(`📡 Requisição: ${req.method} ${path}`);
    
    try {
        if (path === '/' || path === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                status: 'OK', 
                timestamp: new Date().toISOString(),
                service: 'whatsapp-web.js',
                connected: isConnected,
                initializing: isInitializing
            }));
        } else if (path === '/qr') {
            // Se não há QR code e não está conectado, iniciar cliente
            if (!currentQR && !isConnected && !isInitializing) {
                console.log('🔄 Iniciando cliente para gerar QR Code...');
                startWhatsAppClient();
                
                // Aguardar um pouco para o QR code ser gerado
                let attempts = 0;
                while (!currentQR && attempts < 10) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attempts++;
                }
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                qr: currentQR || 'QR code não disponível',
                timestamp: new Date().toISOString(),
                connected: isConnected,
                initializing: isInitializing
            }));
        } else if (path === '/status') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                connected: isConnected,
                initializing: isInitializing,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/connect') {
            if (req.method === 'POST') {
                const data = await parsePostData(req);
                console.log('🔗 Tentando conectar canal:', data);
                
                // Iniciar cliente se não estiver rodando
                if (!client && !isInitializing) {
                    startWhatsAppClient();
                }
                
                res.writeHead(200);
                res.end(JSON.stringify({ 
                    success: true,
                    message: 'Canal conectado com sucesso',
                    timestamp: new Date().toISOString()
                }));
            } else {
                res.writeHead(405);
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        } else if (path === '/test') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
                success: true,
                message: 'Conexão WhatsApp OK',
                connected: isConnected,
                initializing: isInitializing,
                timestamp: new Date().toISOString()
            }));
        } else if (path === '/send') {
            if (req.method === 'POST') {
                const data = await parsePostData(req);
                console.log('📤 Tentando enviar mensagem:', data);
                
                if (!client || !isConnected) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ 
                        success: false,
                        error: 'WhatsApp não está conectado'
                    }));
                    return;
                }
                
                try {
                    await client.sendMessage(data.to, data.message);
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        message: 'Mensagem enviada com sucesso'
                    }));
                } catch (error) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ 
                        success: false,
                        error: error.message
                    }));
                }
            } else {
                res.writeHead(405);
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ 
                success: false,
                error: 'Endpoint não encontrado',
                available_endpoints: ['/health', '/qr', '/status', '/connect', '/test', '/send']
            }));
        }
    } catch (error) {
        console.error('Erro no servidor:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            success: false,
            error: error.message
        }));
    }
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    console.log('📱 QR Code será gerado quando solicitado via /qr');
});
