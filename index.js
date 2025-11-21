
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// CONSTANTS - You can also put these in a .env file
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secure_custom_token_123';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'YOUR_ACCESS_TOKEN_HERE'; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'YOUR_PHONE_ID_HERE'; 
const VERSION = 'v17.0'; 

// 0. Health Check Route
app.get('/', (req, res) => {
    res.status(200).send('Bot is running!');
});

// 1. Webhook Verification (For Meta)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 2. Incoming Messages
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const changes = body.entry[0].changes[0];
            const value = changes.value;
            const message = value.messages[0];

            const from = message.from; 
            const msgBody = message.text ? message.text.body : '';
            
            console.log(`Received: ${msgBody} from ${from}`);

            if (msgBody) {
                // ECHO LOGIC: Respond with what they sent
                await sendMessage(from, `You said: ${msgBody}`);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Helper function to send messages
async function sendMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text }
            }
        });
    } catch (error) {
        console.error('Error sending:', error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
