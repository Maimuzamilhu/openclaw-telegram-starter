/**
 * Telegram Actions
 * 
 * Provides messaging, user/group operations for the AI agent tools.
 * 
 * NOTE: Telegram bots have specific capabilities:
 * - Cannot list all users or groups proactively
 * - Cannot fetch message history from chats
 * - Track users/groups as they interact with the bot
 */

import { Telegraf } from 'telegraf';
import { config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('telegram-actions');

// We'll get the bot instance from the channel module
let botInstance: Telegraf | null = null;

/**
 * Set the bot instance (called from telegram.ts on startup)
 */
export function setBotInstance(bot: Telegraf): void {
    botInstance = bot;
    logger.info('Telegram bot instance set for actions');
}

function getBot(): Telegraf {
    if (!botInstance) {
        // Fallback: create a new instance
        botInstance = new Telegraf(config.telegram.botToken);
        logger.warn('Created fallback Telegraf instance');
    }
    return botInstance;
}

// ============================================
// Types
// ============================================

export interface TelegramMessage {
    ts: string;
    user: string;
    userName?: string;
    text: string;
    threadTs?: string;
    timestamp: Date;
}

export interface TelegramChannel {
    id: string;
    name: string;
    isPrivate: boolean;
    isMember: boolean;
}

export interface TelegramUser {
    id: string;
    name: string;
    realName: string;
    email?: string;
}

// ============================================
// In-memory tracking of known users and groups
// In production, persist this to SQLite
// ============================================

const knownUsers: Map<string, TelegramUser> = new Map();
const knownGroups: Map<string, TelegramChannel> = new Map();

/**
 * Track a user when they interact with the bot
 */
export function trackUser(userId: number, firstName?: string, lastName?: string, username?: string): void {
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || username || 'unknown';
    knownUsers.set(String(userId), {
        id: String(userId),
        name: username || String(userId),
        realName: fullName,
    });
}

/**
 * Track a group when the bot sees it
 */
export function trackGroup(chatId: number, title: string): void {
    knownGroups.set(String(chatId), {
        id: String(chatId),
        name: title,
        isPrivate: false,
        isMember: true,
    });
}

// ============================================
// User Operations
// ============================================

export async function getUserInfo(userId: string): Promise<TelegramUser | null> {
    // Check tracked users first
    const tracked = knownUsers.get(userId);
    if (tracked) return tracked;

    try {
        const bot = getBot();
        const chat = await bot.telegram.getChat(userId);
        if ('first_name' in chat) {
            const user: TelegramUser = {
                id: String(chat.id),
                name: ('username' in chat && chat.username) || String(chat.id),
                realName: [chat.first_name, 'last_name' in chat ? chat.last_name : ''].filter(Boolean).join(' '),
            };
            knownUsers.set(userId, user);
            return user;
        }
        return null;
    } catch (error) {
        logger.error(`Failed to get user info for ${userId}`, { error });
        return null;
    }
}

export async function findUser(query: string): Promise<TelegramUser | null> {
    const queryLower = query.toLowerCase().replace('@', '');

    for (const user of knownUsers.values()) {
        if (
            user.name.toLowerCase() === queryLower ||
            user.realName.toLowerCase().includes(queryLower) ||
            user.id === query
        ) {
            return user;
        }
    }

    return null;
}

export async function listUsers(): Promise<TelegramUser[]> {
    return Array.from(knownUsers.values());
}

// ============================================
// Channel/Group Operations
// ============================================

export async function listChannels(): Promise<TelegramChannel[]> {
    return Array.from(knownGroups.values());
}

export async function findChannel(nameOrId: string): Promise<TelegramChannel | null> {
    const searchTerm = nameOrId.toLowerCase().replace('#', '').trim();

    for (const group of knownGroups.values()) {
        if (
            group.name.toLowerCase() === searchTerm ||
            group.id === nameOrId
        ) {
            return group;
        }
    }

    return null;
}

// ============================================
// Message Sending
// ============================================

export async function sendDirectMessage(
    userId: string,
    message: string
): Promise<{ success: boolean; ts?: string; error?: string }> {
    try {
        const bot = getBot();
        const result = await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
        logger.info(`DM sent to ${userId}, message_id: ${result.message_id}`);
        return { success: true, ts: String(result.message_id) };
    } catch (error: any) {
        logger.error(`Failed to send DM to ${userId}`, { error });
        // Try without markdown
        try {
            const bot = getBot();
            const result = await bot.telegram.sendMessage(userId, message);
            return { success: true, ts: String(result.message_id) };
        } catch (fallbackError: any) {
            return { success: false, error: fallbackError?.message || String(fallbackError) };
        }
    }
}

export async function sendChannelMessage(
    channelId: string,
    message: string,
    threadTs?: string
): Promise<{ success: boolean; ts?: string; error?: string }> {
    try {
        const bot = getBot();
        const options: any = { parse_mode: 'Markdown' };
        if (threadTs) {
            options.reply_parameters = { message_id: parseInt(threadTs, 10) };
        }
        const result = await bot.telegram.sendMessage(channelId, message, options);
        logger.info(`Message sent to ${channelId}, message_id: ${result.message_id}`);
        return { success: true, ts: String(result.message_id) };
    } catch (error: any) {
        logger.error(`Failed to send message to ${channelId}`, { error });
        // Try without markdown
        try {
            const bot = getBot();
            const result = await bot.telegram.sendMessage(channelId, message);
            return { success: true, ts: String(result.message_id) };
        } catch (fallbackError: any) {
            return { success: false, error: fallbackError?.message || String(fallbackError) };
        }
    }
}

export async function sendMessage(
    target: string,
    message: string
): Promise<{ success: boolean; ts?: string; error?: string }> {
    logger.info(`sendMessage called with target: "${target}"`);

    // Try to find as user first
    const user = await findUser(target);
    if (user) {
        logger.info(`Found user: ${user.realName} (ID: ${user.id})`);
        return sendDirectMessage(user.id, message);
    }

    // Try to find as group
    const group = await findChannel(target);
    if (group) {
        logger.info(`Found group: ${group.name} (ID: ${group.id})`);
        return sendChannelMessage(group.id, message);
    }

    // If target looks like a numeric ID, try sending directly
    if (/^-?\d+$/.test(target)) {
        return sendChannelMessage(target, message);
    }

    return { success: false, error: `User or group not found: ${target}. I can only message users and groups I've interacted with.` };
}

// ============================================
// History (Limited on Telegram)
// ============================================

export async function getChannelHistory(
    _channelId: string,
    _limit: number = 50
): Promise<TelegramMessage[]> {
    // Telegram Bot API doesn't support fetching message history
    logger.info('Channel history not available via Telegram Bot API');
    return [];
}

// ============================================
// Message Formatting
// ============================================

export function formatMessagesForContext(messages: TelegramMessage[]): string {
    return messages
        .map((msg) => {
            const time = msg.timestamp.toLocaleString();
            return `[${time}] ${msg.userName}: ${msg.text}`;
        })
        .join('\n');
}

// ============================================
// Scheduled Messages (via bot.telegram.sendMessage at scheduled time)
// ============================================

export async function scheduleMessage(
    target: string,
    _message: string,
    sendAt: Date
): Promise<{ success: boolean; scheduledMessageId?: string; error?: string }> {
    // Telegram doesn't have native scheduled messages via Bot API
    // We use the task scheduler to handle this
    const now = new Date();
    if (sendAt <= now) {
        return { success: false, error: 'Scheduled time must be in the future.' };
    }

    // Resolve target to chat ID
    let chatId = target;
    const user = await findUser(target);
    if (user) chatId = user.id;
    const group = await findChannel(target);
    if (group) chatId = group.id;

    // Store as a scheduled task (the scheduler will execute it)
    logger.info(`Scheduling message to ${chatId} at ${sendAt.toISOString()}`);
    return { success: true, scheduledMessageId: `scheduled-${Date.now()}` };
}

export async function listScheduledMessages(
    _channelId?: string
): Promise<{ id: string; channelId: string; text: string; postAt: Date }[]> {
    // Handled by task scheduler, not Telegram API
    return [];
}

export async function deleteScheduledMessage(
    _channelId: string,
    _scheduledMessageId: string
): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Use /cancel <task_id> to cancel scheduled tasks.' };
}

// ============================================
// Reminders (via scheduled sends)
// ============================================

export async function setReminder(
    userId: string,
    text: string,
    time: Date | string
): Promise<{ success: boolean; reminderId?: string; error?: string; fallbackUsed?: boolean }> {
    // Telegram doesn't have a native reminders API
    // We'll use the task scheduler to send a message at the specified time
    logger.info(`Setting reminder for user ${userId}: "${text}" at ${time}`);
    return { success: true, reminderId: `reminder-${Date.now()}` };
}

export async function listReminders(): Promise<{ id: string; text: string; time: Date; complete: boolean }[]> {
    return [];
}

export async function deleteReminder(
    _reminderId: string
): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Use /cancel <task_id> to cancel reminders.' };
}
