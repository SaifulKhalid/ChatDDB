/**
 * WhatsApp AI Bot (Gemini Pro + Utility Commands)
 * Features:
 * - /shuttle: Smart schedule (Weekday vs Weekend/Holiday)
 * - /holiday: Upcoming holidays
 * - General Text: Gemini Pro AI Response
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const moment = require('moment-timezone');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// --- CONFIGURATION ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VERSION = 'v17.0';
const TIMEZONE = 'Asia/Dhaka'; 

// --- DATASETS ---
const SHUTTLE_SCHEDULE = {
    "regular": {
        "townToCU": ["07:15", "07:40", "09:30*", "10:15*", "11:30*", "14:30", "15:30", "17:00", "20:30"],
        "cuToTown": ["08:40*", "09:05*", "10:30*", "13:00", "14:00", "15:35", "16:40", "18:20", "21:45"]
    },
    "weekend": {
        "townToCU": ["07:40", "15:30", "20:30"],
        "cuToTown": ["09:05*", "16:40", "21:45"]
    }
};

const HOLIDAYS = [
    { name: "আশুরা (১০ মহররম) *", date: "2025-07-06" },
    { name: "বর্ষাকালীন ছুটি", date: "2025-07-27 to 2025-07-31" },
    { name: "শুভ জন্মাষ্টমী", date: "2025-08-16" },
    { name: "একদিনের ছুটি", date: "2025-08-20" },
    { name: "আখেরী চাহার সোম্বা", date: "2025-09-05" },
    { name: "দুর্গাপূজাসহ শরৎকালীন ছুটি", date: "2025-09-28 to 2025-10-02" },
    { name: "ঈদ-ই-মিলাদুন্নবী (সা.) *", date: "2025-10-04" },
    { name: "শহিদ বুদ্ধিজীবী দিবস", date: "2025-12-14" },
    { name: "বিজয় দিবস", date: "2025-12-16" },
    { name: "শীতকালীন ছুটি এবং বড়দিন", date: "2025-12-21 to 2025-12-25" }
];

// --- ROUTES ---

app.get('/', (req, res) => res.send('AI Bot is Active 🤖'));

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const message = body.entry[0].changes[0].value.messages[0];
            
            if (message.type === 'text') {
                const from = message.from;
                const msgBody = message.text.body.trim();
                const lowerMsg = msgBody.toLowerCase();

                console.log(`Msg from ${from}: ${msgBody}`);

                try {
                    let reply = "";

                    if (lowerMsg.startsWith('/shuttle')) {
                        reply = getShuttleResponse();
                    } 
                    else if (lowerMsg.startsWith('/holiday')) {
                        reply = getHolidayResponse();
                    } 
                    else {
                        // AI Logic
                        reply = await getGeminiResponse(msgBody);
                    }

                    await sendMessage(from, reply);

                } catch (error) {
                    console.error("Error processing message:", error);
                }
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// --- LOGIC FUNCTIONS ---

function getShuttleResponse() {
    const now = moment().tz(TIMEZONE);
    const todayDate = now.format('YYYY-MM-DD');
    const dayOfWeek = now.day(); 
    
    const isHoliday = HOLIDAYS.some(h => {
        if (h.date.includes('to')) return false; 
        return h.date === todayDate;
    });

    const isWeekend = dayOfWeek === 5 || dayOfWeek === 6 || isHoliday;
    const scheduleType = isWeekend ? 'weekend' : 'regular';
    const schedule = SHUTTLE_SCHEDULE[scheduleType];

    let text = `🚌 *CU Shuttle Schedule (${isWeekend ? "Weekend/Holiday" : "Regular"})*\n`;
    text += `_Date: ${now.format('MMM Do, YYYY')}_\n\n`;
    text += `*Town ➔ CU:*\n${schedule.townToCU.join(', ')}\n\n`;
    text += `*CU ➔ Town:*\n${schedule.cuToTown.join(', ')}`;
    if(isWeekend) text += `\n\n_Note: It's a Weekend or Holiday schedule today._`;
    return text;
}

function getHolidayResponse() {
    const today = moment().tz(TIMEZONE);
    const upcoming = HOLIDAYS.filter(h => {
        let dateToCheck = h.date;
        if (h.date.includes('to')) {
            dateToCheck = h.date.split(' to ')[1]; 
        }
        return moment(dateToCheck).isSameOrAfter(today, 'day');
    }).slice(0, 5);

    if (upcoming.length === 0) return "No upcoming holidays found in the list.";

    let text = "🎉 *Upcoming University Holidays*\n\n";
    upcoming.forEach(h => {
        text += `▫️ *${h.name}*\n   📅 ${h.date}\n`;
    });
    return text;
}

// UPDATED FUNCTION: Using standard 'gemini-pro'
async function getGeminiResponse(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
        
        const payload = {
            contents: [{
                parts: [{ 
                    text: `You are a helpful university assistant bot. Keep answers concise and formatted for WhatsApp. Context: ${prompt}` 
                }]
            }]
        };

        const response = await axios.post(url, payload);
        
        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            return response.data.candidates[0].content.parts[0].text;
        } else {
            return "My AI brain is a bit fuzzy right now. Please try again.";
        }
    } catch (error) {
        console.error("Gemini API Error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return "I'm having trouble connecting to the AI service.";
    }
}

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
        console.error('WhatsApp Send Error:', error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
