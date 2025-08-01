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

// 计算剩余时间百分比
function getTimePercentage(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    const remaining = 10 - diffMinutes;
    return Math.max(0, Math.min(100, (remaining / 10) * 100));
}

// 获取时间状态类名
function getTimeColorClass(createdAt: string): string {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    const remaining = 10 - diffMinutes;
    
    if (remaining <= 0) return 'expired';
    if (remaining <= 2) return 'danger';
    if (remaining <= 5) return 'warning';
    return 'good';
}

// 计算剩余时间
function getTimeRemaining(createdAt: string): string {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    const remaining = 10 - diffMinutes;
    
    if (remaining <= 0) return '<span style="color: #999;">已过期</span>';
    if (remaining <= 2) return `<span style="color: red; font-weight: bold;">剩余 ${remaining} 分钟</span>`;
    if (remaining <= 5) return `<span style="color: orange;">剩余 ${remaining} 分钟</span>`;
    return `<span style="color: green;">剩余 ${remaining} 分钟</span>`;
}

// 检查是否是新验证码（2分钟内）
function isNewCode(createdAt: string): boolean {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    return diffMinutes < 2;
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

// 调用 OpenAI API
async function callOpenAI(prompt: string, apiKey: string): Promise<any> {
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
        throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    
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
                return await aiResponse.json();
            } else if (aiResponse.status === 429) {
                // 如果当前key配额用完，尝试其他key
                const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
                if (result) return result;
                // 如果所有 Google keys 都失败，尝试 OpenAI
                throw new Error('All Google API keys failed');
            } else {
                throw new Error(`Google API error: ${aiResponse.status}`);
            }
        } catch (error) {
            // 尝试其他 Google key 作为备用
            try {
                const result = await tryOtherGoogleKeys(prompt, apiKeys, keyIndex);
                if (result) return result;
            } catch (googleError) {
                // 继续尝试 OpenAI
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
    for (let i = 0; i < apiKeys.length; i++) {
        if (i === excludeIndex) continue; // 跳过已经失败的key
        
        const backupKey = apiKeys[i];
        
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
                return await aiResponse.json();
            } else if (aiResponse.status === 429) {
                continue;
            } else {
                continue;
            }
        } catch (error) {
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
                console.log(`Cleaned ${cleanupResult.meta.changes} expired codes`);
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
                    codeLinkContent = `
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span>${escapeHtml(code)}</span>
                            <button style="background: linear-gradient(135deg, #00d4ff, #7000ff); color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85em;" onclick="copyCode('${escapeHtml(code)}', this)">复制</button>
                        </div>
                        <br><a href="${escapeHtml(link)}" target="_blank">${escapeHtml(row.topic)}</a>`;
                } else if (row.code.startsWith('http')) {
                    codeLinkContent = `<a href="${escapeHtml(row.code)}" target="_blank">${escapeHtml(row.topic)}</a>`;
                } else {
                    codeLinkContent = `
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span>${escapeHtml(row.code)}</span>
                            <button style="background: linear-gradient(135deg, #00d4ff, #7000ff); color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85em;" onclick="copyCode('${escapeHtml(row.code)}', this)">复制</button>
                        </div>`;
                }

                const timePercentage = getTimePercentage(row.created_at);
                const colorClass = getTimeColorClass(row.created_at);
                const isNew = isNewCode(row.created_at);

                dataHtml += `<tr data-created-at="${row.created_at}">
                    <td>${escapeHtml(row.from_org)}${isNew ? '<span style="background: #4CAF50; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; margin-left: 8px;">NEW</span>' : ''}</td>
                    <td>${escapeHtml(row.topic)}</td>
                    <td>${codeLinkContent}</td>
                    <td>
                        <div>${escapeHtml(row.created_at)}</div>
                        <div style="display: inline-flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="font-size: 0.9em; font-weight: 500;">${getTimeRemaining(row.created_at)}</span>
                        </div>
                        ${timePercentage > 0 ? `
                        <div style="width: 100%; height: 6px; background-color: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 8px; overflow: hidden; position: relative;">
                            <div style="height: 100%; background: linear-gradient(90deg, ${colorClass === 'good' ? '#4CAF50, #45a049' : colorClass === 'warning' ? '#ff9800, #f57c00' : '#f44336, #d32f2f'}); border-radius: 3px; transition: width 1s linear; width: ${timePercentage}%;"></div>
                        </div>` : ''}
                    </td>
                </tr>`;
            }
            
            // 如果没有数据，显示提示
            if (results.length === 0) {
                dataHtml = `<tr><td colspan="4" style="text-align: center; padding: 40px; color: #6c757d;">
                    暂无验证码数据<br>
                    <small style="color: #999; margin-top: 10px; display: block;">验证码将在收到邮件后自动显示</small>
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

            // 在HTML末尾添加JavaScript功能
            responseHtml = responseHtml.replace('</body>', `
                <script>
                    function copyCode(code, button) {
                        navigator.clipboard.writeText(code).then(() => {
                            const originalText = button.textContent;
                            button.textContent = '已复制';
                            setTimeout(() => {
                                button.textContent = originalText;
                            }, 1000);
                        }).catch(() => {
                            const textArea = document.createElement('textarea');
                            textArea.value = code;
                            document.body.appendChild(textArea);
                            textArea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textArea);
                            
                            const originalText = button.textContent;
                            button.textContent = '已复制';
                            setTimeout(() => {
                                button.textContent = originalText;
                            }, 1000);
                        });
                    }

                    function updateCountdowns() {
                        const rows = document.querySelectorAll('tbody tr[data-created-at]');
                        const now = new Date();
                        
                        rows.forEach(row => {
                            const createdAt = new Date(row.dataset.createdAt);
                            const diffMinutes = (now.getTime() - createdAt.getTime()) / 1000 / 60;
                            const remaining = 10 - diffMinutes;
                            const percentage = Math.max(0, Math.min(100, (remaining / 10) * 100));
                            
                            let displayText = '';
                            let color = '';
                            
                            if (remaining <= 0) {
                                displayText = '已过期';
                                color = '#999';
                            } else if (remaining <= 2) {
                                displayText = \`剩余 \${Math.floor(remaining)} 分 \${Math.floor((remaining % 1) * 60)} 秒\`;
                                color = '#f44336';
                            } else if (remaining <= 5) {
                                displayText = \`剩余 \${Math.floor(remaining)} 分钟\`;
                                color = '#ff9800';
                            } else {
                                displayText = \`剩余 \${Math.floor(remaining)} 分钟\`;
                                color = '#4CAF50';
                            }
                            
                            const timeCell = row.cells[3];
                            const timeSpan = timeCell.querySelector('span');
                            if (timeSpan) {
                                timeSpan.innerHTML = \`<span style="color: \${color}">\${displayText}</span>\`;
                            }
                            
                            const progressBar = timeCell.querySelector('div > div');
                            if (progressBar && percentage > 0) {
                                progressBar.style.width = \`\${percentage}%\`;
                                
                                let gradient = '';
                                if (remaining <= 2) {
                                    gradient = 'linear-gradient(90deg, #f44336, #d32f2f)';
                                } else if (remaining <= 5) {
                                    gradient = 'linear-gradient(90deg, #ff9800, #f57c00)';
                                } else {
                                    gradient = 'linear-gradient(90deg, #4CAF50, #45a049)';
                                }
                                progressBar.style.background = gradient;
                            } else if (percentage <= 0) {
                                const progressContainer = timeCell.querySelector('div[style*="background-color: rgba(255,255,255,0.1)"]');
                                if (progressContainer) {
                                    progressContainer.remove();
                                }
                            }
                        });
                    }

                    document.addEventListener('DOMContentLoaded', function() {
                        setInterval(updateCountdowns, 1000);
                        
                        // 检查新验证码并播放提示音
                        const rows = document.querySelectorAll('tbody tr[data-created-at]');
                        const now = new Date();
                        
                        rows.forEach(row => {
                            const createdAt = new Date(row.dataset.createdAt);
                            const diffMinutes = (now.getTime() - createdAt.getTime()) / 1000 / 60;
                            
                            if (diffMinutes < 1) {
                                setTimeout(() => {
                                    try {
                                        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                                        const oscillator = audioContext.createOscillator();
                                        const gainNode = audioContext.createGain();
                                        
                                        oscillator.connect(gainNode);
                                        gainNode.connect(audioContext.destination);
                                        
                                        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
                                        oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
                                        
                                        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                                        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
                                        
                                        oscillator.start(audioContext.currentTime);
                                        oscillator.stop(audioContext.currentTime + 0.1);
                                    } catch (e) {}
                                }, 500);
                            }
                        });
                    });
                </script>
            </body>`);

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

            // 检查重复邮件
            const existing = await env.DB.prepare(
                'SELECT 1 FROM raw_mails WHERE message_id = ?'
            ).bind(message_id).first();

            if (existing) {
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
                return;
            }

            // 改进的 AI 提示词
            const aiPrompt = `
Email content: ${rawEmail}.

**CRITICAL FIRST STEP - EMAIL TYPE CLASSIFICATION:**

Analyze the email and classify it as either:
- Type A: LOGIN/SIGN-IN verification email
- Type B: PASSWORD RESET email
- Type C: Other (advertisement, notification, etc.)

Classification criteria:
TYPE B (PASSWORD RESET) - If ANY of these appear:
- Subject contains: "password reset" | "密码重置" | "=E5=AF=86=E7=A0=81=E9=87=8D=E7=BD=AE"
- Body contains: "reset your password" | "重置密码" | "password recovery"
- Body contains: "如果您未尝试重置密码" | "change your password"

TYPE A (LOGIN) - If ALL of these conditions are met:
- No password reset indicators found
- Contains phrases: "log-in code" | "sign-in code" | "suspicious log-in"
- Has a 6-digit verification code

→ If Type B detected: IMMEDIATELY return {"codeExist": 0}
→ If Type A detected: Continue to extraction
→ If Type C detected: Return {"codeExist": 0}

Please replace the raw email content in place of [Insert raw email content here]. Please read the email and extract the following information:
1. Extract **only** the verification code whose purpose is explicitly for **logging in / signing in** (look for nearby phrases such as "login code", "sign-in code", "one-time sign-in code", "use XYZ to log in", "log-in code", "suspicious log-in", etc.).  
   - **Ignore** any codes related to password reset, password change, account recovery, unlock requests, 2-factor codes for password resets, or other non-login purposes (these typically appear near words like "reset your password", "change password", "password assistance", "recover account", "unlock", "安全验证（修改密码）" etc.).  
   - If multiple codes exist, return only the one that matches the login criterion; if none match, treat as "no code".
2. Extract ONLY the email address part:
   - FIRST try to find the Resent-From field in email headers. If found and it's in format "Name <email@example.com>", extract ONLY "email@example.com".
   - If NO Resent-From field exists, then use the From field and extract ONLY the email address part.
3. Provide a brief summary of the email's topic (e.g., "account login verification").
Format the output as JSON with this structure:
{
  "title": "The extracted email address ONLY, without any name or angle brackets (e.g., 'sender@example.com')",
  "code": "Extracted login verification code (e.g., '123456')",
  "topic": "A brief summary of the email's topic (e.g., 'account login verification')",
  "codeExist": 1
}
If both a login code and a link are present, only display the login verification code in the 'code' field, like this:
"code": "123456"
If there is no login verification code, clickable link, or this is an advertisement email, return:
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

                            try {
                                extractedData = JSON.parse(extractedText);
                                
                                // 验证数据
                                if (extractedData.codeExist === 1) {
                                    if (!extractedData.title || !extractedData.code || !extractedData.topic) {
                                        extractedData = null;
                                        throw new Error("Invalid data structure");
                                    }
                                }
                            } catch (parseError) {
                                throw parseError;
                            }
                        } else {
                            throw new Error("AI response is missing expected data structure");
                        }
                    } catch (error) {
                        // 如果是 Google API 失败，尝试 OpenAI
                        if (retryCount === 0 && env.OpenAIAPIKey) {
                            try {
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
                                    break; // 成功，退出重试循环
                                }
                            } catch (openaiError) {
                                // OpenAI 也失败，继续重试
                            }
                        }
                        
                        if (retryCount < maxRetries - 1) {
                            // 简单延迟重试
                            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                        }
                    }

                    if (!extractedData) {
                        retryCount++;
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
                            console.error(`Failed to save code for ${message.from}`);
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

                                    return barkResponse.ok;
                                } catch (error) {
                                    return false;
                                }
                            });

                            const results = await Promise.allSettled(barkPromises);
                            const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
                            
                            if (successCount > 0) {
                                console.log(`Bark sent: ${successCount}/${barkTokens.length}`);
                            }
                        }

                        // 记录处理时间
                        const processingTime = Date.now() - startTime;
                        console.log(`Email processed: ${code} (${processingTime}ms)`);
                    } else {
                        console.log("No login code found");
                    }
                } else {
                    console.error("Failed to extract data after retries");
                }
            } catch (e) {
                console.error("AI/DB error:", e.message);
            }
        } catch (error) {
            console.error(`Email processing failed: ${error.message}`);
        }
    }
} satisfies ExportedHandler<Env>;
