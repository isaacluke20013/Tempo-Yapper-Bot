import { Bot } from './yapper.js';

const TEMPO_OWNER_ID = process.env.TEMPO_OWNER_ID || null;
const IDLE_MS = 10 * 60 * 1000;
const originalStart = Bot.prototype.start;
const sessions = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function userIdOf(context) {
  return (
    context?.user_id ||
    context?.author_id ||
    context?.user?.id ||
    context?.author?.id ||
    null
  );
}

function isTempoOwner(userId) {
  return Boolean(
    TEMPO_OWNER_ID &&
    userId &&
    String(userId) === String(TEMPO_OWNER_ID)
  );
}

function messageText(value, max = 1800) {
  return String(value || '').trim().slice(0, max);
}

async function resolveServerId(bot, context) {
  if (context?.server_id) return context.server_id;

  const channelId = context?.channel_id;
  if (!channelId) return null;

  for (const server of await bot.servers()) {
    const channels = await bot.channels(server.id);
    if (channels.some(channel => String(channel.id) === String(channelId))) {
      return server.id;
    }
  }

  return null;
}

async function findUserVoiceChannel(bot, serverId, userId) {
  const voice = await bot.voice(serverId);
  const entry = (voice || []).find(item =>
    Array.isArray(item.user_ids) &&
    item.user_ids.some(id => String(id) === String(userId))
  );
  return entry?.channel_id || null;
}

function getSession(serverId) {
  const key = String(serverId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      serverId: key,
      channelId: null,
      idleTimer: null
    });
  }
  return sessions.get(key);
}

function clearIdleTimer(session) {
  if (session?.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

async function rawVoiceAction(bot, serverId, action, body = {}) {
  return bot.api(
    'POST',
    `/servers/${serverId}/voice/${action}`,
    body
  );
}

async function voiceJoin(bot, serverId, channelId) {
  if (typeof bot.joinVoice === 'function') {
    return bot.joinVoice(serverId, channelId);
  }
  if (typeof bot.voiceJoin === 'function') {
    return bot.voiceJoin(serverId, channelId);
  }

  return rawVoiceAction(bot, serverId, 'join', {
    channel_id: channelId
  });
}

async function voiceLeave(bot, serverId) {
  if (typeof bot.leaveVoice === 'function') {
    return bot.leaveVoice(serverId);
  }
  if (typeof bot.voiceLeave === 'function') {
    return bot.voiceLeave(serverId);
  }

  return rawVoiceAction(bot, serverId, 'leave');
}

function scheduleIdleLeave(bot, serverId) {
  const session = getSession(serverId);
  clearIdleTimer(session);

  session.idleTimer = setTimeout(async () => {
    try {
      await voiceLeave(bot, serverId);
      console.log(`[tempo voice] left ${serverId} after 10 minutes of inactivity`);
    } catch (err) {
      console.error('[tempo voice] idle leave failed:', err?.message || err);
    } finally {
      clearIdleTimer(session);
      sessions.delete(String(serverId));
    }
  }, IDLE_MS);
}

async function announceEverywhere(bot, text) {
  const servers = await bot.servers();
  let sent = 0;
  let failed = 0;

  for (const server of servers) {
    try {
      const channels = await bot.channels(server.id, { type: 'text' });
      const writable = (channels || []).filter(channel => !channel.read_only);
      const preferredNames = ['announcements', 'announcement', 'general', 'chat', 'main'];

      const target =
        preferredNames
          .map(name => writable.find(channel => String(channel.name || '').toLowerCase() === name))
          .find(Boolean) ||
        writable.find(channel => !channel.private) ||
        writable[0];

      if (!target) {
        failed++;
        continue;
      }

      await bot.send(
        target.id,
        `📢 **Tempo announcement**\n${text}`
      );

      sent++;
      await sleep(150);
    } catch (err) {
      failed++;
      console.error(
        `[tempo announce] ${server?.name || server?.id || 'server'}:`,
        err?.message || err
      );
    }
  }

  return { sent, failed, total: servers.length };
}

async function handleTempo(bot, msg) {
  const userId = userIdOf(msg);
  const raw = String(msg.args || '').trim();
  const [subRaw, ...rest] = raw.split(/\s+/);
  const sub = String(subRaw || 'help').toLowerCase();
  const argument = rest.join(' ').trim();

  if (sub === 'announce') {
    if (!isTempoOwner(userId)) {
      return msg.reply('that command is owner-only.');
    }

    if (!argument) {
      return msg.reply('use `/tempo announce <message>`.');
    }

    const result = await announceEverywhere(bot, messageText(argument));
    return msg.reply(
      `announcement sent to **${result.sent}/${result.total}** servers${result.failed ? ` (${result.failed} failed)` : ''}.`
    );
  }

  const serverId = await resolveServerId(bot, msg);
  if (!serverId) {
    return msg.reply('this command only works inside a server.');
  }

  if (!userId) {
    return msg.reply("couldn't figure out who ran the command.");
  }

  if (sub === 'join') {
    const channelId = await findUserVoiceChannel(bot, serverId, userId);
    if (!channelId) return msg.reply('join a voice channel first.');

    await voiceJoin(bot, serverId, channelId);
    const session = getSession(serverId);
    session.channelId = channelId;
    scheduleIdleLeave(bot, serverId);
    return msg.reply(`joined <#${channelId}>.`);
  }

  if (sub === 'leave' || sub === 'disconnect') {
    const session = getSession(serverId);
    await voiceLeave(bot, serverId);
    clearIdleTimer(session);
    sessions.delete(String(serverId));
    return msg.reply('left voice.');
  }

  if (sub === 'play') {
    return msg.reply(
      'Tempo can join voice now, but Yapper has not exposed bot audio playback in the official bot API yet. `/tempo play` is ready to wire up as soon as they add the audio endpoint.'
    );
  }

  if (sub === 'pause' || sub === 'resume') {
    return msg.reply(
      'pause/resume will work once Yapper exposes bot audio playback controls.'
    );
  }

  return msg.reply(
`**Tempo voice commands**

\`/tempo join\` — join your current VC
\`/tempo leave\` — leave voice
\`/tempo play <song/link>\` — waiting on Yapper's bot audio API
\`/tempo pause\` — waiting on Yapper's bot audio API
\`/tempo resume\` — waiting on Yapper's bot audio API

Tempo leaves after 10 minutes of inactivity.`
  );
}

function installTempoExtras(bot) {
  if (bot.__tempoExtrasInstalled) return;
  bot.__tempoExtrasInstalled = true;

  bot.command(
    'tempo',
    'Voice controls: join, leave, play, pause, resume',
    async msg => {
      try {
        return await handleTempo(bot, msg);
      } catch (err) {
        console.error('[tempo command]', err);
        const detail = String(err?.message || err || 'unknown error').slice(0, 300);
        return msg.reply(`Tempo voice error: ${detail}`);
      }
    }
  );

  bot.on('voice_leave', async ev => {
    const session = sessions.get(String(ev.server_id));
    if (!session || String(session.channelId) !== String(ev.channel_id)) return;

    try {
      const voice = await bot.voice(ev.server_id);
      const channel = (voice || []).find(item => String(item.channel_id) === String(ev.channel_id));
      const humans = (channel?.user_ids || []).filter(id => String(id) !== String(bot.me?.id));

      if (humans.length === 0) {
        scheduleIdleLeave(bot, ev.server_id);
      }
    } catch (err) {
      console.error('[tempo voice] could not inspect voice channel:', err?.message || err);
    }
  });

  if (TEMPO_OWNER_ID) {
    console.log('[tempo] owner announce enabled');
  } else {
    console.log('[tempo] TEMPO_OWNER_ID not set; /tempo announce disabled');
  }
}

Bot.prototype.start = async function patchedTempoStart(...args) {
  installTempoExtras(this);
  return originalStart.apply(this, args);
};
