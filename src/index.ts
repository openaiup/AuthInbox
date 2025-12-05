/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Dec (Core version)
Enhanced: 2025 Jan (API Rotation + OpenAI Backup)
Updated: 2025 (Password Reset 3x Detection - Database Version v2)
*/

import indexHtml from './index.html';

export interface Env {
    DB: D1Database;
    barkTokens: string;
    barkUrl: string;
    GoogleAPIKey: string;
    GoogleAPIKey2?: string;
    GoogleAPIKey3?: string;
    GoogleAPIKey4?: string;
    GoogleAPIKey5?: string;
    GoogleAPIKey6?: string;
    OpenAIAPIKey?: string;
    UseBark: string;
}

// ========== 数据库版本：密码重置历史记录 ==========

// 检查是否连续收到相同的密码重置验证码
async function checkPasswordResetRepeat(db: D1Database, email: string, code: string): Promise<boolean> {
    try {
        const existing = await db.prepare(
            'SELECT code, count FROM password_reset_history WHERE email = ?'
        ).bind(email).first();

        if (!existing) {
            await db.prepare(
                'INSERT INTO password_reset_history (email, code, count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)'
            ).bind(email, code).run();
            console.log(`🔒 Password reset for ${email}: new record, count: 1/3`);
            return false;
        }

        if (existing.code === code) {
            const newCount = (existing.count as number) + 1;
            await db.prepare(
                'UPDATE password_reset_history SET count = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?'
            ).bind(newCount, email).run();
            console.log(`🔒 Password reset for ${email}: same code, count: ${newCount}/3`);
            return newCount >= 3;
        } else {
            await db.prepare(
                'UPDATE password_reset_history SET code = ?, count = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?'
            ).bind(code, email).run();
            console.log(`🔒 Password reset for ${email}: different code, reset count: 1/3`);
            return false;
        }
    } catch (error) {
        console.error('Error checking password reset history:', error);
        return false;
    }
}

// 清除密码重置历史记录
async function clearPasswordResetHistory(db: D1Database, email?: string): Promise<void> {
    try {
        if (email) {
            await db.prepare('DELETE FROM password_reset_history WHERE email = ?').bind(email).run();
            console.log(`🗑️ Cleared password reset history for ${email}`);
        } else {
            await db.prepare('DELETE FROM password_reset_history').run();
            console.log('🗑️ Cleared all password reset history');
        }
    } catch (error) {
        console.error('Error clearing password reset history:', error);
    }
}

// 处理AI返回结果
async function processAIResponse(db: D1Database, result: any): Promise<any> {
    console.log(`🔍 Processing AI result, type: ${result.type}, code: ${result.code}, title: ${result.title}`);
    
    // 如果是密码重置类型，检查是否连续3次
    if (result.type === "PASSWORD_RESET") {
        if (!result.code || !result.title) {
            console.log(`⚠️ PASSWORD_RESET but missing code or title, skipping...`);
            return { codeExist: 0 };
        }
        
        const shouldExtract = await checkPasswordResetRepeat(db, result.title, result.code);
        
        if (shouldExtract) {
            console.log(`🔓 Password reset code repeated 3 times for ${result.title}, extracting!`);
            await clearPasswordResetHistory(db, result.title);
            return {
                title: result.title,
                code: result.code,
                topic: "Password reset verification (repeated 3 times)",
                codeExist: 1
            };
        } else {
            return { codeExist: 0 };
        }
    }
    
    // 登录类型，直接返回
    if (result.type === "LOGIN" && result.codeExist === 1) {
        return result;
    }
    
    // 其他情况直接返回原结果
    return result;
}

// ========== 数据库版本结束 ==========

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

// 获取下一个要使用的API Key索引
function getNextKeyIndex(totalKeys: number): number {
    const minutesSinceEpoch = Math.floor(Date.now() / (1000 * 60));
    return minutesSinceEpoch % totalKeys;
}

// 调用单个 Google API Key
async function callSingleGoogleAPI(prompt: string, apiKey: string, keyIndex: number, totalKeys: number): Promise<any> {
    console.log(`🔄 Calling Google API key ${keyIndex + 1}/${totalKeys}`);
    
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-thinking-exp-01-21:generateContent?key=${apiKey}`,
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

// 轮流调用 AI API
async function callAIWithRoundRobin(prompt: string, env: Env): Promise<any> {
    const apiKeys = getAvailableAPIKeys(env);
    
    if (apiKeys.length === 0 && !env.OpenAIAPIKey) {
        console.log('❌ No API keys available');
        throw new Error('No API keys available');
    }
    
    console.log(`🔧 Available: ${apiKeys.length} Google API keys, OpenAI: ${env.OpenAIAPIKey ? 'Yes' : 'No'}`);
    
    if (apiKeys.length > 0) {
        const keyIndex = getNextKeyIndex(apiKeys.length);
        const currentKey = apiKeys[keyIndex];
        
        try {
            return await callSingleGoogleAPI(prompt, currentKey, keyIndex, apiKeys.length);
        } catch (error) {
            console.log(`🔄 Primary Google key failed, trying other keys...`);
            
            const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
            if (result) return result;
            
            console.log('⚠️ All Google API keys failed');
        }
    }
    
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
        if (i === excludeIndex) continue;
        
        try {
            return await callSingleGoogleAPI(prompt, apiKeys[i], i, apiKeys.length);
        } catch (error) {
            console.log(`⚠️ Backup key ${i + 1} also failed`);
            continue;
        }
    }
    
    console.log('❌ All backup Google keys failed');
    return null;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            // 自动清理过期验证码
            const cleanupResult = await env.DB.prepare(
                `DELETE FROM code_mails WHERE datetime(created_at) < datetime('now', '-10 minutes')`
            ).run();
            
            if (cleanupResult.meta.changes > 0) {
                console.log(`Auto cleaned ${cleanupResult.meta.changes} expired codes`);
            }

            // 清理过期的密码重置历史（超过30分钟）
            await env.DB.prepare(
                `DELETE FROM password_reset_history WHERE datetime(updated_at) < datetime('now', '-30 minutes')`
            ).run();
            
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

            const existing = await env.DB.prepare(
                'SELECT 1 FROM raw_mails WHERE message_id = ?'
            ).bind(message_id).first();

            if (existing) {
                console.log(`⚠️ Duplicate message detected: ${message_id}`);
                return;
            }

            const rawEmail = await new Response(message.raw).text();

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

            const aiPrompt = `
  Email content: ${rawEmail}.
  
  **STEP 1 - EMAIL TYPE CHECK (MUST DO FIRST):**
  
  Determine the email type by checking these rules IN ORDER:
  
  **CHECK A - Is this a LOGIN email?**
  If body contains ANY of these LOGIN indicators, this is a LOGIN email (Type: LOGIN):
  - "如果你无意登录" | "如果你未尝试登录" | "If you were not trying to log in"
  - "Log-in Code" | "login code" | "sign-in code" | "suspicious log-in"
  - "登录验证码" | "可疑登录" | "两步验证" | "2FA"
  - Subject contains: "你的 [Service] 代码为" (WITHOUT "密码") | "Your [Service] code is" | "Log-in Code"
  
  **CHECK B - Is this a PASSWORD RESET email?**
  If NOT a LOGIN email, and ANY of these matches, this is PASSWORD RESET (Type: PASSWORD_RESET):
  - Subject contains: "password reset" | "reset your password" | "password change" | "password recovery" | "密码重置" | "重置密码" | "修改密码" | "找回密码" | "密码重置验证码"
  - Body contains: "如果你未尝试重置密码" | "if you did not try to reset your password"
  
  **CHECK C - Otherwise:**
  If neither LOGIN nor PASSWORD_RESET, this is OTHER (Type: OTHER).
  
  **STEP 2 - EXTRACTION (REQUIRED FOR LOGIN AND PASSWORD_RESET TYPES):**
  
  For BOTH LOGIN and PASSWORD_RESET types, you MUST extract these fields:
  
  1. **code**: The 6-digit verification code from the email body or subject
     - Remove spaces, hyphens, dots (e.g., "99 11 17" → "991117")
     - Keep leading zeros
  
  2. **title**: The FORWARDER's email address (NOT the original sender):
     - Look for **Resent-From** header in the raw email headers
     - Example: if you see "Resent-From: john@gmail.com" or "Resent-From: John <john@gmail.com>", extract "john@gmail.com"
     - Do NOT use From header addresses like "noreply@openai.com" or "otp@tm1.openai.com"
     - Extract ONLY the email address part without name or angle brackets
  
  **OUTPUT (JSON only, no markdown fences, no extra text):**
  
  If Type is PASSWORD_RESET (MUST include code and title):
  {
    "codeExist": 0,
    "type": "PASSWORD_RESET",
    "code": "991117",
    "title": "forwarder@example.com"
  }
  
  If Type is LOGIN (MUST include all fields):
  {
    "codeExist": 1,
    "type": "LOGIN",
    "code": "123456",
    "title": "forwarder@example.com",
    "topic": "account login verification"
  }
  
  If Type is OTHER or no code found:
  {
    "codeExist": 0
  }
  
  **CRITICAL REMINDER**: 
  - For PASSWORD_RESET emails, you MUST extract and return both "code" and "title" fields
  - Look carefully in the email headers section for "Resent-From" to find the forwarder's address
  - The code is usually a 6-digit number displayed prominently in the email body
`;

            try {
                const maxRetries = 3;
                let retryCount = 0;
                let extractedData = null;

                while (retryCount < maxRetries && !extractedData) {
                    try {
                        const aiData = await callAIWithRoundRobin(aiPrompt, env);
                        console.log(`AI response attempt ${retryCount + 1}:`, JSON.stringify(aiData));

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
                                console.log(`Parsed Extracted Data:`, JSON.stringify(extractedData));
                                
                                // 使用数据库版本的 processAIResponse
                                extractedData = await processAIResponse(env.DB, extractedData);
                                console.log(`Processed Data (after 3x check):`, JSON.stringify(extractedData));
                                
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
                                    extractedData = await processAIResponse(env.DB, extractedData);
                                    console.log(`OpenAI Parsed Data:`, JSON.stringify(extractedData));
                                    break;
                                }
                            } catch (openaiError) {
                                console.error('OpenAI fallback failed:', openaiError);
                            }
                        }
                        
                        if (retryCount < maxRetries - 1) {
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

                        if (useBark) {
                            const barkUrl = env.barkUrl;
                            const barkTokens = env.barkTokens
                                .replace(/^\$\$|\$\$$/g, '')
                                .split(',')
                                .map(token => token.trim())
                                .filter(token => token);

                            const barkUrlEncodedTitle = encodeURIComponent(title);
                            const barkUrlEncodedCode = encodeURIComponent(code);

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

                        const processingTime = Date.now() - startTime;
                        console.log(`✅ Email processed successfully in ${processingTime}ms`);
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
