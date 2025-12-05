/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Dec (Core version)
Updated: 2025 (GPT-4o-mini Only + Password Reset 3x Detection)
*/

import indexHtml from './index.html';

export interface Env {
    DB: D1Database;
    barkTokens: string;
    barkUrl: string;
    OpenAIAPIKey: string;
    UseBark: string;
}

// ========== 数据库版本：密码重置历史记录 ==========

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

async function processAIResponse(db: D1Database, result: any): Promise<any> {
    const emailType = result.emailType || "";
    const code = result.code || "";
    const title = result.forwarderEmail || "";
    
    console.log(`🔍 Type: ${emailType}, Code: ${code}, Email: ${title}`);
    
    // 密码重置类型
    if (emailType === "PASSWORD_RESET") {
        if (!code || !title) {
            console.log(`⚠️ PASSWORD_RESET but missing code (${code}) or title (${title}), skipping...`);
            return { codeExist: 0 };
        }
        
        const shouldExtract = await checkPasswordResetRepeat(db, title, code);
        
        if (shouldExtract) {
            console.log(`🔓 Password reset code repeated 3 times for ${title}, extracting!`);
            await clearPasswordResetHistory(db, title);
            return {
                title: title,
                code: code,
                topic: "Password reset verification (repeated 3 times)",
                codeExist: 1
            };
        } else {
            return { codeExist: 0 };
        }
    }
    
    // 登录类型
    if (emailType === "LOGIN") {
        if (!code || !title) {
            console.log(`⚠️ LOGIN but missing code (${code}) or title (${title}), skipping...`);
            return { codeExist: 0 };
        }
        return {
            title: title,
            code: code,
            topic: "account login verification",
            codeExist: 1
        };
    }
    
    // 其他情况
    return { codeExist: 0 };
}

// ========== 工具函数 ==========

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

function getTimeRemaining(createdAt: string): string {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - created.getTime()) / 1000 / 60);
    const remaining = 10 - diffMinutes;
    
    if (remaining <= 0) return '<span style="color: #999;">已过期</span>';
    if (remaining <= 2) return `<span style="color: red; font-weight: bold;">剩余 ${remaining} 分钟</span>`;
    return `<span style="color: green;">剩余 ${remaining} 分钟</span>`;
}

// ========== OpenAI API 调用 ==========

async function callOpenAI(prompt: string, apiKey: string): Promise<any> {
    console.log('🔄 Calling OpenAI GPT-4o-mini...');
    
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
                    role: 'system',
                    content: 'You are a JSON extractor. Always respond with valid JSON only, no markdown, no explanation.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0,
            max_tokens: 200
        })
    });

    if (!response.ok) {
        console.log(`❌ OpenAI API error: ${response.status} ${response.statusText}`);
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ OpenAI API succeeded');
    
    return data.choices[0].message.content;
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

            // 清理过期的密码重置历史（超过30分钟）
            await env.DB.prepare(
                `DELETE FROM password_reset_history WHERE datetime(updated_at) < datetime('now', '-30 minutes')`
            ).run();
            
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
            
            if (!env.OpenAIAPIKey) {
                console.error('❌ OpenAI API key not configured');
                return;
            }

            console.log('🔧 Using OpenAI GPT-4o-mini');

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

            // GPT-4o-mini 优化的提示词
            const aiPrompt = `Extract from this email:

EMAIL:
${rawEmail}

RULES:
1. emailType: "LOGIN" if contains "如果你无意登录" or "Log-in Code" or "suspicious log-in" or "登录验证码". "PASSWORD_RESET" if contains "密码重置" or "重置密码" or "如果你未尝试重置密码". Otherwise "OTHER".
2. code: The 6-digit number from email body.
3. forwarderEmail: Email address from "Resent-From:" header only (not "From:" header).

Return JSON only:
{"emailType":"TYPE","code":"123456","forwarderEmail":"user@example.com"}`;

            try {
                const maxRetries = 3;
                let retryCount = 0;
                let extractedData = null;

                while (retryCount < maxRetries && !extractedData) {
                    try {
                        const aiResponse = await callOpenAI(aiPrompt, env.OpenAIAPIKey);
                        console.log(`AI response attempt ${retryCount + 1}: "${aiResponse}"`);

                        // 清理并解析 JSON
                        let cleanedResponse = aiResponse.trim();
                        
                        // 移除可能的 markdown 代码块
                        const jsonMatch = cleanedResponse.match(/```json\s*([\s\S]*?)\s*```/);
                        if (jsonMatch && jsonMatch[1]) {
                            cleanedResponse = jsonMatch[1].trim();
                        }
                        
                        // 提取 JSON 对象
                        const jsonObjectMatch = cleanedResponse.match(/\{[\s\S]*\}/);
                        if (jsonObjectMatch) {
                            cleanedResponse = jsonObjectMatch[0];
                        }

                        try {
                            const parsedData = JSON.parse(cleanedResponse);
                            console.log(`Parsed Data:`, JSON.stringify(parsedData));
                            
                            // 处理结果
                            extractedData = await processAIResponse(env.DB, parsedData);
                            console.log(`Processed Data:`, JSON.stringify(extractedData));
                            
                            if (extractedData.codeExist === 1) {
                                if (!extractedData.title || !extractedData.code || !extractedData.topic) {
                                    console.error("Missing required fields in processed response");
                                    extractedData = null;
                                    throw new Error("Invalid data structure");
                                }
                            }
                        } catch (parseError) {
                            console.error("JSON parsing error:", parseError);
                            throw parseError;
                        }
                    } catch (error) {
                        console.error(`Attempt ${retryCount + 1} failed:`, error);
                        
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
