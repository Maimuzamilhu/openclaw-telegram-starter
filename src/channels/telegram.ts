/**
 * Telegram Channel Handler
 * 
 * Telegram Channel Handler
 * - Incoming messages (private chats and groups)
 * - Bot commands (/help, /reset, /status, /approve)
 * - Typing indicators
 * - Session management
 * - Calls processMessage() from the AI agent
 */

import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import {
    getOrCreateSession,
    generatePairingCode,
    approvePairing,
} from '../memory/database.js';
import { processMessage, AgentContext } from '../agents/agent.js';
import { taskScheduler } from '../tools/scheduler.js';
import { indexSingleMessage } from '../rag/indexer.js';

const logger = createModuleLogger('telegram');

// Initialize Telegraf Bot
export const bot = new Telegraf(config.telegram.botToken);

// Bot info (populated on startup)
let botInfo: { id: number; username: string } | null = null;

// ============================================
// Helper Functions
// ============================================

async function getBotInfo(): Promise<{ id: number; username: string }> {
    if (botInfo) return botInfo;
    const me = await bot.telegram.getMe();
    botInfo = { id: me.id, username: me.username || 'bot' };
    return botInfo;
}

function isPrivateChat(ctx: Context): boolean {
    return ctx.chat?.type === 'private';
}

function isGroupChat(ctx: Context): boolean {
    return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function isBotMentioned(text: string, botUsername: string): boolean {
    return text.includes(`@${botUsername}`);
}

function removeBotMention(text: string, botUsername: string): string {
    return text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim();
}

function isUserAllowed(userId: number): boolean {
    const allowed = config.telegram.allowedUsers;
    if (allowed.includes('*')) return true;
    return allowed.includes(String(userId));
}

async function sendTypingAction(ctx: Context): Promise<void> {
    if (!config.features.typingIndicator) return;
    try {
        await ctx.sendChatAction('typing');
    } catch (error) {
        logger.debug('Failed to send typing action', { error });
    }
}

// ============================================
// Command Handlers
// ============================================

// /start command
bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    logger.info(`/start from user ${userId}`);

    await ctx.reply(
        `👋 *Welcome to AI Assistant!*\n\n` +
        `I'm an AI-powered assistant with:\n` +
        `• 🔍 *RAG* — Search through message history\n` +
        `• 🧠 *Memory* — I remember our conversations\n` +
        `• 🔌 *GitHub & Notion* — Manage repos, issues, pages\n\n` +
        `Just send me a message to get started\\!\n` +
        `Use /help for all commands\\.`,
        { parse_mode: 'MarkdownV2' }
    );
});

// /help command
bot.command('help', async (ctx) => {
    await ctx.reply(
        `🤖 *AI Assistant - Help*\n\n` +
        `*Commands:*\n` +
        `• /help - Show this help message\n` +
        `• /reset - Clear conversation history\n` +
        `• /status - Show bot status\n` +
        `• /mytasks - List your scheduled tasks\n` +
        `• /cancel <id> - Cancel a scheduled task\n\n` +
        `*Features:*\n` +
        `• I remember our conversation context\n` +
        `• I can search message history (RAG)\n` +
        `• I can manage GitHub repos, issues, and PRs\n` +
        `• I can search and read Notion pages\n` +
        `• I can schedule messages and reminders\n\n` +
        `*Tips:*\n` +
        `• In groups, mention me with @${(await getBotInfo()).username}\n` +
        `• Ask "what do you remember about me?" to see stored memories`,
        { parse_mode: 'Markdown' }
    );
});

// /reset command
bot.command('reset', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    getOrCreateSession(String(userId), String(chatId), null);
    await ctx.reply('🔄 Conversation history has been cleared. Starting fresh!');
});

// /status command
bot.command('status', async (ctx) => {
    const status = {
        uptime: `${Math.floor(process.uptime())}s`,
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        features: config.features,
    };

    await ctx.reply(
        `🤖 *Assistant Status*\n\`\`\`\n${JSON.stringify(status, null, 2)}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );
});

// /mytasks command  
bot.command('mytasks', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const tasks = taskScheduler.getUserTasks(String(userId));
    if (tasks.length === 0) {
        await ctx.reply("You don't have any scheduled tasks.");
    } else {
        const taskList = tasks
            .map(
                (t) =>
                    `• [${t.id}] ${t.taskDescription} - ${t.status} ${t.scheduledTime ? `(${new Date(t.scheduledTime * 1000).toLocaleString()})` : ''}`
            )
            .join('\n');
        await ctx.reply(`📋 *Your Tasks:*\n${taskList}`, { parse_mode: 'Markdown' });
    }
});

// /cancel command
bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const text = ctx.message?.text || '';
    const match = text.match(/\/cancel\s+(\d+)/);
    if (!match) {
        await ctx.reply('Usage: /cancel <task_id>');
        return;
    }

    const taskId = parseInt(match[1], 10);
    const success = taskScheduler.cancelTask(taskId, String(userId));
    await ctx.reply(
        success
            ? `✅ Task ${taskId} has been cancelled.`
            : `❌ Could not cancel task ${taskId}. It may not exist or belong to you.`
    );
});

// /approve command (for pairing)
bot.command('approve', async (ctx) => {
    const text = ctx.message?.text || '';
    const code = text.replace('/approve', '').trim().toUpperCase();

    if (!code) {
        await ctx.reply('Please provide a pairing code: /approve CODE');
        return;
    }

    const success = approvePairing(code, String(ctx.from?.id));
    if (success) {
        await ctx.reply(`✅ Pairing code ${code} approved! The user can now chat with me.`);
    } else {
        await ctx.reply(`❌ Invalid or expired pairing code: ${code}`);
    }
});

// ============================================
// Message Handlers
// ============================================

bot.on(message('text'), async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    const messageId = ctx.message?.message_id;

    if (!userId || !chatId || !text) return;

    // Skip bot's own messages
    const info = await getBotInfo();
    if (userId === info.id) return;

    // Skip commands (already handled above)
    if (text.startsWith('/')) return;

    const isPrivate = isPrivateChat(ctx);
    const isGroup = isGroupChat(ctx);

    // In groups, only respond if mentioned
    if (isGroup) {
        if (!isBotMentioned(text, info.username)) {
            // Still index the message for RAG if enabled
            if (config.rag.enabled) {
                await indexSingleMessage(
                    {
                        ts: String(messageId),
                        text: text,
                        user: String(userId),
                    },
                    String(chatId),
                    ('title' in ctx.chat ? ctx.chat.title : 'group') || 'group'
                ).catch(err => logger.debug('Failed to index group message', { error: err }));
            }
            return;
        }
    }

    // Check user permissions
    if (!isUserAllowed(userId)) {
        if (config.security.dmPolicy === 'pairing') {
            const code = generatePairingCode(String(userId));
            await ctx.reply(
                `👋 Hi! Before we chat, you need to be approved.\n\nYour pairing code is: \`${code}\`\n\nAsk an admin to approve you with: /approve ${code}\n\nThis code expires in 1 hour.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }
        if (config.security.dmPolicy !== 'open') {
            await ctx.reply("Sorry, you're not authorized to use this bot.");
            return;
        }
    }

    // Clean up message text
    const cleanText = isGroup ? removeBotMention(text, info.username) : text;

    if (!cleanText) return;

    logger.info(`Message received from ${userId} in ${chatId}`);

    // Send typing indicator
    await sendTypingAction(ctx);

    // Index message for RAG
    if (config.rag.enabled) {
        await indexSingleMessage(
            {
                ts: String(messageId),
                text: cleanText,
                user: String(userId),
            },
            String(chatId),
            isPrivate ? 'DM' : (ctx.chat && 'title' in ctx.chat ? ctx.chat.title || 'group' : 'group')
        ).catch(err => logger.debug('Failed to index message', { error: err }));
    }

    try {
        // Get or create session
        const replyToId = ctx.message?.reply_to_message?.message_id;
        const session = getOrCreateSession(String(userId), String(chatId), replyToId ? String(replyToId) : null);

        // Create agent context
        const context: AgentContext = {
            sessionId: session.id,
            userId: String(userId),
            channelId: String(chatId),
            threadTs: replyToId ? String(replyToId) : null,
            userName: ctx.from?.first_name || ctx.from?.username || undefined,
            channelName: isPrivate ? 'DM' : (ctx.chat && 'title' in ctx.chat ? ctx.chat.title || undefined : undefined),
        };

        // Process message with AI
        const response = await processMessage(cleanText, context);

        // Send response (reply to the message in groups)
        if (isGroup) {
            await ctx.reply(response.content, {
                reply_parameters: { message_id: messageId },
                parse_mode: 'Markdown',
            });
        } else {
            // Try markdown first, fall back to plain text
            try {
                await ctx.reply(response.content, { parse_mode: 'Markdown' });
            } catch {
                await ctx.reply(response.content);
            }
        }
    } catch (error) {
        logger.error('Failed to process message', { error });
        await ctx.reply("I'm sorry, I encountered an error processing your message. Please try again.");
    }
});

// ============================================
// Startup / Shutdown
// ============================================

export async function startTelegramBot(): Promise<void> {
    try {
        // Get bot info
        const info = await getBotInfo();
        logger.info(`Telegram bot started! Username: @${info.username}, ID: ${info.id}`);

        // Start task scheduler
        taskScheduler.start();
        logger.info('Task scheduler started');

        // Launch bot (long polling)
        bot.launch();

        logger.info('Telegram bot is listening for messages...');
    } catch (error) {
        logger.error('Failed to start Telegram bot', { error });
        throw error;
    }
}

export async function stopTelegramBot(): Promise<void> {
    taskScheduler.stop();
    bot.stop('SIGTERM');
    logger.info('Telegram bot stopped');
}
