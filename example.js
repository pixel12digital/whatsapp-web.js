const { Client } = require('./src/Client.js');

// Configuração personalizada para Render.com
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
            '--disable-javascript',
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
    console.log('QR RECEIVED:', qr);
    console.log('📱 Escaneie este QR code com seu WhatsApp:');
    console.log('==========================================');
    console.log(qr);
    console.log('==========================================');
});

client.on('ready', () => {
    console.log('✅ Client is ready!');
    console.log('�� WhatsApp conectado com sucesso!');
});

client.on('message', async (msg) => {
    if (msg.fromMe) return;
    console.log('📨 MESSAGE RECEIVED:', msg.body);
    console.log('   From:', msg.from);
    console.log('   To:', msg.to);
});

client.initialize();
