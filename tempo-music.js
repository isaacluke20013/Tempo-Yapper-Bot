import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./tempo_voice.py', import.meta.url));
const sessions = new Map();
const IDLE_MS = 5 * 60 * 1000;
const VOICE_CHECK_MS = 30 * 1000;
const MAX_QUEUE = 50;
let trackCounter = 0;

function newTrack(query) {
  return { id: String(++trackCounter), query, title: null, artist: null, duration: null, link: null, probed: false };
}

function timeText(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  const whole = Math.round(Number(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

function trackName(track) {
  return String(track?.title || track?.query || 'Unknown song').slice(0, 170);
}

function trackSummary(track, withLink = false) {
  if (!track) return 'Nothing queued';
  const title = trackName(track);
  const artist = track.artist ? ' — ' + String(track.artist).slice(0, 100) : '';
  const duration = timeText(track.duration);
  const length = duration ? ' (' + duration + ')' : '';
  const link = withLink && track.link ? '\nLink: ' + String(track.link).slice(0, 260) : '';
  return title + artist + length + link;
}

function applyMetadata(track, event) {
  if (!track) return;
  if (event.title) track.title = String(event.title).slice(0, 170);
  if (event.artist) track.artist = String(event.artist).slice(0, 100);
  if (event.duration && Number.isFinite(Number(event.duration))) track.duration = Number(event.duration);
  if (event.link && /^https:\/\//i.test(String(event.link))) track.link = String(event.link).slice(0, 400);
}

function findTrack(session, id) {
  if (session.current && session.current.id === String(id)) return session.current;
  return session.queue.find(track => track.id === String(id));
}

function probeUpcoming(session) {
  if (!session.ready || session.stopping) return;
  for (const track of session.queue.slice(0, 3)) {
    if (track.probed) continue;
    track.probed = control(session, 'probe', { id: track.id, query: track.query });
  }
}

function announceNext(session) {
  const next = session.queue[0];
  if (!next || !next.title || session.lastNextAnnounced === next.id) return;
  session.lastNextAnnounced = next.id;
  void announce(session.bot, session.textChannelId, 'Up next: ' + trackSummary(next, true));
}

function announce(bot, channelId, message) {
  if (!channelId) return Promise.resolve();
  return bot.send(channelId, String(message).slice(0, 1800)).catch(err =>
    console.error('[tempo music] could not send status:', err?.message || err)
  );
}

function clearTimers(session) {
  clearTimeout(session.idleTimer);
  clearInterval(session.voiceTimer);
  clearTimeout(session.firstVoiceCheck);
  clearTimeout(session.readyTimer);
  session.idleTimer = null;
  session.voiceTimer = null;
  session.firstVoiceCheck = null;
  session.readyTimer = null;
}

function control(session, action, fields = {}) {
  if (!session.child.stdin?.writable || session.stopping) return false;
  try {
    session.child.stdin.write(JSON.stringify({ action, ...fields }) + '\n');
    return true;
  } catch (err) {
    console.error('[tempo music] control failed:', err?.message || err);
    return false;
  }
}

function startIdleTimer(session) {
  clearTimeout(session.idleTimer);
  if (session.stopping || sessions.get(session.serverId) !== session || session.current) return;
  session.idleTimer = setTimeout(() => {
    if (sessions.get(session.serverId) !== session || session.current) return;
    void announce(session.bot, session.textChannelId, 'Tempo left voice after 5 minutes with no songs playing.');
    void stopTempoMusic(session.serverId);
  }, IDLE_MS);
  session.idleTimer.unref?.();
}

async function checkVoiceEmpty(session) {
  if (session.stopping || sessions.get(session.serverId) !== session || session.checkingVoice) return;
  session.checkingVoice = true;
  try {
    const voice = await session.bot.voice(session.serverId);
    const room = (voice || []).find(v => String(v.channel_id) === session.channelId);
    // A missing/unknown room is not proof that the channel is empty.
    if (!room || !Array.isArray(room.user_ids)) return;
    const others = room.user_ids.filter(id => String(id) !== String(session.bot.me?.id));
    if (others.length === 0 && sessions.get(session.serverId) === session) {
      await announce(session.bot, session.textChannelId, 'Tempo left voice because everyone left the channel.');
      await stopTempoMusic(session.serverId);
    }
  } catch (err) {
    console.error('[tempo music] voice occupancy check:', err?.message || err);
  } finally {
    session.checkingVoice = false;
  }
}

function watchVoice(session) {
  session.voiceTimer = setInterval(() => { void checkVoiceEmpty(session); }, VOICE_CHECK_MS);
  session.voiceTimer.unref?.();
  session.firstVoiceCheck = setTimeout(() => { void checkVoiceEmpty(session); }, 8000);
  session.firstVoiceCheck.unref?.();
}

function beginTrack(session) {
  if (!session.ready || !session.current || session.stopping) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
  session.currentState = 'loading';
  session.skipPending = null;
  session.lastNextAnnounced = null;
  if (!control(session, 'play', { id: session.current.id, query: session.current.query })) {
    void announce(session.bot, session.textChannelId, 'Tempo could not send the song to its voice worker.');
    void stopTempoMusic(session.serverId);
    return;
  }
  if (session.paused) control(session, 'pause');
  probeUpcoming(session);
}

function advance(session) {
  if (session.stopping || sessions.get(session.serverId) !== session) return;
  session.current = session.queue.shift() || null;
  session.currentState = null;
  session.skipPending = null;
  session.lastNextAnnounced = null;
  if (session.current) {
    beginTrack(session);
  } else {
    startIdleTimer(session);
  }
}

function workerStatus(session, event) {
  if (session.stopping || sessions.get(session.serverId) !== session) return;
  const type = event.type;

  if (type === 'ready') {
    clearTimeout(session.readyTimer);
    session.ready = true;
    watchVoice(session);
    if (session.current) beginTrack(session);
    else startIdleTimer(session);
    return;
  }

  if (type === 'metadata' || type === 'metadata_error') {
    const track = findTrack(session, event.id);
    if (!track) return;
    if (type === 'metadata') {
      applyMetadata(track, event);
      if (session.queue[0]?.id === track.id) announceNext(session);
    } else {
      console.warn('[tempo music] could not preview queued song:', event.message);
    }
    return;
  }

  if (type === 'error') {
    void announce(session.bot, session.textChannelId,
      'Voice connection failed: ' + String(event.message || 'unknown error').slice(0, 300));
    session.reportedError = true;
    void stopTempoMusic(session.serverId);
    return;
  }
  if (type === 'warning') {
    console.warn('[tempo music] worker warning:', event.message);
    return;
  }

  // Every playback event must match the active track; stale events from
  // skipped songs must never advance or rename a later song.
  if (!session.current || String(event.id) !== session.current.id) return;

  if (type === 'resolved') {
    applyMetadata(session.current, event);
  } else if (type === 'playing') {
    applyMetadata(session.current, event);
    session.currentState = session.paused ? 'paused' : 'playing';
    const waiting = session.queue.length;
    void announce(session.bot, session.textChannelId,
      'Now playing in <#' + session.channelId + '>:' +
      '\n' + trackSummary(session.current, true) +
      (waiting ? '\n' + waiting + ' song(s) queued.' : '') +
      '\nUse /tempopause, /temposkip, /tempoqueue or /tempostop.');
    probeUpcoming(session);
    announceNext(session);
  } else if (type === 'finished') {
    advance(session);
  } else if (type === 'skipped') {
    const skipped = trackSummary(session.current);
    advance(session);
    void announce(session.bot, session.textChannelId,
      'Skipped: ' + skipped + '. ' +
      (session.current ? 'Coming up: ' + trackSummary(session.current) : 'Queue empty; leaving after 5 minutes.'));
  } else if (type === 'track_error') {
    void announce(session.bot, session.textChannelId,
      'Could not play ' + trackName(session.current) +
      ': ' + String(event.message || 'unknown audio error').slice(0, 250) +
      '. Skipping to the next song.');
    advance(session);
  }
}

function createSession(bot, serverId, channelId, textChannelId, firstTrack) {
  const key = String(serverId);
  const child = spawn('python3', ['-u', WORKER, key, String(channelId)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });
  const session = {
    bot, serverId: key, channelId: String(channelId), textChannelId,
    child, current: firstTrack, queue: [], paused: false, ready: false,
    stopping: false, checkingVoice: false, reportedError: false,
    skipPending: null, lastNextAnnounced: null,
    currentState: 'connecting', idleTimer: null, voiceTimer: null,
    firstVoiceCheck: null, readyTimer: null
  };
  sessions.set(key, session);
  let output = '';
  let stderr = '';

  child.stdin.on('error', err => {
    if (!session.stopping) console.error('[tempo music] worker stdin:', err?.message || err);
  });
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    let newline;
    while ((newline = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (!line) continue;
      try { workerStatus(session, JSON.parse(line)); }
      catch { console.error('[tempo music] unrecognized worker response:', line.slice(0, 400)); }
    }
    if (output.length > 8192) output = '';
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-1500);
  });
  child.on('error', err => {
    console.error('[tempo music] worker start:', err);
    if (!session.stopping && !session.reportedError) {
      session.reportedError = true;
      void announce(bot, textChannelId, 'Music worker failed to start: ' + String(err.message).slice(0, 300));
    }
    void stopTempoMusic(key);
  });
  child.on('close', (code, signal) => {
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    clearTimers(session);
    if (!session.stopping && !session.reportedError) {
      void announce(bot, textChannelId, 'Music connection ended unexpectedly (' +
        (signal || code) + '). Check Railway logs.');
    }
    if (stderr && !session.stopping) console.error('[tempo music] worker:', stderr);
  });
  session.readyTimer = setTimeout(() => {
    if (sessions.get(key) !== session || session.ready) return;
    void announce(bot, textChannelId, 'Music voice connection timed out. Check Tempo logs.');
    void stopTempoMusic(key);
  }, 60000);
  session.readyTimer.unref?.();
  return session;
}

export function hasTempoMusicSession(serverId) {
  return sessions.has(String(serverId));
}

export function handleTempoVoiceLeave(bot, event) {
  const session = sessions.get(String(event.server_id));
  if (!session || String(event.channel_id) !== session.channelId) return;
  const timer = setTimeout(() => { void checkVoiceEmpty(session); }, 2000);
  timer.unref?.();
}

export async function stopTempoMusic(serverId) {
  const key = String(serverId);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  session.stopping = true;
  session.queue.length = 0;
  session.current = null;
  clearTimers(session);
  const child = session.child;
  try {
    if (child.stdin?.writable) {
      child.stdin.write(JSON.stringify({ action: 'leave' }) + '\n');
      child.stdin.end();
    }
  } catch { /* Fall back to terminating the worker below. */ }
  if (child.exitCode === null && child.signalCode === null) {
    const closed = await Promise.race([
      new Promise(resolve => child.once('close', () => resolve(true))),
      new Promise(resolve => setTimeout(() => resolve(false), 3000))
    ]);
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('close', resolve)),
        new Promise(resolve => setTimeout(resolve, 1500))
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  return true;
}

export function installTempoMusic(bot, helpers) {
  if (bot.__tempoMusicInstalled) return;
  bot.__tempoMusicInstalled = true;

  bot.command('tempoplay', 'Play or queue a song, YouTube video, or Spotify track in voice', async msg => {
    try {
      const query = String(msg.args || '').trim();
      if (!query) return msg.reply('Use /tempoplay <song name [artist]> or /tempoplay <Spotify/YouTube track URL>.');
      if (query.length > 600) return msg.reply('Keep song requests under 600 characters.');
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Run /tempoplay inside a server.');
      const userId = msg.user_id || msg.author_id || msg.user?.id || msg.author?.id;
      if (!userId) return msg.reply('Could not identify who requested this song.');
      const channelId = await helpers.findUserVoiceChannel(bot, serverId, userId);
      if (!channelId) return msg.reply('Join a voice channel first, then use /tempoplay.');

      const key = String(serverId);
      const track = newTrack(query);
      let session = sessions.get(key);
      if (session && session.channelId !== String(channelId)) {
        return msg.reply('Tempo is already in <#' + session.channelId + '>. Join that VC to add songs.');
      }
      if (session) {
        session.textChannelId = msg.channel_id || session.textChannelId;
        if (!session.current) {
          session.current = track;
          beginTrack(session);
          return msg.reply('Playing next: ' + query.slice(0, 180));
        }
        if (session.queue.length >= MAX_QUEUE) return msg.reply('The queue is full (50 upcoming tracks).');
        session.queue.push(track);
        probeUpcoming(session);
        return msg.reply('Queued #' + session.queue.length + ': ' + query.slice(0, 180) +
          '. Looking up title, artist and duration for /tempoqueue.');
      }

      helpers.suspendIdleLeave(serverId);
      session = createSession(bot, key, channelId, msg.channel_id, track);
      return msg.reply('Connecting to voice and looking up: ' + query.slice(0, 180));
    } catch (err) {
      console.error('[tempo music] /tempoplay:', err);
      return msg.reply('Could not queue song: ' + String(err?.message || err).slice(0, 300));
    }
  });

  bot.command('tempoqueue', 'Show now playing, next song details, and the music queue', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Use this command in a server.');
      const session = sessions.get(String(serverId));
      if (!session) return msg.reply('The music queue is empty. Use /tempoplay to add a song.');
      probeUpcoming(session);
      const playing = session.current
        ? 'NOW PLAYING (' + (session.paused ? 'paused' : session.currentState || 'loading') +
          ')\n' + trackSummary(session.current, true)
        : 'NOTHING PLAYING\nLeaving after 5 minutes without music.';
      const next = session.queue[0];
      const upNext = next
        ? 'UP NEXT\n' + trackSummary(next, true) +
          (!next.title ? '\n(Looking up song details...)' : '')
        : 'UP NEXT\n(nothing queued)';
      const rest = session.queue.slice(1, 16).map((song, index) =>
        (index + 2) + '. ' + trackSummary(song)
      );
      return msg.reply(
        'TEMPO MUSIC QUEUE\n\n' + playing + '\n\n' + upNext +
        '\n\nOTHER SONGS (' + Math.max(0, session.queue.length - 1) + ')\n' +
        (rest.length ? rest.join('\n') : '(empty)') +
        (session.queue.length > 16 ? '\n...and ' + (session.queue.length - 16) + ' more.' : '')
      );
    } catch (err) {
      return msg.reply('Could not show queue: ' + String(err?.message || err).slice(0, 250));
    }
  });

  bot.command('tempopause', 'Freeze the currently playing song', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      const session = sessions.get(String(serverId));
      if (!session || !session.current) return msg.reply('No song is playing to pause.');
      if (session.paused) return msg.reply('Already paused. Use /temporesume.');
      session.paused = true;
      session.currentState = 'paused';
      control(session, 'pause');
      return msg.reply('Paused at the current position. Use /temporesume to continue.');
    } catch (err) {
      return msg.reply('Could not pause: ' + String(err?.message || err).slice(0, 240));
    }
  });

  bot.command('temporesume', 'Resume playback where it was paused', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      const session = sessions.get(String(serverId));
      if (!session || !session.current) return msg.reply('No paused track to resume.');
      if (!session.paused) return msg.reply('Tempo is not paused.');
      session.paused = false;
      session.currentState = 'playing';
      control(session, 'resume');
      return msg.reply('Resumed from the paused position.');
    } catch (err) {
      return msg.reply('Could not resume: ' + String(err?.message || err).slice(0, 240));
    }
  });

  bot.command('temposkip', 'Skip the current song and play the next queued song', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Use this command in a server.');
      const session = sessions.get(String(serverId));
      if (!session || !session.current) return msg.reply('There is no song to skip.');
      if (session.skipPending) return msg.reply('Already skipping this song.');
      const old = trackName(session.current);
      session.paused = false;
      if (!session.ready) {
        advance(session);
      } else {
        session.skipPending = session.current.id;
        // Resume before skipping so the following track is not left paused.
        control(session, 'resume');
        if (!control(session, 'skip', { id: session.skipPending })) {
          session.skipPending = null;
          return msg.reply('Could not skip; the voice worker is unavailable.');
        }
      }
      return msg.reply(
        'Skipping: ' + old + '\n' +
        (session.queue.length > 0
          ? 'Next: ' + trackSummary(session.queue[0])
          : session.skipPending ? 'Queue empty after this song.' :
            session.current ? 'Next: ' + trackSummary(session.current) : 'Queue empty; leaving after 5 minutes.')
      );
    } catch (err) {
      return msg.reply('Could not skip: ' + String(err?.message || err).slice(0, 240));
    }
  });

  bot.command('tempostop', 'Stop music, clear the queue, and leave voice', async msg => {
    try {
      const serverId = await helpers.resolveServerId(bot, msg);
      if (!serverId) return msg.reply('Use this inside a server.');
      const stopped = await stopTempoMusic(serverId);
      if (stopped) {
        try { await bot.api('POST', '/servers/' + serverId + '/voice/leave'); }
        catch (err) { console.warn('[tempo music] voice leave:', err?.message || err); }
      }
      return msg.reply(stopped ? 'Stopped playback, cleared the queue, and left voice.' : 'No Tempo music is playing.');
    } catch (err) {
      return msg.reply('Could not stop music: ' + String(err?.message || err).slice(0, 240));
    }
  });

  console.log('[tempo music] /tempoplay /tempoqueue /tempopause /temporesume /temposkip /tempostop installed');
}
