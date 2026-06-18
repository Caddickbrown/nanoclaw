import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { transcribeAudioFile } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Download a file from Telegram's file servers to a local path.
 */
function downloadTelegramFile(
  token: string,
  filePath: string,
  dest: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const out = fs.createWriteStream(dest);
    https
      .get(url, { agent: https.globalAgent }, (res) => {
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot (handled by caller)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      // Brief grace period for Telegram API propagation before sending
      await new Promise((r) => setTimeout(r, 500));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  const numericId = chatId.replace(/^tg:/, '');
  const MAX_LENGTH = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    chunks.push(text.slice(i, i + MAX_LENGTH));
  }

  for (const chunk of chunks) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await api.sendMessage(numericId, chunk);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const retryAfter = (err as any)?.parameters?.retry_after ?? attempt * 2;
        logger.debug(
          { chatId, sender, attempt, retryAfter },
          'Pool message send failed, retrying',
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      }
    }
    if (lastErr) {
      logger.error(
        { chatId, sender, err: lastErr },
        'Failed to send pool message after retries',
      );
    }
  }
  logger.info(
    { chatId, sender, poolIndex: idx, length: text.length },
    'Pool message sent',
  );
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = `[Photo]${caption}`;
      try {
        // Take the largest available size (last in array)
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path) {
          const mediaDir = path.join(
            process.cwd(),
            'groups',
            group.folder,
            'media',
          );
          fs.mkdirSync(mediaDir, { recursive: true });
          const filename = `tg_photo_${ctx.message.message_id}.jpg`;
          const localPath = path.join(mediaDir, filename);
          await downloadTelegramFile(this.botToken, file.file_path, localPath);
          const containerPath = `/workspace/group/media/${filename}`;
          content = `[Photo: ${containerPath}]${caption}`;
          logger.info(
            { chatJid, containerPath },
            'Telegram photo saved for agent',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Photo download error');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';
      let tmpPath: string | null = null;
      try {
        const file = await ctx.getFile();
        if (file.file_path) {
          tmpPath = path.join(
            os.tmpdir(),
            `tg_voice_${ctx.message.message_id}.ogg`,
          );
          await downloadTelegramFile(this.botToken, file.file_path, tmpPath);
          const transcript = await transcribeAudioFile(tmpPath);
          if (transcript) {
            content = `[Voice: ${transcript}]`;
            logger.info({ chatJid }, 'Telegram voice message transcribed');
          }
        }
      } catch (err) {
        logger.error({ err }, 'Voice transcription error');
      } finally {
        if (tmpPath) fs.unlink(tmpPath, () => {});
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const audio = ctx.message.audio;
      const name = audio?.file_name || `audio_${ctx.message.message_id}.ogg`;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = `[Audio: ${name}]${caption}`;

      if (audio?.file_id) {
        try {
          const file = await ctx.api.getFile(audio.file_id);
          if (file.file_path) {
            const attachDir = path.join(
              process.cwd(),
              'groups',
              group.folder,
              'attachments',
            );
            fs.mkdirSync(attachDir, { recursive: true });
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filename = `tg_audio_${ctx.message.message_id}_${safeName}`;
            const localPath = path.join(attachDir, filename);
            await downloadTelegramFile(
              this.botToken,
              file.file_path,
              localPath,
            );
            const containerPath = `/workspace/group/attachments/${filename}`;
            content = `[Audio: ${containerPath}]${caption}`;
            logger.info(
              { chatJid, containerPath },
              'Telegram audio saved for agent',
            );
          }
        } catch (err: any) {
          logger.warn(
            { err: err?.message, name },
            'Could not download Telegram audio (may exceed 20 MB limit)',
          );
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      const mime = doc?.mime_type || '';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = `[Document: ${name}]${caption}`;

      // Download PDFs (and other documents) into the group attachments directory
      if (doc?.file_id) {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          if (file.file_path) {
            const attachDir = path.join(
              process.cwd(),
              'groups',
              group.folder,
              'attachments',
            );
            fs.mkdirSync(attachDir, { recursive: true });
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filename = `tg_doc_${ctx.message.message_id}_${safeName}`;
            const localPath = path.join(attachDir, filename);
            await downloadTelegramFile(
              this.botToken,
              file.file_path,
              localPath,
            );
            const containerPath = `/workspace/group/attachments/${filename}`;
            const typeLabel = mime === 'application/pdf' ? 'PDF' : 'Document';
            content = `[${typeLabel}: ${containerPath}]${caption}`;
            logger.info(
              { chatJid, containerPath, mime },
              'Telegram document saved for agent',
            );
          }
        } catch (err: any) {
          // Telegram Bot API rejects files > 20 MB — fall back to placeholder
          logger.warn(
            { err: err?.message, name },
            'Could not download Telegram document (may exceed 20 MB limit)',
          );
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle emoji reactions on messages
    this.bot.on('message_reaction', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const reaction = ctx.update.message_reaction!;
      const timestamp = new Date(reaction.date * 1000).toISOString();

      const user = reaction.user;
      const actorChat = (reaction as any).actor_chat;
      const senderName = user
        ? user.first_name || user.username || user.id.toString()
        : actorChat?.title || 'Someone';
      const sender = user ? user.id.toString() : '';

      const toEmoji = (r: any): string =>
        r.type === 'emoji' ? r.emoji : r.type === 'paid' ? '⭐' : '?';

      const oldSet = new Set(reaction.old_reaction.map(toEmoji));
      const newList = reaction.new_reaction.map(toEmoji);
      const added = newList.filter((e) => !oldSet.has(e));
      const removed = [...oldSet].filter((e) => !newList.includes(e));

      let content: string;
      if (added.length > 0) {
        content = `[Reaction: ${added.join('')} on message #${reaction.message_id}]`;
      } else if (removed.length > 0) {
        content = `[Reaction removed: ${removed.join('')} on message #${reaction.message_id}]`;
      } else {
        return;
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: `reaction_${reaction.message_id}_${reaction.date}`,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, content, sender: senderName },
        'Telegram reaction received',
      );
    });

    // Handle inline button callbacks (check-ins via send_checkin tool)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('ckin:')) {
        await ctx.answerCallbackQuery();
        return;
      }

      // Parse format: ckin:{checkinId}:{value}
      const firstColon = data.indexOf(':', 5); // skip 'ckin:'
      if (firstColon < 0) {
        await ctx.answerCallbackQuery();
        return;
      }
      const checkinId = data.slice(5, firstColon);
      const value = data.slice(firstColon + 1);

      await ctx.answerCallbackQuery();

      const chatJid = `tg:${ctx.chat?.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.warn({ chatJid }, 'Callback from unregistered chat');
        return;
      }

      // Read metadata to get label and original question
      let label = value;
      let question = '';
      try {
        const metaPath = path.join(
          GROUPS_DIR,
          group.folder,
          'checkin_meta',
          `${checkinId}.json`,
        );
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
            question: string;
            buttons: Array<{ label: string; value: string }>;
          };
          question = meta.question || '';
          const btn = meta.buttons?.find((b) => b.value === value);
          if (btn) label = btn.label;
        }
      } catch (err) {
        logger.warn({ checkinId, err }, 'Could not read checkin metadata');
      }

      // Edit the message to show the selection
      try {
        const editedText = question
          ? `${question}\n\n✅ *${label}*`
          : `✅ *${label}*`;
        await ctx.editMessageText(editedText, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.debug(
          { err },
          'Could not edit checkin message (may have expired)',
        );
      }

      // Write result file for tasks to query
      try {
        const resultDir = path.join(
          GROUPS_DIR,
          group.folder,
          'checkin_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        fs.writeFileSync(
          path.join(resultDir, `${checkinId}.json`),
          JSON.stringify(
            {
              checkin_id: checkinId,
              response_label: label,
              response_value: value,
              responded_at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        logger.info({ chatJid, checkinId, value }, 'Checkin response recorded');
      } catch (err) {
        logger.error({ checkinId, err }, 'Failed to write checkin result');
      }
    });

    // Start polling — returns a Promise that resolves when started, rejects on error
    return new Promise<void>((resolve, reject) => {
      this.bot!.catch((err) => {
        logger.error({ err: err.message }, 'Telegram bot error');
        reject(err);
      });
      this.bot!.start({
        allowed_updates: ['message', 'message_reaction', 'callback_query'],
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      chunks.push(text.slice(i, i + MAX_LENGTH));
    }

    for (const chunk of chunks) {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await sendTelegramMessage(this.bot.api, numericId, chunk);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          // Respect Telegram's retry_after if present, otherwise back off
          const retryAfter =
            (err as any)?.parameters?.retry_after ?? attempt * 2;
          logger.debug(
            { jid, attempt, retryAfter },
            'Telegram send failed, retrying',
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        }
      }
      if (lastErr) {
        logger.error(
          { jid, err: lastErr },
          'Failed to send Telegram message after retries',
        );
      }
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const ext = path.extname(filePath).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      const isVoice = ext === '.ogg';
      if (isImage) {
        await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
          caption,
        });
      } else if (isVoice) {
        await this.bot.api.sendVoice(numericId, new InputFile(filePath), {
          caption,
        });
      } else {
        await this.bot.api.sendDocument(numericId, new InputFile(filePath), {
          caption,
        });
      }
      logger.info({ jid, filePath }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  async sendMessageWithButtons(
    jid: string,
    text: string,
    buttons: Array<{ label: string; value: string }>,
    checkinId: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    const numericId = jid.replace(/^tg:/, '');

    // Store metadata so the callback handler can look up labels
    const group = this.opts.registeredGroups()[jid];
    if (group) {
      try {
        const metaDir = path.join(GROUPS_DIR, group.folder, 'checkin_meta');
        fs.mkdirSync(metaDir, { recursive: true });
        fs.writeFileSync(
          path.join(metaDir, `${checkinId}.json`),
          JSON.stringify({ question: text, buttons }, null, 2),
        );
      } catch (err) {
        logger.warn({ checkinId, err }, 'Failed to write checkin metadata');
      }
    }

    // Build inline keyboard (one button per row)
    const inline_keyboard = buttons.map((btn) => [
      {
        text: btn.label,
        callback_data: `ckin:${checkinId}:${btn.value}`,
      },
    ]);

    try {
      await this.bot.api.sendMessage(numericId, text, {
        reply_markup: { inline_keyboard },
        parse_mode: 'Markdown',
      });
      logger.info(
        { jid, checkinId, buttons: buttons.length },
        'Checkin message sent',
      );
    } catch (err) {
      logger.error({ jid, checkinId, err }, 'Failed to send checkin message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.setMessageReaction(
        numericId,
        parseInt(messageId, 10),
        [{ type: 'emoji', emoji } as any],
      );
      logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to send Telegram reaction',
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
