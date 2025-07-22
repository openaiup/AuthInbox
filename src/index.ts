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
            model: 'gpt-4o',
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
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${currentKey}`,
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
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${backupKey}`,
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

            // 改进的 AI 提示词
            const aiPrompt = `
  Email content: ${rawEmail}.
  Please replace the raw email content in place of [Insert raw email content here]. Please read the email and extract the following information:

CRITICAL RULES FOR FILTERING:
- Check the email subject line. If it contains ANY of these patterns, IMMEDIATELY return {"codeExist": 0}:
  * "密码重置验证码" (password reset verification code)
  * Subject containing both "密码" and "重置"
  * "password reset" in subject
- Also check email body for these EXACT phrases and return {"codeExist": 0} if found:
  * "输入此临时验证码以继续" followed by "如果您未尝试重置密码"
  * "密码重置" in the body
- ONLY extract codes that are for LOGIN purposes, indicated by:
  * "Your ChatGPT code is" in subject (login code)
  * "suspicious log-in" or "log in" in body
  * "登录验证码" or similar login-related terms

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

If there is no code, clickable link, this is an advertisement email, OR if this is a password reset email, return:
{
  "codeExist": 0
}
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

                // 后处理过滤器 - 双重检查密码重置相关内容
                if (extractedData && extractedData.codeExist === 1) {
                    // 密码重置相关的关键词列表（中英文）
                    const passwordResetKeywords = [
                        'password reset', 'reset password', 'forgot password', 
                        'password recovery', 'recover password', 'change password',
                        'new password', 'reset your password', 'password assistance',
                        'password change', 'update password', 'modify password',
                        '密码重置', '重置密码', '忘记密码', '找回密码', '修改密码',
                        '更改密码', '密码找回', '密码恢复', '重设密码', '密码更新'
                    ];
                    
                    // 检查 topic, title 或 code 中是否包含密码重置相关的关键词
                    const topicLower = (extractedData.topic || '').toLowerCase();
                    const titleLower = (extractedData.title || '').toLowerCase();
                    const codeLower = (extractedData.code || '').toLowerCase();
                    
                    const isPasswordReset = passwordResetKeywords.some(keyword => 
                        topicLower.includes(keyword.toLowerCase()) || 
                        titleLower.includes(keyword.toLowerCase()) ||
                        codeLower.includes(keyword.toLowerCase())
                    );
                    
                    if (isPasswordReset) {
                        console.log("Password reset email detected in post-processing, filtering out");
                        console.log(`Topic: ${extractedData.topic}, Title: ${extractedData.title}`);
                        extractedData.codeExist = 0;
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
                        console.log("No login verification code found in this email (or password reset email filtered).");
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
