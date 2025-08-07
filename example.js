const express = require('express');

// Tentar diferentes formas de importar o Client
let Client;
try {
    const whatsappWeb = require('./src/Client.js');
    Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
} catch (e) {
    try {
        const whatsappWeb = require('./dist/index.js');
        Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
    } catch (e2) {
        try {
            const whatsappWeb = require('./');
            Client = whatsappWeb.Client || whatsappWeb.default?.Client || whatsappWeb;
        } catch (e3) {
            console.error('❌ Não foi possível carregar o módulo whatsapp-web.js');
            process.exit(1);
        }
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rota principal
app.get('/', (req, res) => {
    res.json({ 
        status: 'WhatsApp Web.js Bot Running',
        timestamp: new Date().toISOString(),
        service: 'whatsapp-web.js'
    });
});

// Rota de saúde
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
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
