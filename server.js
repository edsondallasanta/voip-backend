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
        let serviceAccount;
        
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
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
            serviceAccount = require('./voip-9e7ad-firebase-adminsdk-fbsvc-00d732e16d.json');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin inicializado!');
        console.log(`   Projeto: ${serviceAccount.project_id}`);
    }
} catch (e) {
    console.log('❌ Erro ao inicializar Firebase:', e.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// ============ FIRESTORE (PERSISTÊNCIA) ============
const db = firebaseInitialized ? admin.firestore() : null;
const USERS_COLLECTION = 'voip_users';

// Fallback em memória (caso Firestore não esteja disponível)
const usersMemory = {};

// ============ FUNÇÕES AUXILIARES ============

async function saveUser(userId, fcmToken) {
    const userData = {
        fcmToken,
        lastSeen: new Date().toISOString()
    };
    
    if (db) {
        try {
            await db.collection(USERS_COLLECTION).doc(userId).set(userData);
            console.log(`💾 Usuário ${userId} salvo no Firestore`);
            return true;
        } catch (e) {
            console.log('❌ Erro ao salvar no Firestore:', e.message);
            usersMemory[userId] = userData;
            return false;
        }
    } else {
        usersMemory[userId] = userData;
        return false;
    }
}

async function getUser(userId) {
    if (db) {
        try {
            const doc = await db.collection(USERS_COLLECTION).doc(userId).get();
            if (doc.exists) {
                return doc.data();
            }
            return null;
        } catch (e) {
            console.log('❌ Erro ao buscar no Firestore:', e.message);
            return usersMemory[userId] || null;
        }
    } else {
        return usersMemory[userId] || null;
    }
}

async function listUsers() {
    if (db) {
        try {
            const snapshot = await db.collection(USERS_COLLECTION).get();
            const users = [];
            snapshot.forEach(doc => {
                users.push({
                    id: doc.id,
                    fcmToken: doc.data().fcmToken ? doc.data().fcmToken.substring(0, 20) + '...' : null,
                    lastSeen: doc.data().lastSeen
                });
            });
            return users;
        } catch (e) {
            console.log('❌ Erro ao listar do Firestore:', e.message);
            return Object.keys(usersMemory).map(id => ({
                id: id,
                fcmToken: usersMemory[id].fcmToken ? usersMemory[id].fcmToken.substring(0, 20) + '...' : null,
                lastSeen: usersMemory[id].lastSeen
            }));
        }
    } else {
        return Object.keys(usersMemory).map(id => ({
            id: id,
            fcmToken: usersMemory[id].fcmToken ? usersMemory[id].fcmToken.substring(0, 20) + '...' : null,
            lastSeen: usersMemory[id].lastSeen
        }));
    }
}

async function deleteUser(userId) {
    if (db) {
        try {
            await db.collection(USERS_COLLECTION).doc(userId).delete();
            return true;
        } catch (e) {
            console.log('❌ Erro ao deletar no Firestore:', e.message);
        }
    }
    delete usersMemory[userId];
    return true;
}

// ============ ENDPOINTS ============

// 1. Status do servidor
app.get('/status', async (req, res) => {
    let userCount = 0;
    if (db) {
        try {
            const snapshot = await db.collection(USERS_COLLECTION).get();
            userCount = snapshot.size;
        } catch (e) {
            userCount = Object.keys(usersMemory).length;
        }
    } else {
        userCount = Object.keys(usersMemory).length;
    }

    res.json({
        status: 'online',
        firebase: {
            initialized: firebaseInitialized,
            hasAdmin: !!admin,
            sdkVersion: admin ? admin.SDK_VERSION : null,
        },
        firestore: {
            enabled: !!db,
        },
        users: userCount,
        timestamp: new Date().toISOString()
    });
});

// 2. Registrar token FCM
app.post('/register-token', async (req, res) => {
    const { userId, fcmToken } = req.body;
    
    if (!userId || !fcmToken) {
        return res.status(400).json({ 
            error: 'userId e fcmToken são obrigatórios' 
        });
    }
    
    await saveUser(userId, fcmToken);
    
    console.log(`✅ Usuário ${userId} registrado com token: ${fcmToken.substring(0, 20)}...`);
    res.json({ success: true, userId });
});

// 3. Buscar token de um usuário
app.get('/users/:userId/token', async (req, res) => {
    const { userId } = req.params;
    const user = await getUser(userId);
    
    if (user) {
        res.json({ fcmToken: user.fcmToken });
    } else {
        res.status(404).json({ error: 'Usuário não encontrado' });
    }
});

// 4. Listar todos os usuários
app.get('/users', async (req, res) => {
    const users = await listUsers();
    res.json({
        total: users.length,
        users: users
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
app.delete('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    await deleteUser(userId);
    console.log(`🗑️  Usuário ${userId} removido`);
    res.json({ success: true });
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
    console.log(`   💾 Firestore: ${db ? '✅ ATIVO (persistente)' : '⚠️  MEMÓRIA (volátil)'}`);
    console.log(`   📦 Versão Admin: ${admin ? admin.SDK_VERSION : 'N/A'}`);
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