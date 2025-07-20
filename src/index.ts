/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Oct 07
*/

import indexHtml from './index.html';

export interface Env {
    DB: D1Database;
    barkTokens: string;
    barkUrl: string;
    GoogleAPIKey: string;
    UseBark: string;
}

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
        const GoogleAPIKey = env.GoogleAPIKey;

        const rawEmail = await new Response(message.raw).text();
        const message_id = message.headers.get("Message-ID");

        // 检查重复邮件
        const existing = await env.DB.prepare(
            'SELECT 1 FROM raw_mails WHERE message_id = ?'
        ).bind(message_id).first();

        if (existing) {
            console.log(`Duplicate message detected: ${message_id}`);
            return;
        }

        const {success} = await env.DB.prepare(
            `INSERT INTO raw_mails (from_addr, to_addr, raw, message_id) VALUES (?, ?, ?, ?)`
        ).bind(
            message.from, message.to, rawEmail, message_id
        ).run();

        if (!success) {
            message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
            console.log(`Failed to save message from ${message.from} to ${message.to}`);
        }

        // 改进的 AI 提示词
        const aiPrompt = `
Analyze the raw email below and extract login verification information.

**IMPORTANT**: Process ONLY the email headers and body. Do NOT be confused by forwarded content or quoted replies.

Raw email:
${rawEmail}

**Step 1 – Extract sender email address**
- Search email HEADERS (not body) for these fields IN ORDER:
  1) "Resent-From:" header
  2) "From:" header
- Extract ONLY the email address part (e.g., from "John Doe <john@example.com>" extract "john@example.com")
- IGNORE any "From:" that appears in the email body or quoted text

**Step 2 – Extract login verification code**
- Look for LOGIN/SIGN-IN verification codes ONLY
- Common patterns: 4-8 digits, alphanumeric codes
- Keywords to look for: "verification code", "login code", "sign in code", "authentication code"
- EXCLUDE: password reset codes, registration codes, confirmation codes
- If both code and link exist, return only the code

**Step 3 – Summarize the topic**
- Use a brief descriptive phrase (max 5 words)
- Examples: "account login verification", "two-factor authentication", "security code verification"

**Output Requirements**:
Return ONLY valid JSON without any additional text or formatting:

For emails WITH login verification code:
{
  "title": "sender@example.com",
  "code": "123456",
  "topic": "account login verification",
  "codeExist": 1
}

For emails WITHOUT login verification code (including ads, newsletters, password resets):
{
  "codeExist": 0
}
`;

        try {
            const maxRetries = 3;
            let retryCount = 0;
            let extractedData = null;

            while (retryCount < maxRetries && !extractedData) {
                const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GoogleAPIKey}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        "contents": [
                            {
                                "parts": [
                                    {"text": aiPrompt}
                                ]
                            }
                        ]
                    })
                });

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

                    const jsonMatch = extractedText.match(/```json\s*([\s\S]*?)\s*```/);
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
                        
                        // 基本验证
                        if (extractedData.codeExist === 1) {
                            if (!extractedData.title || !extractedData.code || !extractedData.topic) {
                                console.error("Missing required fields in AI response");
                                extractedData = null;
                            }
                        }
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
                        // 简单的延迟重试
                        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
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
                            .map(token => token.trim())
                            .filter(token => token); // 过滤空token

                        const barkUrlEncodedTitle = encodeURIComponent(title);
                        const barkUrlEncodedCode = encodeURIComponent(code);

                        // 改为并行发送
                        const barkPromises = barkTokens.map(async (token) => {
                            try {
                                const barkRequestUrl = `${barkUrl}/${token}/${barkUrlEncodedTitle}/${barkUrlEncodedCode}`;
                                const barkResponse = await fetch(barkRequestUrl, {
                                    method: "GET"
                                });

                                if (barkResponse.ok) {
                                    console.log(`Successfully sent notification to Bark for token ${token}`);
                                } else {
                                    console.error(`Failed to send notification to Bark for token ${token}: ${barkResponse.status}`);
                                }
                                return barkResponse;
                            } catch (error) {
                                console.error(`Bark notification error for token ${token}:`, error);
                                return null;
                            }
                        });

                        await Promise.allSettled(barkPromises);
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
