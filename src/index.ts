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
    GoogleAPIKey6?: string;  // 第六个 API Key（可选）
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
    if (env.GoogleAPIKey6) keys.push(env.GoogleAPIKey6);
    return keys;
}

// 获取下一个要使用的API Key索引（基于时间轮换，无需数据库表）
function getNextKeyIndex(totalKeys: number): number {
    // 使用当前时间戳进行轮换，每分钟切换一次
    const minutesSinceEpoch = Math.floor(Date.now() / (1000 * 60));
    return minutesSinceEpoch % totalKeys;
}

// 调用单个 Google API Key
async function callSingleGoogleAPI(prompt: string, apiKey: string, keyIndex: number, totalKeys: number): Promise<any> {
    console.log(`🔄 Calling Google API key ${keyIndex + 1}/${totalKeys}`);
    
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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

    if (!response.ok) {
        if (response.status === 429) {
            console.log(`❌ Google API key ${keyIndex + 1} quota exceeded (429)`);
        } else {
            console.log(`❌ Google API key ${keyIndex + 1} error: ${response.status} ${response.statusText}`);
        }
        throw new Error(`Google API key ${keyIndex + 1} failed: ${response.status}`);
    }

    console.log(`✅ Google API key ${keyIndex + 1} succeeded`);
    return await response.json();
}

// 调用 OpenAI API
async function callOpenAI(prompt: string, apiKey: string): Promise<any> {
    console.log('🔄 Using OpenAI API as backup...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
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
        console.log(`❌ OpenAI API error: ${response.status} ${response.statusText}`);
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
        console.log('❌ No API keys available');
        throw new Error('No API keys available');
    }
    
    console.log(`🔧 Available: ${apiKeys.length} Google API keys, OpenAI: ${env.OpenAIAPIKey ? 'Yes' : 'No'}`);
    
    // 如果有 Google API keys，优先使用它们
    if (apiKeys.length > 0) {
        // 获取本次要使用的key索引（基于时间轮换）
        const keyIndex = getNextKeyIndex(apiKeys.length);
        const currentKey = apiKeys[keyIndex];
        
        try {
            return await callSingleGoogleAPI(prompt, currentKey, keyIndex, apiKeys.length);
        } catch (error) {
            console.log(`🔄 Primary Google key failed, trying other keys...`);
            
            // 尝试其他 Google key 作为备用
            const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
            if (result) return result;
            
            console.log('⚠️ All Google API keys failed');
        }
    }
    
    // 如果没有 Google API keys 或所有 Google keys 都失败，使用 OpenAI
    if (env.OpenAIAPIKey) {
        console.log('🔄 Falling back to OpenAI API...');
        return await callOpenAI(prompt, env.OpenAIAPIKey);
    }
    
    console.log('❌ All API keys exhausted');
    throw new Error('All API keys failed');
}

// 当主要key失败时，尝试其他 Google key
async function tryOtherGoogleKeys(prompt: string, apiKeys: string[], excludeIndex: number): Promise<any> {
    console.log('🔄 Trying backup Google keys...');
    
    for (let i = 0; i < apiKeys.length; i++) {
        if (i === excludeIndex) continue; // 跳过已经失败的key
        
        try {
            return await callSingleGoogleAPI(prompt, apiKeys[i], i, apiKeys.length);
        } catch (error) {
            console.log(`⚠️ Backup key ${i + 1} also failed`);
            continue;
        }
    }
    
    console.log('❌ All backup Google keys failed');
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

            console.log(`🔧 Available Google API keys: ${availableGoogleKeys.length}, OpenAI: ${hasOpenAI ? 'Yes' : 'No'}`);

            // 检查重复邮件
            const existing = await env.DB.prepare(
                'SELECT 1 FROM raw_mails WHERE message_id = ?'
            ).bind(message_id).first();

            if (existing) {
                console.log(`⚠️ Duplicate message detected: ${message_id}`);
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

            // 改进的 AI 提示词
            const aiPrompt = `
Email content (raw headers + body): ${rawEmail}

FOLLOW THIS EXACT DECISION TREE. OUTPUT **JSON ONLY** (no markdown fences, no prose).
IF UNCERTAIN AT ANY STEP → RETURN {"codeExist": 0}.

============================================================
GOAL
============================================================
Classify the email. Only for true **login/sign-in** emails, extract:
- one **6-digit** login code (keep leading zeros; normalize formatting),
- the sender email address only,
- a short English topic string.
Otherwise return {"codeExist": 0}.

All matching is **case-insensitive**. Decode **quoted-printable** and **RFC 2047** encoded headers (e.g., "=?UTF-8?...?=") before matching.
“Near” means same sentence/paragraph or **within ±600 characters**.

============================================================
TYPES
============================================================
- Type A: LOGIN / SIGN-IN verification email
- Type B: PASSWORD RESET / ACCOUNT RECOVERY / UNLOCK email
- Type C: Other (ads/notifications/etc.)

============================================================
STEP 1 — SUBJECT HARD DENY (MANDATORY STOP)
============================================================
Extract the Subject. If it contains **ANY** of the following (EN or ZH),
**IMMEDIATELY return exactly** { "codeExist": 0 } **and STOP**.

EN: "password reset", "reset your password", "password reset code",
    "password change", "change your password",
    "password recovery", "recover your account",
    "reset verification code", "verification code for password reset"
ZH: "密码重置", "重置密码", "重设密码", "修改密码", "找回密码", "密码恢复", "密码重置验证码"

============================================================
STEP 2 — BODY RESET/RECOVERY/UNLOCK NEAR-CODE DENY (MANDATORY STOP)
============================================================
Scan the body text. If there are **strong reset/recovery/unlock instructions near a numeric code**,
**IMMEDIATELY return exactly** { "codeExist": 0 } **and STOP**.

EN examples: "use this code to reset your password",
             "to reset your password, enter this code",
             "password reset code", "password recovery code",
             "reset code for your account", "account recovery",
             "recover your account", "unlock your account"
ZH examples: "使用此验证码重置密码", "要重置密码请输入此验证码",
             "用于修改密码的验证码", "找回账户验证码", "账户恢复", "解锁账号"

Note: a generic line like "If you were not trying to log in, please reset your password"
**alone does NOT** trigger this step.

============================================================
STEP 3 — TYPE A (LOGIN) EVIDENCE (ONLY IF STEP 1 & 2 DID NOT MATCH)
============================================================
To classify as **Type A**, **ALL** must hold:

A) There is at least one **login-intent phrase** near the chosen code. Accept ANY of:
   EN: "log-in code", "login code", "sign-in code", "verify your sign-in", "verify it’s you",
       "use this code to sign in", "device sign-in", "new sign-in", "sign in to your account",
       "enter this code to continue", "suspicious log-in",
       "two-step verification", "2-step verification", "two-factor", "2FA",
       "one-time passcode", "one-time code"
   ZH: "登录验证码", "登录", "可疑登录", "验证以登录", "验证您的登录",
       "设备登录", "新登录", "输入此代码继续", "两步验证", "两步登录", "双重验证", "一次性验证码"

B) The code is **6 digits** (digits may appear with spaces/hyphens/dots before normalization).

C) The code is **NOT** inside any reset/recovery/unlock context (STEP 2).

D) IMPORTANT: the tokens **"verification code" / "temporary verification code" / "code" / "OTP" / "验证码" / "临时验证码"**
   are **NEUTRAL** and **NOT sufficient** by themselves; a **login-intent** phrase from (A) must be near the code.

If any item fails → **Type C**.

============================================================
WHAT TO RETURN AFTER CLASSIFICATION
============================================================
- If **Type B**: return exactly
{ "codeExist": 0 }

- If **Type C**: return exactly
{ "codeExist": 0 }

- Only if **Type A**: perform extraction below.

============================================================
EXTRACTION (ONLY IF TYPE A)
============================================================
1) Login verification code:
   - Extract **only** the code for **logging in / signing in**.
   - **Never** extract codes for password reset/change/recovery/unlock.
   - **Normalize**: remove spaces, hyphens, dots (e.g., "04 74 22" / "04-74-22" / "04.74.22" → "047422"). Keep leading zeros.
   - Candidates may appear in **Subject** or **Body**.
   - If multiple candidates: choose the **6-digit** code closest to a **login-intent** phrase (STEP 3A) and not in STEP 2 context.
   - If no valid login code exists → return { "codeExist": 0 }.

2) Sender email address ONLY (for "title"):
   - HEADER PRIORITY:
     a) FIRST use **Resent-From**. If "Name <email@example.com>", output ONLY "email@example.com".
        If it is a bare address, use that address.
     b) ONLY IF Resent-From is absent, use **From** with the same rule.
   - Output must be the email address only (no display name, no angle brackets).

3) Topic:
   - A short English phrase like "account login verification".

============================================================
OUTPUT — JSON ONLY (NO FENCES, NO EXTRA TEXT)
============================================================
Return **one** of the following and nothing else:

- For Type B or Type C, or when no valid login code is found:
{
  "codeExist": 0
}

- For Type A with a valid login code:
{
  "title": "sender@example.com",
  "code": "123456",
  "topic": "account login verification",
  "codeExist": 1
}

IMPORTANT: Never copy example placeholders ("sender@example.com", "123456"). Output only actual extracted values.
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
                            console.error("❌ Max retries reached. Unable to get valid AI response.");
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
                        console.log(`✅ Email processed successfully in ${processingTime}ms with ${availableGoogleKeys.length} Google + ${hasOpenAI ? '1' : '0'} OpenAI API keys available`);
                    } else {
                        console.log("ℹ️ No login verification code found in this email.");
                    }
                } else {
                    console.error("❌ Failed to extract data from AI response after retries.");
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
