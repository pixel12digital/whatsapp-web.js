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

// Criar servidor HTTP simples
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            service: 'whatsapp-web.js'
        }));
    } else if (req.url === '/qr') {
        res.writeHead(200);
        res.end(JSON.stringify({ 
            message: 'QR code disponível nos logs',
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    
    // Iniciar WhatsApp client
    startWhatsAppClient();
});

// Função para iniciar WhatsApp client
async function startWhatsAppClient() {
    try {
        const client = new Client({
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
        });

        client.on('ready', () => {
            console.log('✅ Client is ready!');
            console.log('💬 WhatsApp conectado com sucesso!');
        });

        client.on('message', async (msg) => {
            if (msg.fromMe) return;
            console.log('📨 MESSAGE RECEIVED:', msg.body);
            console.log('   From:', msg.from);
            console.log('   To:', msg.to);
        });

        client.on('disconnected', (reason) => {
            console.log('Client was disconnected', reason);
        });

        client.on('auth_failure', (msg) => {
            console.error('Authentication failed:', msg);
        });

        await client.initialize();
        console.log('✅ WhatsApp client initialized successfully!');
    } catch (error) {
        console.error('Failed to initialize WhatsApp client:', error);
    }
}
