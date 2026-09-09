const express = require('express');
const cors = require('cors');

// ============ CARREGA FIREBASE ADMIN ============
let admin;
let firebaseInitialized = false;

try {
    admin = require('firebase-admin');
    console.log('✅ firebase-admin versão:', admin.SDK_VERSION);
} catch (e) {
    console.log('❌ Erro ao carregar firebase-admin:', e.message);
}

// ============ INICIALIZAÇÃO DO FIREBASE ============
try {
    if (admin) {
        // 🔥 Tenta carregar as credenciais de variáveis de ambiente (Render)
        // ou do arquivo local (desenvolvimento)
        let serviceAccount;
        
        // Verifica se estamos no Render (variáveis de ambiente)
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
            console.log('🔑 Usando credenciais do ambiente (Render)...');
            serviceAccount = {
                project_id: process.env.FIREBASE_PROJECT_ID,
                private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
                client_id: process.env.FIREBASE_CLIENT_ID,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
                universe_domain: "googleapis.com"
            };
        } else {
            // Tenta carregar do arquivo local (desenvolvimento)
            try {
                console.log('📁 Tentando carregar arquivo de credenciais local...');
                serviceAccount = require('./voip-9e7ad-firebase-adminsdk-fbsvc-00d732e16d.json');
                console.log('✅ Arquivo de credenciais local carregado!');
            } catch (fileError) {
                console.log('⚠️ Arquivo de credenciais local não encontrado.');
                throw new Error('Credenciais não encontradas');
            }
        }

        if (admin.credential && typeof admin.credential.cert === 'function') {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            firebaseInitialized = true;
            console.log('✅ Firebase Admin inicializado com sucesso!');
            console.log(`   Projeto: ${serviceAccount.project_id}`);
        }
    }
} catch (e) {
    console.log('❌ Erro ao inicializar Firebase:', e.message);
    console.log('⚠️  O servidor rodará em modo simulação');
}

const app = express();
app.use(cors());
app.use(express.json());

// ============ BANCO DE DADOS EM MEMÓRIA ============
const users = {};

// ============ ENDPOINTS ============

// 1. Status do servidor
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        firebase: {
            initialized: firebaseInitialized,
            hasAdmin: !!admin,
            sdkVersion: admin ? admin.SDK_VERSION : null,
        },
        users: Object.keys(users).length,
        timestamp: new Date().toISOString()
    });
});

// 2. Registrar token FCM
app.post('/register-token', (req, res) => {
    const { userId, fcmToken } = req.body;
    
    if (!userId || !fcmToken) {
        return res.status(400).json({ 
            error: 'userId e fcmToken são obrigatórios' 
        });
    }
    
    users[userId] = { 
        fcmToken, 
        lastSeen: new Date() 
    };
    
    console.log(`✅ Usuário ${userId} registrado com token: ${fcmToken.substring(0, 20)}...`);
    res.json({ success: true, userId });
});

// 3. Buscar token de um usuário
app.get('/users/:userId/token', (req, res) => {
    const { userId } = req.params;
    const user = users[userId];
    
    if (user) {
        res.json({ fcmToken: user.fcmToken });
    } else {
        res.status(404).json({ error: 'Usuário não encontrado' });
    }
});

// 4. Listar todos os usuários
app.get('/users', (req, res) => {
    const userList = Object.keys(users).map(id => ({
        id: id,
        fcmToken: users[id].fcmToken ? users[id].fcmToken.substring(0, 20) + '...' : null,
        lastSeen: users[id].lastSeen
    }));
    res.json({
        total: userList.length,
        users: userList
    });
});

// 5. Enviar notificação de chamada
app.post('/call/start', async (req, res) => {
    const { fromUserId, toUserId, channelId, callerName, fcmToken } = req.body;

    console.log(`📞 Chamada de ${fromUserId || 'unknown'} para ${toUserId || 'unknown'} na sala ${channelId}`);

    if (!fcmToken) {
        return res.status(400).json({ 
            error: 'Token FCM do destinatário não fornecido'
        });
    }

    if (!channelId) {
        return res.status(400).json({ 
            error: 'channelId é obrigatório' 
        });
    }

    if (!firebaseInitialized || !admin) {
        console.log(`🔄 [SIMULAÇÃO] Chamada para ${toUserId}`);
        return res.json({ 
            success: true, 
            simulated: true,
            message: '[SIMULAÇÃO] Chamada iniciada'
        });
    }

    try {
        const message = {
            token: fcmToken,
            data: {
                type: 'voip_call',
                channelId: channelId,
                fromUserId: fromUserId || 'unknown',
                callerName: callerName || fromUserId || 'Usuário',
                roomId: channelId,
            },
            android: {
                priority: 'high',
                direct_boot_ok: true,
                notification: {
                    title: `📞 Chamada de ${callerName || fromUserId || 'Usuário'}`,
                    body: 'Toque recebido',
                    sound: 'default',
                    priority: 'max',
                    channel_id: 'voip_calls',
                },
            },
            apns: {
                headers: {
                    'apns-priority': '10',
                },
                payload: {
                    aps: {
                        alert: {
                            title: `Chamada de ${callerName || fromUserId || 'Usuário'}`,
                            body: 'Toque recebido',
                        },
                        sound: 'default',
                        badge: 1,
                    },
                },
            },
        };

        console.log('📤 Enviando notificação FCM...');
        const response = await admin.messaging().send(message);
        console.log(`✅ Notificação enviada! ID: ${response}`);
        
        return res.json({ 
            success: true, 
            messageId: response,
            message: `Chamada iniciada para ${toUserId}` 
        });

    } catch (error) {
        console.error('❌ Erro detalhado:', error);
        res.status(500).json({ 
            error: 'Erro ao enviar notificação',
            details: error.message || error.toString()
        });
    }
});

// 6. Testar FCM
app.post('/test-fcm', async (req, res) => {
    const { token, title, body } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Token é obrigatório' });
    }

    if (!firebaseInitialized || !admin) {
        return res.json({ 
            success: true, 
            simulated: true,
            message: 'Notificação simulada' 
        });
    }

    try {
        const message = {
            token: token,
            notification: {
                title: title || 'Teste FCM',
                body: body || 'Notificação de teste',
            },
            data: {
                type: 'test',
            },
        };

        const response = await admin.messaging().send(message);
        console.log(`📤 Teste FCM enviado: ${response}`);
        res.json({ success: true, messageId: response });

    } catch (error) {
        console.error('❌ Erro no teste FCM:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 7. Remover usuário
app.delete('/users/:userId', (req, res) => {
    const { userId } = req.params;
    if (users[userId]) {
        delete users[userId];
        console.log(`🗑️  Usuário ${userId} removido`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Usuário não encontrado' });
    }
});

// ============ INICIAR SERVIDOR ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🚀 ==========================================');
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log('🚀 ==========================================');
    console.log('');
    console.log(`   🔥 Firebase: ${firebaseInitialized ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    console.log(`   📦 Versão Admin: ${admin ? admin.SDK_VERSION : 'N/A'}`);
    console.log(`   👥 Usuários cadastrados: ${Object.keys(users).length}`);
    console.log('');
    console.log('📋 ENDPOINTS:');
    console.log(`   GET  /status                    - Status`);
    console.log(`   POST /register-token            - Registrar token`);
    console.log(`   GET  /users                     - Listar usuários`);
    console.log(`   GET  /users/:userId/token       - Buscar token`);
    console.log(`   POST /call/start                - Iniciar chamada`);
    console.log(`   POST /test-fcm                  - Testar FCM`);
    console.log('');
});