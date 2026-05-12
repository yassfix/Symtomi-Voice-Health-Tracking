const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();
const db = admin.firestore();

// 2ND GEN SYNTAX: We pass the secrets directly into the onRequest options
exports.telegramWebhook = onRequest(
    { secrets: ["TELEGRAM_TOKEN", "GEMINI_API_KEY"] }, 
    async (req, res) => {
        
    // Acknowledge receipt to Telegram immediately
    res.sendStatus(200);

    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id.toString();

    // Pull the secure keys from the environment variables
    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

    // Initialize Gemini securely
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    // ==========================================
    // 1. HANDLE ACCOUNT LINKING (/start CODE)
    // ==========================================
    if (message.text && message.text.startsWith('/start ')) {
        const code = message.text.split(' ')[1];
        
        const codeDoc = await db.collection('telegram_codes').doc(code).get();
        if (!codeDoc.exists) {
            return sendMessage(TELEGRAM_API, chatId, "Invalid or expired pairing code.");
        }

        const userId = codeDoc.data().userId;
        
        await db.collection('users').doc(userId).set({ telegramChatId: chatId }, { merge: true });
        await db.collection('telegram_codes').doc(code).delete();

        return sendMessage(TELEGRAM_API, chatId, "✅ Account successfully linked! You can now send voice notes to log entries.");
    }

    // ==========================================
    // 2. VERIFY USER IS LINKED
    // ==========================================
    const usersQuery = await db.collection('users').where('telegramChatId', '==', chatId).get();
    if (usersQuery.empty) {
        return sendMessage(TELEGRAM_API, chatId, "⚠️ Your account isn't linked. Go to the web app Background tab to generate a code.");
    }
    const userDocRef = usersQuery.docs[0].ref;

    // ==========================================
    // 3. HANDLE AUDIO WITH GEMINI
    // ==========================================
    try {
        let aiResponseText;
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const systemPrompt = `
            You are a health tracking assistant. The user will provide a text or voice transcription. 
            Convert it into a JSON object matching this schema perfectly:
            {
              "cat": "symptoms" | "food" | "gut" | "vitals" | "mental" | "sleep" | "activity" | "measures" | "meds" | "environment",
              "catLabel": "Symptoms" | "Food" | "Gut / Poop" | "Vitals" | "Mental" | "Sleep" | "Activity" | "Measures" | "Meds / Supps" | "Environment",
              "content": "A beautiful, concise string summarizing the log, separated by ' | '."
            }
            Example Input: "I just ate potato and chicken and my stomach started hurting right after, pain level 6."
            Example Output: {"cat": "symptoms", "catLabel": "Symptoms", "content": "Symptoms: Stomach hurting | Strength: 6/10 | Notes: Occurred right after eating potato and chicken"}
        `;

        if (message.voice) {
            // Download the .ogg file from Telegram
            const fileId = message.voice.file_id;
            const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
            const filePath = fileRes.data.result.file_path;
            const audioRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: 'arraybuffer' });
            
            const base64Audio = Buffer.from(audioRes.data).toString("base64");

            // Send Audio directly to Gemini
            const result = await model.generateContent([
                systemPrompt,
                { inlineData: { data: base64Audio, mimeType: "audio/ogg" } }
            ]);
            aiResponseText = result.response.text();
        } else if (message.text) {
            const result = await model.generateContent([systemPrompt, "User input: " + message.text]);
            aiResponseText = result.response.text();
        } else {
            return sendMessage(TELEGRAM_API, chatId, "Please send text or a voice note.");
        }

        // ==========================================
        // 4. PARSE AI JSON AND SAVE TO FIRESTORE
        // ==========================================
        const logData = JSON.parse(aiResponseText);
        const now = new Date();
        const newLog = {
            id: Date.now(),
            time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            date: now.toLocaleDateString(),
            cat: logData.cat,
            catLabel: logData.catLabel,
            content: logData.content
        };

        // Append to the user's logs array
        await userDocRef.update({
            logs: admin.firestore.FieldValue.arrayUnion(newLog)
        });

        return sendMessage(TELEGRAM_API, chatId, `✅ Logged:\n${newLog.catLabel}\n${newLog.content}`);

    } catch (error) {
        console.error("Error processing message:", error);
        return sendMessage(TELEGRAM_API, chatId, "❌ Sorry, I had trouble processing that. Please try again.");
    }
});

// Helper function to send Telegram messages
async function sendMessage(apiBase, chatId, text) {
    await axios.post(`${apiBase}/sendMessage`, { chat_id: chatId, text: text });
}