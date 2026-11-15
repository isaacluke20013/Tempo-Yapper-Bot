import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./tempo_voice.py', import.meta.url));
const active = new Map();

function announce(bot, channelId, content) {
  return bot.send(channelId, String(content).slice(0, 1800)).catch(
    err => console.error('[tempo music] status send failed:', err?.message || err)
  );
}

export async function stopTempoMusic(serverId) {
  const key = String(serverId);
  const child = active.get(key);
  if (!child) return false;
  active.delete(key);
  child._tempoStopping = true;
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  return true;
}

export function installTempoMusic(bot, helpers) {
  if (bot.__tempoMusicInstalled) return;
  bot.__tempoMusicInstalled = true;

  bot.command('tempoplay', 'Play a song, YouTube video, or Spotify track in voice', async msg => {
    try {
      const requested = String(msg.args || '').trim();
      if (!requested) return msg.reply('Use /tempoplay <song name [artist]> or /tempoplay <YouTube/Spotify track URL>.');
      if (requested.length > 600) return msg.reply('Keep the song request under 600 characters.');
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Run this in a server while you are in voice.');
      const userId = msg.user_id || msg.author_id || msg.user?.id || msg.author?.id;
      if (!userId) return msg.reply('Could not identify who requested the song.');
      const channelId = await helpers.findUserVoiceChannel(bot, serverId, userId);
      if (!channelId) return msg.reply('Join a voice channel first, then use /tempoplay.');

      await stopTempoMusic(serverId);
      helpers.suspendIdleLeave(serverId);
      const child = spawn('python3', ['-u', WORKER, String(serverId), String(channelId), requested], {
        stdio: ['ignore', 'pipe', 'pipe'], env: process.env
      });
      const key = String(serverId);
      active.set(key, child);
      let output = '';
      let stderr = '';
      let hasReported = false;
      let timedOut = false;

      const timeout = setTimeout(() => {
        if (!hasReported && active.get(key) === child) {
          timedOut = true;
          void announce(bot, msg.channel_id, 'Music lookup/voice connection timed out. Try another song.');
          void stopTempoMusic(key);
        }
      }, 90000);
      timeout.unref?.();

      function onStatus(event) {
        if (child._tempoStopping) return;
        if (event.type === 'playing') {
          clearTimeout(timeout);
          hasReported = true;
          const title = String(event.title || 'your track').slice(0, 160);
          void announce(bot, msg.channel_id, 'Now playing: ' + title + ' in <#' + channelId + '>. Use /tempostop to stop.');
        } else if (event.type === 'error') {
          clearTimeout(timeout);
          hasReported = true;
          void announce(bot, msg.channel_id, 'Could not play that song: ' + String(event.message || 'Unknown error').slice(0, 400));
        } else if (event.type === 'finished') {
          clearTimeout(timeout);
          hasReported = true;
        }
      }

      child.stdout.on('data', chunk => {
        output += chunk.toString();
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (!line) continue;
          try { onStatus(JSON.parse(line)); }
          catch { console.error('[tempo music] unexpected worker output:', line.slice(0, 300)); }
        }
        if (output.length > 4096) output = '';
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
      child.on('error', err => {
        clearTimeout(timeout);
        if (!hasReported && !child._tempoStopping) {
          hasReported = true;
          void announce(bot, msg.channel_id, 'Music worker failed to start: ' + String(err.message).slice(0, 300));
        }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (active.get(key) === child) active.delete(key);
        if (!hasReported && !child._tempoStopping && !timedOut) {
          void announce(bot, msg.channel_id, 'Music stopped before it started (' + (signal || code) + '). Check Railway logs.');
        }
        if (code && stderr && !child._tempoStopping) console.error('[tempo music] worker:', stderr);
      });
      return msg.reply('Looking up your song and connecting to voice...');
    } catch (err) {
      console.error('[tempo music] command:', err);
      return msg.reply('Could not start music: ' + String(err?.message || err).slice(0, 300));
    }
  });

  bot.command('tempostop', 'Stop Tempo music in this server', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Use this inside a server.');
      const stopped = await stopTempoMusic(serverId);
      if (stopped) {
        try { await bot.api('POST', '/servers/' + serverId + '/voice/leave'); }
        catch (err) { console.warn('[tempo music] leave:', err?.message || err); }
      }
      return msg.reply(stopped ? 'Stopped music and left voice.' : 'No Tempo music is playing.');
    } catch (err) {
      return msg.reply('Could not stop music: ' + String(err?.message || err).slice(0, 200));
    }
  });

  console.log('[tempo music] /tempoplay and /tempostop installed');
}
