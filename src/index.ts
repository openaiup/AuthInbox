/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2025 Jul 01   // 🔄 NEW：更新时间说明
*/

import indexHtml from './index.html';

export interface Env {
    DB: D1Database;
    barkTokens: string;
    barkUrl: string;
    GoogleAPIKey: string;   // 这里可以写多个 Key，用逗号或空格分隔
    UseBark: string;
}

/* ---------- 🔄 NEW：模块级轮询助手 ---------- */
let googleApiKeyIndex = 0;

/** 轮询返回下一个 Google API Key */
function getNextGoogleApiKey(env: Env): string {
    // 允许逗号、空格、换行分隔
    const keys = env.GoogleAPIKey
        .split(/[\s,]+/)
        .map(k => k.trim())
        .filter(Boolean);

    if (keys.length === 0) {
        throw new Error('No Google API Keys provided in env.GoogleAPIKey');
    }

    const key = keys[googleApiKeyIndex % keys.length];
    googleApiKeyIndex = (googleApiKeyIndex + 1) % keys.length;
    return key;
}
/* ---------- 🔄 NEW 结束 ---------- */

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            const { results } = await env.DB.prepare(
                'SELECT from_org, to_addr, topic, code, created_at FROM code_mails ORDER BY created_at DESC'
            ).all();

            let dataHtml = '';
            for (const row of results) {
                const codeLinkParts = row.code.split(',');
                let codeLinkContent;

                if (codeLinkParts.length > 1) {
                    const [code, link] = codeLinkParts;
                    codeLinkContent = `${code}<br><a href="${link}" target="_blank">${row.topic}</a>`;
                } else if (row.code.startsWith('http')) {
                    codeLinkContent = `<a href="${row.code}" target="_blank">${row.topic}</a>`;
                } else {
                    codeLinkContent = row.code;
                }

                dataHtml += `<tr>
                    <td>${row.from_org}</td>
                    <td>${row.topic}</td>
                    <td>${codeLinkContent}</td>
                    <td>${row.created_at}</td>
                </tr>`;
            }

            let responseHtml = indexHtml
                .replace('{{TABLE_HEADERS}}', `
                    <tr>
                        <th>📬账号</th>
                        <th>⚠️安全验证项</th>
                        <th>🔢登陆验证码（十分钟内有效）</th>
                        <th>🕐发送时间（美区）</th>
                    </tr>
                `)
                .replace('{{DATA}}', dataHtml);

            return new Response(responseHtml, {
                headers: {
                    'Content-Type': 'text/html',
                },
            });
        } catch (error) {
            console.error('Error querying database:', error);
            return new Response('Internal Server Error', { status: 500 });
        }
    },

    async email(message, env, ctx) {
        const useBark = env.UseBark.toLowerCase() === 'true';
        // 原来的单 Key 已不再需要，但保留这行亦无害
        // const GoogleAPIKey = env.GoogleAPIKey;

        const rawEmail = await new Response(message.raw).text();
        const message_id = message.headers.get("Message-ID");

        const {success} = await env.DB.prepare(
            `INSERT INTO raw_mails (from_addr, to_addr, raw, message_id) VALUES (?, ?, ?, ?)`
        ).bind(
            message.from, message.to, rawEmail, message_id
        ).run();

        if (!success) {
            message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
            console.log(`Failed to save message from ${message.from} to ${message.to}`);
        }

        const aiPrompt = `
  Email content: ${rawEmail}.

  Please replace the raw email content in place of [Insert raw email content here]. Please read the email and extract the following information:
1. Extract the code from the email (if available).
2. Extract ONLY the email address part:
   - FIRST try to find the Resent-From field in email headers. If found and it's in format "Name <email@example.com>", extract ONLY "email@example.com".
   - If NO Resent-From field exists, then use the From field and extract ONLY the email address part.
3. Provide a brief summary of the email's topic (e.g., "account verification").

Format the output as JSON with this structure:
{
  "title": "The extracted email address ONLY, without any name or angle brackets (e.g., 'sender@example.com')",
  "code": "Extracted verification code (e.g., '123456')",
  "topic": "A brief summary of the email's topic (e.g., 'account verification')",
  "codeExist": 1
}

If both a code and a link are present, only display the code in the 'code' field, like this:
"code": "code"

If there is no code, clickable link, or this is an advertisement email, return:
{
  "codeExist": 0
}
`;

        try {
            const maxRetries = 3;
            let retryCount = 0;
            let extractedData = null;

            while (retryCount < maxRetries && !extractedData) {
                /* ---------- 🔄 CHANGED：使用轮询 Key ---------- */
                const aiResponse = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${getNextGoogleApiKey(env)}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            "contents": [
                                {
                                    "parts": [
                                        {"text": aiPrompt}
                                    ]
                                }
                            ]
                        })
                    }
                );
                /* ---------- 🔄 CHANGED 结束 ---------- */

                const aiData = await aiResponse.json();
                console.log(`AI response attempt ${retryCount + 1}:`, aiData);

                if (
                    aiData &&
                    aiData.candidates &&
                    aiData.candidates[0] &&
                    aiData.candidates[0].content &&
                    aiData.candidates[0].content.parts &&
                    aiData.candidates[0].content.parts[0]
                ) {
                    let extractedText = aiData.candidates[0].content.parts[0].text;
                    console.log(`Extracted Text before parsing: "${extractedText}"`);

                    const jsonMatch = extractedText.match(/```json\\s*([\\s\\S]*?)\\s*```/);
                    if (jsonMatch && jsonMatch[1]) {
                        extractedText = jsonMatch[1].trim();
                        console.log(`Extracted JSON Text: "${extractedText}"`);
                    } else {
                        extractedText = extractedText.trim();
                        console.log(`Assuming entire text is JSON: "${extractedText}"`);
                    }

                    try {
                        extractedData = JSON.parse(extractedText);
                        console.log(`Parsed Extracted Data:`, extractedData);
                    } catch (parseError) {
                        console.error("JSON parsing error:", parseError);
                        console.log(`Problematic JSON Text: "${extractedText}"`);
                    }

                } else {
                    console.error("AI response is missing expected data structure");
                }

                if (!extractedData) {
                    retryCount++;
                    if (retryCount < maxRetries) {
                        console.log("Retrying AI request...");
                    } else {
                        console.error("Max retries reached. Unable to get valid AI response.");
                    }
                }
            }

            if (extractedData) {
                if (extractedData.codeExist === 1) {
                    const title = extractedData.title || "Unknown Organization";
                    const code = extractedData.code || "No Code Found";
                    const topic = extractedData.topic || "No Topic Found";

                    const { success: codeMailSuccess } = await env.DB.prepare(
                        `INSERT INTO code_mails (from_addr, from_org, to_addr, code, topic, message_id) VALUES (?, ?, ?, ?, ?, ?)`
                    ).bind(
                        message.from, title, message.to, code, topic, message_id
                    ).run();

                    if (!codeMailSuccess) {
                        message.setReject(`Failed to save extracted code for message from ${message.from} to ${message.to}`);
                        console.log(`Failed to save extracted code for message from ${message.from} to ${message.to}`);
                    }

                    if (useBark) {
                        const barkUrl = env.barkUrl;
                        const barkTokens = env.barkTokens
                            .replace(/^$$|$$$/g, '')
                            .split(',')
                            .map(token => token.trim());

                        const barkUrlEncodedTitle = encodeURIComponent(title);
                        const barkUrlEncodedCode = encodeURIComponent(code);

                        for (const token of barkTokens) {
                            const barkRequestUrl = `${barkUrl}/${token}/${barkUrlEncodedTitle}/${barkUrlEncodedCode}`;

                            const barkResponse = await fetch(barkRequestUrl, {
                                method: "GET"
                            });

                            if (barkResponse.ok) {
                                console.log(`Successfully sent notification to Bark for token ${token} for message from ${message.from} to ${message.to}`);
                                const responseData = await barkResponse.json();
                                console.log("Bark response:", responseData);
                            } else {
                                console.error(`Failed to send notification to Bark for token ${token}: ${barkResponse.status} ${barkResponse.statusText}`);
                            }
                        }
                    }
                } else {
                    console.log("No code found in this email, skipping Bark notification.");
                }
            } else {
                console.error("Failed to extract data from AI response after retries.");
            }
        } catch (e) {
            console.error("Error calling AI or saving to database:", e);
        }
    }
} satisfies ExportedHandler<Env>;
