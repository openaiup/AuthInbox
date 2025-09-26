/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Dec (Core version)
Enhanced: 2025 Jan (API Rotation + OpenAI Backup)
*/

import indexHtml from './index.html';

export interface Env {
    DB: D1Database;
    barkTokens: string;
    barkUrl: string;
    GoogleAPIKey: string;
    GoogleAPIKey2?: string;  // 第二个 API Key（可选）
    GoogleAPIKey3?: string;  // 第三个 API Key（可选）
    GoogleAPIKey4?: string;  // 第四个 API Key（可选）
    GoogleAPIKey5?: string;  // 第五个 API Key（可选）
    OpenAIAPIKey?: string;   // OpenAI API Key（可选，作为备份）
    UseBark: string;
}

// HTML 转义函数
function escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// 计算剩余时间
function getTimeRemaining(createdAt: string): string {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    const remaining = 10 - diffMinutes;
    
    if (remaining <= 0) return '<span style="color: #999;">已过期</span>';
    if (remaining <= 2) return `<span style="color: red; font-weight: bold;">剩余 ${remaining} 分钟</span>`;
    return `<span style="color: green;">剩余 ${remaining} 分钟</span>`;
}

// 获取可用的 Google API Keys
function getAvailableAPIKeys(env: Env): string[] {
    const keys = [];
    if (env.GoogleAPIKey) keys.push(env.GoogleAPIKey);
    if (env.GoogleAPIKey2) keys.push(env.GoogleAPIKey2);
    if (env.GoogleAPIKey3) keys.push(env.GoogleAPIKey3);
    if (env.GoogleAPIKey4) keys.push(env.GoogleAPIKey4);
    if (env.GoogleAPIKey5) keys.push(env.GoogleAPIKey5);
    return keys;
}

// 获取下一个要使用的API Key索引（基于时间轮换，无需数据库表）
function getNextKeyIndex(totalKeys: number): number {
    // 使用当前时间戳进行轮换，每分钟切换一次
    const minutesSinceEpoch = Math.floor(Date.now() / (1000 * 60));
    return minutesSinceEpoch % totalKeys;
}

// 调用 OpenAI API
async function callOpenAI(prompt: string, apiKey: string): Promise<any> {
    console.log('🔄 Trying OpenAI API as backup...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini', // ← 已改：由 gpt-3.5-turbo 换为 gpt-4o-mini
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.1,
            max_tokens: 1000
        })
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ OpenAI API succeeded');
    
    // 转换 OpenAI 响应格式以匹配现有的处理逻辑
    return {
        candidates: [{
            content: {
                parts: [{
                    text: data.choices[0].message.content
                }]
            }
        }]
    };
}

// 轮流调用 AI API（每次都轮换，不是失败才切换）
async function callAIWithRoundRobin(prompt: string, env: Env): Promise<any> {
    const apiKeys = getAvailableAPIKeys(env);
    
    if (apiKeys.length === 0 && !env.OpenAIAPIKey) {
        throw new Error('No API keys available');
    }
    
    // 如果有 Google API keys，优先使用它们
    if (apiKeys.length > 0) {
        // 获取本次要使用的key索引（基于时间）
        const keyIndex = getNextKeyIndex(apiKeys.length);
        const currentKey = apiKeys[keyIndex];
        
        console.log(`Using Google API key ${keyIndex + 1}/${apiKeys.length} (round-robin)`);
        
        try {
            const aiResponse = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        "contents": [
                            {
                                "parts": [
                                    {"text": prompt}
                                ]
                            }
                        ]
                    })
                }
            );

            if (aiResponse.ok) {
                console.log(`✅ Google API key ${keyIndex + 1} succeeded`);
                return await aiResponse.json();
            } else if (aiResponse.status === 429) {
                console.log(`❌ Google API key ${keyIndex + 1} quota exceeded (429), trying other keys`);
                // 如果当前key配额用完，尝试其他key
                const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
                if (result) return result;
                // 如果所有 Google keys 都失败，尝试 OpenAI
                throw new Error('All Google API keys failed');
            } else {
                throw new Error(`Google API error: ${aiResponse.status} ${aiResponse.statusText}`);
            }
        } catch (error) {
            console.error(`Google API key ${keyIndex + 1} failed:`, error);
            // 尝试其他 Google key 作为备用
            try {
                const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
                if (result) return result;
            } catch (googleError) {
                console.log('All Google API keys failed, trying OpenAI...');
            }
            // 如果所有 Google keys 都失败，尝试 OpenAI
            throw new Error('All Google API keys failed');
        }
    }
    
    // 如果没有 Google API keys 或所有 Google keys 都失败，使用 OpenAI
    if (env.OpenAIAPIKey) {
        return await callOpenAI(prompt, env.OpenAIAPIKey);
    }
    
    throw new Error('All API keys failed');
}

// 当主要key失败时，尝试其他 Google key
async function tryOtherGoogleKeys(prompt: string, apiKeys: string[], excludeIndex: number): Promise<any> {
    console.log('Trying backup Google keys...');
    
    for (let i = 0; i < apiKeys.length; i++) {
        if (i === excludeIndex) continue; // 跳过已经失败的key
        
        const backupKey = apiKeys[i];
        console.log(`Trying backup Google API key ${i + 1}/${apiKeys.length}`);
        
        try {
            const aiResponse = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${backupKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        "contents": [
                            {
                                "parts": [
                                    {"text": prompt}
                                ]
                            }
                        ]
                    })
                }
            );

            if (aiResponse.ok) {
                console.log(`✅ Backup Google API key ${i + 1} succeeded`);
                return await aiResponse.json();
            } else if (aiResponse.status === 429) {
                console.log(`❌ Backup Google API key ${i + 1} also quota exceeded`);
                continue;
            } else {
                console.log(`❌ Backup Google API key ${i + 1} error: ${aiResponse.status}`);
                continue;
            }
        } catch (error) {
            console.error(`Backup Google API key ${i + 1} failed:`, error);
            continue;
        }
    }
    
    return null; // 所有 Google keys 都失败
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            // 自动清理过期验证码（超过10分钟的）
            const cleanupResult = await env.DB.prepare(
                `DELETE FROM code_mails WHERE datetime(created_at) < datetime('now', '-10 minutes')`
            ).run();
            
            if (cleanupResult.meta.changes > 0) {
                console.log(`Auto cleaned ${cleanupResult.meta.changes} expired codes`);
            }
            
            // 获取所有验证码数据
            const { results } = await env.DB.prepare(
                'SELECT from_org, to_addr, topic, code, created_at FROM code_mails ORDER BY created_at DESC'
            ).all();

            let dataHtml = '';
            for (const row of results) {
                const codeLinkParts = row.code.split(',');
                let codeLinkContent;

                if (codeLinkParts.length > 1) {
                    const [code, link] = codeLinkParts;
                    codeLinkContent = `${escapeHtml(code)}<br><a href="${escapeHtml(link)}" target="_blank">${escapeHtml(row.topic)}</a>`;
                } else if (row.code.startsWith('http')) {
                    codeLinkContent = `<a href="${escapeHtml(row.code)}" target="_blank">${escapeHtml(row.topic)}</a>`;
                } else {
                    codeLinkContent = escapeHtml(row.code);
                }

                dataHtml += `<tr>
                    <td>${escapeHtml(row.from_org)}</td>
                    <td>${escapeHtml(row.topic)}</td>
                    <td>${codeLinkContent}</td>
                    <td>
                        ${escapeHtml(row.created_at)}<br>
                        <small>${getTimeRemaining(row.created_at)}</small>
                    </td>
                </tr>`;
            }
            
            // 如果没有数据，显示提示
            if (results.length === 0) {
                dataHtml = `<tr><td colspan="4" style="text-align: center; padding: 40px; color: #6c757d;">
                    暂无验证码数据
                </td></tr>`;
            }

            let responseHtml = indexHtml
                .replace('{{TABLE_HEADERS}}', `
                    <tr>
                        <th>📬 账号</th>
                        <th>⚠️ 安全验证项</th>
                        <th>🔢 登录验证码</th>
                        <th>🕐 发送时间（美区）</th>
                    </tr>
                `)
                .replace('{{DATA}}', dataHtml);

            return new Response(responseHtml, {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                },
            });
        } catch (error) {
            console.error('Error querying database:', error);
            return new Response('Internal Server Error', { status: 500 });
        }
    },

    async email(message, env, ctx) {
        const startTime = Date.now();
        const message_id = message.headers.get("Message-ID");
        
        try {
            const useBark = env.UseBark.toLowerCase() === 'true';
            const availableGoogleKeys = getAvailableAPIKeys(env);
            const hasOpenAI = !!env.OpenAIAPIKey;
            
            if (availableGoogleKeys.length === 0 && !hasOpenAI) {
                console.error('No API keys available');
                return;
            }

            console.log(`Available Google API keys: ${availableGoogleKeys.length}, OpenAI: ${hasOpenAI ? 'Yes' : 'No'}`);

            // 检查重复邮件
            const existing = await env.DB.prepare(
                'SELECT 1 FROM raw_mails WHERE message_id = ?'
            ).bind(message_id).first();

            if (existing) {
                console.log(`Duplicate message detected: ${message_id}`);
                return;
            }

            const rawEmail = await new Response(message.raw).text();

            // 保存原始邮件
            const {success} = await env.DB.prepare(
                `INSERT INTO raw_mails (from_addr, to_addr, raw, message_id) VALUES (?, ?, ?, ?)`
            ).bind(
                message.from, message.to, rawEmail, message_id
            ).run();

            if (!success) {
                message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
                console.log(`Failed to save message from ${message.from} to ${message.to}`);
                return;
            }

            // 改进的 AI 提示词（适配 2.5 Flash）
            const aiPrompt = `
Email content (raw): ${rawEmail}

########################
# CRITICAL FIRST STEP - EMAIL TYPE CLASSIFICATION
########################
Goal: Classify the email as exactly one of:
- Type A: LOGIN/SIGN-IN verification email
- Type B: PASSWORD RESET email
- Type C: Other (advertisement, notification, etc.)

Normalization (for classification ONLY):
- Case-insensitive.
- Decode quoted-printable fragments if present (e.g., "=E5=AF=86=E7=A0=81=E9=87=8D=E7=BD=AE" → "password reset"/"密码重置").
- Trim excess whitespace and line breaks. Ignore HTML tags when matching text.

Classification criteria (do NOT extract yet):

TYPE B (PASSWORD RESET) — classify as B only if there is a **clear password-reset workflow**, for example:
- Subject explicitly contains: "password reset" | "密码重置" | "=E5=AF=86=E7=A0=81=E9=87=8D=E7=BD=AE", OR
- Body contains strong reset instructions such as:
  "password reset code", "use this code to reset your password",
  "to reset your password, enter this code", "reset code for your account".
Notes:
- Generic disclaimers like "If you were not trying to log in, please reset your password" **do NOT** imply Type B by themselves.
- Any numeric code that appears within a reset workflow (as defined above) must be treated as password-reset and **must not** be extracted.

TYPE A (LOGIN) — ALL must be true:
- No **strong** Type B indicators as defined above.
- Evidence the code is for account access/sign-in even if the word “login” is absent. Treat ANY of the following as login intent:
  English: "verification code", "security code", "one-time code", "one time passcode", "OTP",
           "two-step verification", "2-step verification", "two-factor", "2FA",
           "verify your sign-in", "verify it’s you", "use this code to sign in",
           "device sign-in", "new sign-in", "sign in to your account", "enter this code to continue",
           "log-in code", "login code", "sign-in code".
  Chinese: "验证码", "一次性验证码", "登录验证码", "安全码", "动态验证码",
           "两步验证", "两步登录", "双重验证", "验证以登录", "验证您的登录",
           "设备登录", "新登录", "输入此代码继续".
- The email contains a numeric verification code of **4–8 digits** (the code may be formatted with spaces/hyphens/dots; see extraction rules).

Conflict rule:
- If BOTH login intent and a **generic** reset disclaimer are present (e.g., “If you were not trying to log in, please reset your password”), **prefer Type A**.
- Only when an **explicit reset workflow** is present (e.g., “use this code to reset your password”) classify as Type B.

TYPE C — If neither Type A nor Type B.

Immediate actions after classification (STRICT):
- If Type B: return exactly {"codeExist": 0}
- If Type C: return exactly {"codeExist": 0}
- If Type A: proceed to extraction below.

########################
# EXTRACTION (ONLY IF TYPE A)
########################

1) Login verification code:
- Extract ONLY the code used for LOGGING IN / SIGNING IN.
- **Never** extract any code used for password reset, password change, account recovery, unlock requests, or 2FA for password resets
  ("reset your password", "change password", "password assistance", "recover account", "unlock", "安全验证（修改密码）", etc.).
- **Normalization**: remove spaces, hyphens, and dots from numeric strings before validation
  (e.g., "123 456", "123-456", "12.34.56" → "123456").
- Candidate sources:
  a) **Subject line**: if the subject contains a 4–8 digit numeric string, treat it as a candidate.
  b) **Body**: 4–8 digit numeric strings near login-intent phrases.
- Selection rule (if multiple candidates):
  a) Prefer the candidate **closest** (same sentence/paragraph or within ±600 characters) to any login-intent phrase listed above
     OR to generic markers "code"/"验证码"/"OTP".
  b) Prefer a body candidate over the subject **only** if it is clearly closer to login-intent phrases; otherwise the subject code is acceptable.
  c) Discard any candidate that appears within an explicit password-reset workflow context (defined in TYPE B).
- Output the **normalized** digits only. If no valid login code is found → return {"codeExist": 0}.

2) Sender email address ONLY (for the "title" field):
- HEADER PRIORITY RULE (STRICT):
  a) FIRST search for "Resent-From". If formatted like "Name <email@example.com>", extract ONLY the address in angle brackets.
     If it's a bare address, extract that address.
  b) ONLY IF "Resent-From" does NOT exist, use the "From" header with the same rule.
- NEVER output both. NEVER use "From" when "Resent-From" exists.
- Output must be the email address only (no display name, no angle brackets).

3) Brief topic:
- A short English phrase, e.g., "account login verification".

When both a login code and a link are present:
- Put ONLY the normalized 4–8 digit login code in "code". Do NOT output the link.

########################
# OUTPUT FORMAT (STRICT)
########################
- Output MUST be valid JSON only. No markdown, no extra text, no comments.
- No extra fields. No trailing commas.

- If Type B or Type C, or no valid login code:
{
  "codeExist": 0
}

- If Type A and a valid login code is found:
{
  "title": "sender@example.com",          // ONLY the extracted email address
  "code": "123456",                       // ONLY the normalized 4–8 digit login code (this is an example value)
  "topic": "account login verification",  // brief topic
  "codeExist": 1
}

If the email does not meet Type A criteria or a valid 4–8 digit login code cannot be determined with high confidence, return {"codeExist": 0}.

########################
# REMINDERS
########################
- Strictly follow the HEADER PRIORITY RULE (Resent-From > From).
- Do not hallucinate or infer missing fields.
- **Never** output any password-reset code.
- If uncertain, prefer {"codeExist": 0}.
`;
            try {
                const maxRetries = 3;
                let retryCount = 0;
                let extractedData = null;

                while (retryCount < maxRetries && !extractedData) {
                    try {
                        // 使用轮流调用 AI API（包括 OpenAI 备份）
                        const aiData = await callAIWithRoundRobin(aiPrompt, env);
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
                            } else {
                                extractedText = extractedText.trim();
                            }

                            try {
                                extractedData = JSON.parse(extractedText);
                                console.log(`Parsed Extracted Data:`, extractedData);
                                
                                // 验证数据
                                if (extractedData.codeExist === 1) {
                                    if (!extractedData.title || !extractedData.code || !extractedData.topic) {
                                        console.error("Missing required fields in AI response");
                                        extractedData = null;
                                        throw new Error("Invalid data structure");
                                    }
                                }
                            } catch (parseError) {
                                console.error("JSON parsing error:", parseError);
                                throw parseError;
                            }
                        } else {
                            throw new Error("AI response is missing expected data structure");
                        }
                    } catch (error) {
                        console.error(`Attempt ${retryCount + 1} failed:`, error);
                        
                        // 如果是 Google API 失败，尝试 OpenAI
                        if (retryCount === 0 && env.OpenAIAPIKey) {
                            try {
                                console.log('🔄 Trying OpenAI as fallback...');
                                const aiData = await callOpenAI(aiPrompt, env.OpenAIAPIKey);
                                
                                if (
                                    aiData &&
                                    aiData.candidates &&
                                    aiData.candidates[0] &&
                                    aiData.candidates[0].content &&
                                    aiData.candidates[0].content.parts &&
                                    aiData.candidates[0].content.parts[0]
                                ) {
                                    let extractedText = aiData.candidates[0].content.parts[0].text;
                                    
                                    const jsonMatch = extractedText.match(/```json\s*([\s\S]*?)\s*```/);
                                    if (jsonMatch && jsonMatch[1]) {
                                        extractedText = jsonMatch[1].trim();
                                    } else {
                                        extractedText = extractedText.trim();
                                    }

                                    extractedData = JSON.parse(extractedText);
                                    console.log(`OpenAI Parsed Data:`, extractedData);
                                    break; // 成功，退出重试循环
                                }
                            } catch (openaiError) {
                                console.error('OpenAI fallback failed:', openaiError);
                            }
                        }
                        
                        if (retryCount < maxRetries - 1) {
                            // 简单延迟重试
                            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                        }
                    }

                    if (!extractedData) {
                        retryCount++;
                        if (retryCount >= maxRetries) {
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
                            console.error(`Failed to save extracted code for message from ${message.from} to ${message.to}`);
                        }

                        // 发送 Bark 通知
                        if (useBark) {
                            const barkUrl = env.barkUrl;
                            const barkTokens = env.barkTokens
                                .replace(/^\$\$|\$\$$/g, '')
                                .split(',')
                                .map(token => token.trim())
                                .filter(token => token);

                            const barkUrlEncodedTitle = encodeURIComponent(title);
                            const barkUrlEncodedCode = encodeURIComponent(code);

                            // 并行发送所有 Bark 通知
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

                        // 记录处理时间
                        const processingTime = Date.now() - startTime;
                        console.log(`Email processed successfully in ${processingTime}ms with ${availableGoogleKeys.length} Google API keys + ${hasOpenAI ? '1' : '0'} OpenAI key available`);
                    } else {
                        console.log("No login verification code found in this email.");
                    }
                } else {
                    console.error("Failed to extract data from AI response after retries.");
                }
            } catch (e) {
                console.error("Error calling AI or saving to database:", e);
            }
        } catch (error) {
            console.error(`Failed to process email from ${message.from} to ${message.to}:`, {
                error: error.message,
                messageId: message_id
            });
        }
    }
} satisfies ExportedHandler<Env>;
