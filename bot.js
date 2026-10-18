import { Bot, Embed } from './yapper.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const token = process.env.YAPPER_BOT_TOKEN;
const lastfmApiKey = process.env.LASTFM_API_KEY;

if (!token) {
  console.error('Missing YAPPER_BOT_TOKEN');
  process.exit(1);
}

if (!lastfmApiKey) {
  console.error('Missing LASTFM_API_KEY');
  process.exit(1);
}

const bot = new Bot(token);

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_COLOR = '#d51007';
const CACHE_TTL = 5 * 60 * 1000;

// ============================================================
// SAVED DATA
// ============================================================

const DATA_FOLDER = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'YapperLastfmBot'
);

const DATA_FILE = '/data/lastfm-users.json';

function defaultData() {
  return { users: {} };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const fresh = defaultData();

      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(fresh, null, 2)
      );

      return fresh;
    }

    const parsed = JSON.parse(
      fs.readFileSync(
        DATA_FILE,
        'utf8'
      )
    );

    return {
      users:
        parsed.users &&
        typeof parsed.users === 'object'
          ? parsed.users
          : {}
    };
  } catch (err) {
    console.error(
      '[data] could not load saved data:',
      err.message
    );

    return defaultData();
  }
}

const data = loadData();

function saveData() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        data,
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      '[data] could not save data:',
      err.message
    );
  }
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function getContextUserId(context) {
  return (
    context?.user_id ||
    context?.author_id ||
    context?.user?.id ||
    context?.author?.id ||
    null
  );
}

function asArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value)
    ? value
    : [value];
}

function formatNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? new Intl.NumberFormat(
        'en-US'
      ).format(number)
    : String(
        value ?? '0'
      );
}

function trimText(
  value,
  max = 120
) {
  const text =
    String(
      value ?? ''
    ).trim();

  if (
    text.length <= max
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      max - 1
    ) + '…'
  );
}

function stripHtml(
  value = ''
) {
  return String(value)
    .replace(
      /<a\b[^>]*>(.*?)<\/a>/gi,
      '$1'
    )
    .replace(
      /<[^>]+>/g,
      ''
    )
    .replace(
      /&amp;/g,
      '&'
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;|&apos;/g,
      "'"
    )
    .replace(
      /&lt;/g,
      '<'
    )
    .replace(
      /&gt;/g,
      '>'
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function extractMentionedUserId(
  text = ''
) {
  const match =
    String(text).match(
      /<@([^>]+)>/
    );

  return match
    ? match[1]
    : null;
}

function removeMentions(
  text = ''
) {
  return String(text)
    .replace(
      /<@[^>]+>/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function getLinkedUsername(
  userId
) {
  return (
    data.users[
      String(userId)
    ]?.username ||
    null
  );
}

function setLinkedUsername(
  userId,
  username
) {
  data.users[
    String(userId)
  ] = {
    username,

    linkedAt:
      new Date()
        .toISOString()
  };

  saveData();
}

function removeLinkedUsername(
  userId
) {
  delete data.users[
    String(userId)
  ];

  saveData();
}

function profileUrl(
  username
) {
  return (
    'https://www.last.fm/user/' +
    encodeURIComponent(
      username
    )
  );
}

async function getServerId(
  context
) {
  if (
    context?.server_id
  ) {
    return context.server_id;
  }

  try {
    const servers =
      await bot.servers();

    for (
      const server
      of servers
    ) {
      const channels =
        await bot.channels(
          server.id
        );

      if (
        channels.some(
          channel =>
            String(
              channel.id
            ) ===
            String(
              context.channel_id
            )
        )
      ) {
        return server.id;
      }
    }
  } catch (err) {
    console.error(
      '[server] could not resolve server:',
      err.message
    );
  }

  return null;
}

async function linkedUsersInServer(
  serverId
) {
  const results = [];

  for (
    const [
      userId,
      entry
    ]
    of Object.entries(
      data.users
    )
  ) {
    try {
      await bot.member(
        serverId,
        userId
      );

      results.push({
        userId,
        username:
          entry.username
      });
    } catch {
      // User is no longer in this server.
    }
  }

  return results;
}

// ============================================================
// LAST.FM API + CACHE
// ============================================================

async function lastfm(
  method,
  params = {}
) {
  const converted =
    Object.fromEntries(
      Object.entries(
        params
      ).map(
        (
          [key, value]
        ) => [
          key,
          String(value)
        ]
      )
    );

  const search =
    new URLSearchParams({
      method,

      api_key:
        lastfmApiKey,

      format:
        'json',

      ...converted
    });

  const response =
    await fetch(
      `${LASTFM_API}?${search}`,
      {
        headers: {
          'user-agent':
            'Tempo-Yapper-Bot/1.0'
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Last.fm HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (json?.error) {
    const err =
      new Error(
        json.message ||
        `Last.fm error ${json.error}`
      );

    err.lastfmCode =
      json.error;

    throw err;
  }

  return json;
}

const apiCache =
  new Map();

function cacheKey(
  method,
  params
) {
  const sorted =
    Object.keys(params)
      .sort()
      .map(
        key =>
          `${key}=${String(
            params[key]
          ).toLowerCase()}`
      )
      .join('&');

  return (
    `${method.toLowerCase()}?${sorted}`
  );
}

async function cachedLastfm(
  method,
  params = {},
  ttl = CACHE_TTL
) {
  const key =
    cacheKey(
      method,
      params
    );

  const existing =
    apiCache.get(key);

  if (
    existing &&
    Date.now() -
      existing.savedAt <
      ttl
  ) {
    return existing.value;
  }

  const value =
    await lastfm(
      method,
      params
    );

  apiCache.set(
    key,
    {
      value,
      savedAt:
        Date.now()
    }
  );

  return value;
}

async function validateLastfmUser(
  username
) {
  const result =
    await lastfm(
      'user.getInfo',
      {
        user:
          username
      }
    );

  return (
    result?.user ||
    null
  );
}

// ============================================================
// PERIODS + TARGET PARSING
// ============================================================

const PERIODS = {
  overall: {
    api:
      'overall',

    label:
      'All time'
  },

  all: {
    api:
      'overall',

    label:
      'All time'
  },

  '7day': {
    api:
      '7day',

    label:
      'Last 7 days'
  },

  '7d': {
    api:
      '7day',

    label:
      'Last 7 days'
  },

  week: {
    api:
      '7day',

    label:
      'Last 7 days'
  },

  '1month': {
    api:
      '1month',

    label:
      'Last month'
  },

  '1m': {
    api:
      '1month',

    label:
      'Last month'
  },

  month: {
    api:
      '1month',

    label:
      'Last month'
  },

  '3month': {
    api:
      '3month',

    label:
      'Last 3 months'
  },

  '3m': {
    api:
      '3month',

    label:
      'Last 3 months'
  },

  '6month': {
    api:
      '6month',

    label:
      'Last 6 months'
  },

  '6m': {
    api:
      '6month',

    label:
      'Last 6 months'
  },

  '12month': {
    api:
      '12month',

    label:
      'Last 12 months'
  },

  '12m': {
    api:
      '12month',

    label:
      'Last 12 months'
  },

  year: {
    api:
      '12month',

    label:
      'Last 12 months'
  }
};

function parseTargetAndPeriod(
  msg
) {
  const authorId =
    getContextUserId(
      msg
    );

  const raw =
    String(
      msg.args || ''
    ).trim();

  const mentionId =
    extractMentionedUserId(
      raw
    );

  const remaining =
    removeMentions(
      raw
    ).toLowerCase();

  const period =
    remaining
      ? PERIODS[
          remaining
        ]
      : PERIODS.overall;

  return {
    targetId:
      mentionId ||
      authorId,

    authorId,

    period,

    rawPeriod:
      remaining
  };
}

function missingLinkMessage(
  targetId,
  authorId
) {
  if (
    String(
      targetId
    ) ===
    String(
      authorId
    )
  ) {
    return 'you have not linked a Last.fm account yet. use `/lastfm set <username>`.';
  }

  return 'that user has not linked a Last.fm account yet.';
}

// ============================================================
// TRACK HELPERS
// ============================================================

function trackArtist(
  track
) {
  return (
    track?.artist?.name ||
    track?.artist?.[
      '#text'
    ] ||
    'Unknown artist'
  );
}

function trackAlbum(
  track
) {
  return (
    track?.album?.[
      '#text'
    ] ||
    track?.album?.name ||
    ''
  );
}

function trackName(
  track
) {
  return (
    track?.name ||
    'Unknown track'
  );
}

function isNowPlaying(
  track
) {
  return (
    String(
      track?.[
        '@attr'
      ]?.nowplaying ||
      ''
    ).toLowerCase() ===
    'true'
  );
}

function trackWhen(
  track
) {
  if (
    isNowPlaying(
      track
    )
  ) {
    return 'now';
  }

  const uts =
    Number(
      track?.date?.uts
    );

  if (
    Number.isFinite(
      uts
    ) &&
    uts > 0
  ) {
    return new Date(
      uts * 1000
    ).toLocaleString(
      'en-US',
      {
        month:
          'short',

        day:
          'numeric',

        hour:
          'numeric',

        minute:
          '2-digit'
      }
    );
  }

  return (
    track?.date?.[
      '#text'
    ] ||
    'recently'
  );
}

async function getTopArtists(
  username,
  period = 'overall',
  limit = 50
) {
  const result =
    await cachedLastfm(
      'user.getTopArtists',
      {
        user:
          username,

        period,

        limit
      }
    );

  return asArray(
    result
      ?.topartists
      ?.artist
  );
}

// ============================================================
// /LASTFM
// ============================================================

bot.command(
  'lastfm',
  'Link or manage your Last.fm account',
  async msg => {
    const userId =
      getContextUserId(
        msg
      );

    if (!userId) {
      return msg.reply(
        "couldn't figure out who ran the command."
      );
    }

    const raw =
      String(
        msg.args || ''
      ).trim();

    const [
      subRaw,
      ...rest
    ] =
      raw.split(
        /\s+/
      );

    const sub =
      (
        subRaw ||
        'status'
      ).toLowerCase();

    if (
      sub === 'set' ||
      sub === 'link'
    ) {
      const username =
        rest
          .join(' ')
          .trim();

      if (!username) {
        return msg.reply(
          'use `/lastfm set <username>`.'
        );
      }

      try {
        const user =
          await validateLastfmUser(
            username
          );

        const canonical =
          user?.name ||
          username;

        setLinkedUsername(
          userId,
          canonical
        );

        return msg.reply(
          `linked your Yapper account to **${canonical}** on Last.fm.`
        );
      } catch (err) {
        console.error(
          '[lastfm set]',
          err.message
        );

        return msg.reply(
          `couldn't link **${username}**. double-check the Last.fm username and try again.`
        );
      }
    }

    if (
      sub === 'remove' ||
      sub === 'unlink'
    ) {
      const current =
        getLinkedUsername(
          userId
        );

      if (!current) {
        return msg.reply(
          'you do not have a Last.fm account linked.'
        );
      }

      removeLinkedUsername(
        userId
      );

      return msg.reply(
        `unlinked **${current}**.`
      );
    }

    if (
      sub === 'status' ||
      sub === 'show' ||
      !raw
    ) {
      const current =
        getLinkedUsername(
          userId
        );

      if (!current) {
        return msg.reply(
          'you have not linked Last.fm yet. use `/lastfm set <username>`.'
        );
      }

      return msg.reply(
        `your linked Last.fm account is **${current}**.\n${profileUrl(
          current
        )}`
      );
    }

    return msg.reply(
`**Last.fm account commands**

\`/lastfm set <username>\` — link
\`/lastfm remove\` — unlink
\`/lastfm status\` — show linked account`
    );
  }
);

// ============================================================
// /FM
// ============================================================

bot.command(
  'fm',
  'Show what you or another linked user is listening to',
  async msg => {
    const {
      targetId,
      authorId
    } =
      parseTargetAndPeriod(
        msg
      );

    const username =
      getLinkedUsername(
        targetId
      );

    if (!username) {
      return msg.reply(
        missingLinkMessage(
          targetId,
          authorId
        )
      );
    }

    try {
      const result =
        await lastfm(
          'user.getRecentTracks',
          {
            user:
              username,

            limit:
              1,

            extended:
              1
          }
        );

      const track =
        asArray(
          result
            ?.recenttracks
            ?.track
        )[0];

      if (!track) {
        return msg.reply(
          `**${username}** has no recent scrobbles.`
        );
      }

      const now =
        isNowPlaying(
          track
        );

      const album =
        trackAlbum(
          track
        );

      const url =
        track.url ||
        profileUrl(
          username
        );

      const embed =
        new Embed()
          .title(
            now
              ? 'Now Playing'
              : 'Last Played'
          )
          .url(
            url
          )
          .description(
            `**${trimText(
              trackName(
                track
              ),
              180
            )}**\n` +
            `${trimText(
              trackArtist(
                track
              ),
              180
            )}` +
            (
              album
                ? `\n*${trimText(
                    album,
                    180
                  )}*`
                : ''
            )
          )
          .color(
            LASTFM_COLOR
          )
          .footer(
            `${username} • Last.fm${
              now
                ? ' • listening now'
                : ` • ${trackWhen(
                    track
                  )}`
            }`
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[fm]',
        err.message
      );

      return msg.reply(
        "couldn't get that user's current track from Last.fm."
      );
    }
  }
);

// ============================================================
// /RECENT
// ============================================================

bot.command(
  'recent',
  'Show recent Last.fm tracks',
  async msg => {
    const {
      targetId,
      authorId
    } =
      parseTargetAndPeriod(
        msg
      );

    const username =
      getLinkedUsername(
        targetId
      );

    if (!username) {
      return msg.reply(
        missingLinkMessage(
          targetId,
          authorId
        )
      );
    }

    try {
      const result =
        await lastfm(
          'user.getRecentTracks',
          {
            user:
              username,

            limit:
              10,

            extended:
              1
          }
        );

      const tracks =
        asArray(
          result
            ?.recenttracks
            ?.track
        ).slice(
          0,
          10
        );

      if (!tracks.length) {
        return msg.reply(
          `**${username}** has no recent scrobbles.`
        );
      }

      const lines =
        tracks.map(
          (
            track,
            index
          ) => {
            const marker =
              isNowPlaying(
                track
              )
                ? ' • **now**'
                : ` • ${trackWhen(
                    track
                  )}`;

            return (
              `**${index + 1}.** ` +
              `${trimText(
                trackName(
                  track
                ),
                90
              )} — ` +
              `${trimText(
                trackArtist(
                  track
                ),
                90
              )}` +
              marker
            );
          }
        );

      const embed =
        new Embed()
          .title(
            `${username}'s Recent Tracks`
          )
          .url(
            profileUrl(
              username
            )
          )
          .description(
            lines.join(
              '\n'
            )
          )
          .color(
            LASTFM_COLOR
          )
          .footer(
            'Last.fm'
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[recent]',
        err.message
      );

      return msg.reply(
        "couldn't get recent tracks from Last.fm."
      );
    }
  }
);

// ============================================================
// TOP LISTS
// ============================================================

async function sendTopList(
  msg,
  type
) {
  const {
    targetId,
    authorId,
    period,
    rawPeriod
  } =
    parseTargetAndPeriod(
      msg
    );

  if (!period) {
    return msg.reply(
      `unknown time period **${rawPeriod}**. use: \`7d\`, \`1m\`, \`3m\`, \`6m\`, \`12m\`, or \`overall\`.`
    );
  }

  const username =
    getLinkedUsername(
      targetId
    );

  if (!username) {
    return msg.reply(
      missingLinkMessage(
        targetId,
        authorId
      )
    );
  }

  const configs = {
    artists: {
      method:
        'user.getTopArtists',

      root:
        'topartists',

      item:
        'artist',

      title:
        'Top Artists',

      format:
        item =>
          `${trimText(
            item.name,
            110
          )} — **${formatNumber(
            item.playcount
          )}** plays`
    },

    tracks: {
      method:
        'user.getTopTracks',

      root:
        'toptracks',

      item:
        'track',

      title:
        'Top Tracks',

      format:
        item =>
          `${trimText(
            item.name,
            95
          )} — ${trimText(
            item.artist
              ?.name ||
            'Unknown artist',
            85
          )} — **${formatNumber(
            item.playcount
          )}** plays`
    },

    albums: {
      method:
        'user.getTopAlbums',

      root:
        'topalbums',

      item:
        'album',

      title:
        'Top Albums',

      format:
        item =>
          `${trimText(
            item.name,
            95
          )} — ${trimText(
            item.artist
              ?.name ||
            'Unknown artist',
            85
          )} — **${formatNumber(
            item.playcount
          )}** plays`
    }
  };

  const config =
    configs[type];

  try {
    const result =
      await lastfm(
        config.method,
        {
          user:
            username,

          period:
            period.api,

          limit:
            10
        }
      );

    const items =
      asArray(
        result
          ?.[config.root]
          ?.[config.item]
      ).slice(
        0,
        10
      );

    if (!items.length) {
      return msg.reply(
        `no ${config.title.toLowerCase()} found for **${username}** in that period.`
      );
    }

    const lines =
      items.map(
        (
          item,
          index
        ) =>
          `**${index + 1}.** ${config.format(
            item
          )}`
      );

    const embed =
      new Embed()
        .title(
          `${username}'s ${config.title} — ${period.label}`
        )
        .url(
          profileUrl(
            username
          )
        )
        .description(
          lines.join(
            '\n'
          )
        )
        .color(
          LASTFM_COLOR
        )
        .footer(
          'Last.fm'
        );

    return msg.reply(
      '',
      {
        embeds:
          [embed]
      }
    );
  } catch (err) {
    console.error(
      `[${type}]`,
      err.message
    );

    return msg.reply(
      `couldn't get ${config.title.toLowerCase()} from Last.fm.`
    );
  }
}

bot.command(
  'topartists',
  'Show top Last.fm artists',
  msg =>
    sendTopList(
      msg,
      'artists'
    )
);

bot.command(
  'toptracks',
  'Show top Last.fm tracks',
  msg =>
    sendTopList(
      msg,
      'tracks'
    )
);

bot.command(
  'topalbums',
  'Show top Last.fm albums',
  msg =>
    sendTopList(
      msg,
      'albums'
    )
);

// ============================================================
// /PROFILE
// ============================================================

bot.command(
  'profile',
  'Show a linked Last.fm profile',
  async msg => {
    const {
      targetId,
      authorId
    } =
      parseTargetAndPeriod(
        msg
      );

    const username =
      getLinkedUsername(
        targetId
      );

    if (!username) {
      return msg.reply(
        missingLinkMessage(
          targetId,
          authorId
        )
      );
    }

    try {
      const result =
        await lastfm(
          'user.getInfo',
          {
            user:
              username
          }
        );

      const user =
        result?.user;

      if (!user) {
        return msg.reply(
          "couldn't find that Last.fm profile."
        );
      }

      const registeredUnix =
        Number(
          user
            ?.registered
            ?.unixtime
        );

      const registered =
        Number.isFinite(
          registeredUnix
        ) &&
        registeredUnix > 0
          ? new Date(
              registeredUnix *
              1000
            ).toLocaleDateString(
              'en-US',
              {
                year:
                  'numeric',

                month:
                  'short',

                day:
                  'numeric'
              }
            )
          : 'Unknown';

      const embed =
        new Embed()
          .title(
            `${user.name} on Last.fm`
          )
          .url(
            user.url ||
            profileUrl(
              username
            )
          )
          .color(
            LASTFM_COLOR
          )
          .field(
            'Scrobbles',
            formatNumber(
              user.playcount
            ),
            true
          )
          .field(
            'Artists',
            formatNumber(
              user.artist_count ||
              0
            ),
            true
          )
          .field(
            'Tracks',
            formatNumber(
              user.track_count ||
              0
            ),
            true
          )
          .field(
            'Albums',
            formatNumber(
              user.album_count ||
              0
            ),
            true
          )
          .field(
            'Country',
            user.country ||
            'Not set',
            true
          )
          .field(
            'Registered',
            registered,
            true
          )
          .footer(
            'Last.fm'
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[profile]',
        err.message
      );

      return msg.reply(
        "couldn't get that Last.fm profile."
      );
    }
  }
);

// ============================================================
// /SCROBBLES
// ============================================================

bot.command(
  'scrobbles',
  'Show total Last.fm scrobbles and listening average',
  async msg => {
    const {
      targetId,
      authorId
    } =
      parseTargetAndPeriod(
        msg
      );

    const username =
      getLinkedUsername(
        targetId
      );

    if (!username) {
      return msg.reply(
        missingLinkMessage(
          targetId,
          authorId
        )
      );
    }

    try {
      const result =
        await cachedLastfm(
          'user.getInfo',
          {
            user:
              username
          }
        );

      const user =
        result?.user;

      const total =
        Number(
          user?.playcount ||
          0
        );

      const registeredUnix =
        Number(
          user
            ?.registered
            ?.unixtime ||
          0
        );

      let average =
        'Unknown';

      let accountAge =
        'Unknown';

      if (
        registeredUnix >
        0
      ) {
        const days =
          Math.max(
            1,
            Math.floor(
              (
                Date.now() -
                registeredUnix *
                  1000
              ) /
              86400000
            )
          );

        average =
          (
            total /
            days
          ).toFixed(1);

        accountAge =
          `${formatNumber(
            days
          )} days`;
      }

      const embed =
        new Embed()
          .title(
            `${username}'s Scrobbles`
          )
          .url(
            user?.url ||
            profileUrl(
              username
            )
          )
          .color(
            LASTFM_COLOR
          )
          .field(
            'Total scrobbles',
            formatNumber(
              total
            ),
            true
          )
          .field(
            'Average / day',
            average,
            true
          )
          .field(
            'Account age',
            accountAge,
            true
          )
          .footer(
            'Last.fm'
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[scrobbles]',
        err.message
      );

      return msg.reply(
        "couldn't get scrobble stats from Last.fm."
      );
    }
  }
);

// ============================================================
// /PLAYS
// ============================================================

bot.command(
  'plays',
  'Show how many times you have played an artist',
  async msg => {
    const userId =
      getContextUserId(
        msg
      );

    const username =
      getLinkedUsername(
        userId
      );

    const artistQuery =
      String(
        msg.args || ''
      ).trim();

    if (!username) {
      return msg.reply(
        'link Last.fm first with `/lastfm set <username>`.'
      );
    }

    if (!artistQuery) {
      return msg.reply(
        'use `/plays <artist>`.'
      );
    }

    try {
      const result =
        await cachedLastfm(
          'artist.getInfo',
          {
            artist:
              artistQuery,

            username,

            autocorrect:
              1
          }
        );

      const artist =
        result?.artist;

      if (!artist) {
        return msg.reply(
          "couldn't find that artist."
        );
      }

      const userPlays =
        Number(
          artist
            ?.stats
            ?.userplaycount ||
          0
        );

      const top100 =
        await getTopArtists(
          username,
          'overall',
          100
        );

      const rankIndex =
        top100.findIndex(
          item =>
            String(
              item.name
            ).toLowerCase() ===
            String(
              artist.name
            ).toLowerCase()
        );

      const rankText =
        rankIndex >= 0
          ? `\nAll-time rank: **#${rankIndex + 1}**`
          : '';

      return msg.reply(
        `**${username}** has **${formatNumber(
          userPlays
        )}** plays for **${artist.name}**.${rankText}`
      );
    } catch (err) {
      console.error(
        '[plays]',
        err.message
      );

      return msg.reply(
        "couldn't get your play count for that artist."
      );
    }
  }
);

// ============================================================
// /ARTIST
// ============================================================

bot.command(
  'artist',
  'Show Last.fm artist info and your play count',
  async msg => {
    const userId =
      getContextUserId(
        msg
      );

    const username =
      getLinkedUsername(
        userId
      );

    const artistQuery =
      String(
        msg.args || ''
      ).trim();

    if (!artistQuery) {
      return msg.reply(
        'use `/artist <artist>`.'
      );
    }

    try {
      const params = {
        artist:
          artistQuery,

        autocorrect:
          1
      };

      if (username) {
        params.username =
          username;
      }

      const result =
        await cachedLastfm(
          'artist.getInfo',
          params
        );

      const artist =
        result?.artist;

      if (!artist) {
        return msg.reply(
          "couldn't find that artist."
        );
      }

      const tags =
        asArray(
          artist
            ?.tags
            ?.tag
        )
          .slice(
            0,
            5
          )
          .map(
            tag =>
              tag.name
          )
          .filter(
            Boolean
          )
          .join(', ');

      const bio =
        trimText(
          stripHtml(
            artist
              ?.bio
              ?.summary ||
            ''
          ),
          450
        );

      const embed =
        new Embed()
          .title(
            artist.name
          )
          .url(
            artist.url
          )
          .color(
            LASTFM_COLOR
          )
          .field(
            'Listeners',
            formatNumber(
              artist
                ?.stats
                ?.listeners ||
              0
            ),
            true
          )
          .field(
            'Global scrobbles',
            formatNumber(
              artist
                ?.stats
                ?.playcount ||
              0
            ),
            true
          );

      if (username) {
        embed.field(
          'Your plays',
          formatNumber(
            artist
              ?.stats
              ?.userplaycount ||
            0
          ),
          true
        );
      }

      if (tags) {
        embed.field(
          'Tags',
          tags,
          false
        );
      }

      if (bio) {
        embed.description(
          bio
        );
      }

      embed.footer(
        'Last.fm'
      );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[artist]',
        err.message
      );

      return msg.reply(
        "couldn't get info for that artist."
      );
    }
  }
);

// ============================================================
// /TRACK
// ============================================================

bot.command(
  'track',
  'Show Last.fm track info and your play count',
  async msg => {
    const userId =
      getContextUserId(
        msg
      );

    const username =
      getLinkedUsername(
        userId
      );

    const raw =
      String(
        msg.args || ''
      ).trim();

    const divider =
      raw.indexOf(
        ' - '
      );

    if (
      divider ===
      -1
    ) {
      return msg.reply(
        'use `/track <artist> - <track>`.'
      );
    }

    const artistQuery =
      raw
        .slice(
          0,
          divider
        )
        .trim();

    const trackQuery =
      raw
        .slice(
          divider + 3
        )
        .trim();

    if (
      !artistQuery ||
      !trackQuery
    ) {
      return msg.reply(
        'use `/track <artist> - <track>`.'
      );
    }

    try {
      const params = {
        artist:
          artistQuery,

        track:
          trackQuery,

        autocorrect:
          1
      };

      if (username) {
        params.username =
          username;
      }

      const result =
        await cachedLastfm(
          'track.getInfo',
          params
        );

      const track =
        result?.track;

      if (!track) {
        return msg.reply(
          "couldn't find that track."
        );
      }

      const durationMs =
        Number(
          track.duration ||
          0
        );

      const duration =
        durationMs > 0
          ? `${Math.floor(
              durationMs /
              60000
            )}:${String(
              Math.floor(
                (
                  durationMs %
                  60000
                ) /
                1000
              )
            ).padStart(
              2,
              '0'
            )}`
          : 'Unknown';

      const embed =
        new Embed()
          .title(
            `${track.name} — ${track?.artist?.name || artistQuery}`
          )
          .url(
            track.url
          )
          .color(
            LASTFM_COLOR
          )
          .field(
            'Listeners',
            formatNumber(
              track.listeners ||
              0
            ),
            true
          )
          .field(
            'Global scrobbles',
            formatNumber(
              track.playcount ||
              0
            ),
            true
          )
          .field(
            'Duration',
            duration,
            true
          );

      if (username) {
        embed.field(
          'Your plays',
          formatNumber(
            track.userplaycount ||
            0
          ),
          true
        );

        embed.field(
          'Loved',
          String(
            track.userloved ||
            '0'
          ) === '1'
            ? 'Yes'
            : 'No',
          true
        );
      }

      if (
        track
          ?.album
          ?.title
      ) {
        embed.field(
          'Album',
          track.album.title,
          false
        );
      }

      embed.footer(
        'Last.fm'
      );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[track]',
        err.message
      );

      return msg.reply(
        "couldn't get info for that track."
      );
    }
  }
);

// ============================================================
// COMPARE / TASTE HELPERS
// ============================================================

async function buildTasteComparison(
  userA,
  userB
) {
  const [
    artistsA,
    artistsB
  ] =
    await Promise.all([
      getTopArtists(
        userA,
        'overall',
        50
      ),

      getTopArtists(
        userB,
        'overall',
        50
      )
    ]);

  const mapB =
    new Map(
      artistsB.map(
        (
          artist,
          index
        ) => [
          String(
            artist.name
          ).toLowerCase(),

          {
            ...artist,
            rank:
              index + 1
          }
        ]
      )
    );

  const shared =
    artistsA
      .map(
        (
          artist,
          index
        ) => {
          const other =
            mapB.get(
              String(
                artist.name
              ).toLowerCase()
            );

          if (!other) {
            return null;
          }

          return {
            name:
              artist.name,

            rankA:
              index + 1,

            rankB:
              other.rank,

            combinedRank:
              index +
              1 +
              other.rank
          };
        }
      )
      .filter(
        Boolean
      )
      .sort(
        (
          a,
          b
        ) =>
          a.combinedRank -
          b.combinedRank
      );

  const denominator =
    Math.max(
      1,
      Math.min(
        artistsA.length,
        artistsB.length
      )
    );

  const match =
    Math.round(
      (
        shared.length /
        denominator
      ) *
      100
    );

  return {
    shared,
    match,
    artistsA,
    artistsB
  };
}

// ============================================================
// /COMPARE
// ============================================================

bot.command(
  'compare',
  'Compare your Last.fm taste with another linked user',
  async msg => {
    const authorId =
      getContextUserId(
        msg
      );

    const targetId =
      extractMentionedUserId(
        msg.args
      );

    if (!targetId) {
      return msg.reply(
        'use `/compare @user`.'
      );
    }

    if (
      String(
        authorId
      ) ===
      String(
        targetId
      )
    ) {
      return msg.reply(
        "you can't compare yourself with yourself 😭"
      );
    }

    const userA =
      getLinkedUsername(
        authorId
      );

    const userB =
      getLinkedUsername(
        targetId
      );

    if (!userA) {
      return msg.reply(
        'link Last.fm first with `/lastfm set <username>`.'
      );
    }

    if (!userB) {
      return msg.reply(
        'that user has not linked a Last.fm account yet.'
      );
    }

    try {
      const [
        {
          shared,
          match
        },

        infoA,

        infoB
      ] =
        await Promise.all([
          buildTasteComparison(
            userA,
            userB
          ),

          cachedLastfm(
            'user.getInfo',
            {
              user:
                userA
            }
          ),

          cachedLastfm(
            'user.getInfo',
            {
              user:
                userB
            }
          )
        ]);

      const sharedText =
        shared.length
          ? shared
              .slice(
                0,
                10
              )
              .map(
                item =>
                  `• ${item.name}`
              )
              .join(
                '\n'
              )
          : 'No shared artists in your top 50.';

      const embed =
        new Embed()
          .title(
            `${userA} × ${userB}`
          )
          .description(
            `**Tempo match: ${match}%**\n\n` +
            `**Shared top artists**\n${sharedText}`
          )
          .color(
            LASTFM_COLOR
          )
          .field(
            userA,
            `${formatNumber(
              infoA
                ?.user
                ?.playcount ||
              0
            )} scrobbles`,
            true
          )
          .field(
            userB,
            `${formatNumber(
              infoB
                ?.user
                ?.playcount ||
              0
            )} scrobbles`,
            true
          )
          .footer(
            'Match is based on overlap between both users’ top 50 all-time artists.'
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[compare]',
        err.message
      );

      return msg.reply(
        "couldn't compare those accounts right now."
      );
    }
  }
);

// ============================================================
// /TASTE
// ============================================================

bot.command(
  'taste',
  'Check music compatibility with another linked user',
  async msg => {
    const authorId =
      getContextUserId(
        msg
      );

    const targetId =
      extractMentionedUserId(
        msg.args
      );

    if (!targetId) {
      return msg.reply(
        'use `/taste @user`.'
      );
    }

    const userA =
      getLinkedUsername(
        authorId
      );

    const userB =
      getLinkedUsername(
        targetId
      );

    if (!userA) {
      return msg.reply(
        'link Last.fm first with `/lastfm set <username>`.'
      );
    }

    if (!userB) {
      return msg.reply(
        'that user has not linked a Last.fm account yet.'
      );
    }

    try {
      const {
        shared,
        match
      } =
        await buildTasteComparison(
          userA,
          userB
        );

      const favorites =
        shared
          .slice(
            0,
            5
          )
          .map(
            item =>
              item.name
          );

      let label =
        'different worlds';

      if (
        match >= 75
      ) {
        label =
          'basically sharing headphones';
      } else if (
        match >= 50
      ) {
        label =
          'very compatible';
      } else if (
        match >= 30
      ) {
        label =
          'some solid overlap';
      } else if (
        match >= 15
      ) {
        label =
          'a little overlap';
      }

      return msg.reply(
`**${userA} × ${userB}**
Tempo match: **${match}%** — ${label}
${favorites.length
  ? `Shared favorites: **${favorites.join(', ')}**`
  : 'No shared artists in your top 50.'}`
      );
    } catch (err) {
      console.error(
        '[taste]',
        err.message
      );

      return msg.reply(
        "couldn't compare your music taste right now."
      );
    }
  }
);

// ============================================================
// /WHOKNOWS
// ============================================================

bot.command(
  'whoknows',
  'Rank linked server members by plays for an artist',
  async msg => {
    const artistQuery =
      String(
        msg.args || ''
      ).trim();

    if (!artistQuery) {
      return msg.reply(
        'use `/whoknows <artist>`.'
      );
    }

    const serverId =
      await getServerId(
        msg
      );

    if (!serverId) {
      return msg.reply(
        '`/whoknows` only works inside a server.'
      );
    }

    const linked =
      await linkedUsersInServer(
        serverId
      );

    if (!linked.length) {
      return msg.reply(
        'nobody in this server has linked Last.fm yet.'
      );
    }

    try {
      const results = [];

      let correctedArtist =
        artistQuery;

      for (
        const person
        of linked.slice(
          0,
          50
        )
      ) {
        try {
          const result =
            await cachedLastfm(
              'artist.getInfo',
              {
                artist:
                  artistQuery,

                username:
                  person.username,

                autocorrect:
                  1
              }
            );

          const artist =
            result?.artist;

          if (
            artist?.name
          ) {
            correctedArtist =
              artist.name;
          }

          results.push({
            userId:
              person.userId,

            username:
              person.username,

            plays:
              Number(
                artist
                  ?.stats
                  ?.userplaycount ||
                0
              )
          });
        } catch (err) {
          console.error(
            `[whoknows:${person.username}]`,
            err.message
          );
        }
      }

      results.sort(
        (
          a,
          b
        ) =>
          b.plays -
          a.plays
      );

      const ranked =
        results
          .filter(
            item =>
              item.plays >
              0
          )
          .slice(
            0,
            10
          );

      if (!ranked.length) {
        return msg.reply(
          `none of the linked users in this server have scrobbled **${correctedArtist}**.`
        );
      }

      const medals = [
        '🥇',
        '🥈',
        '🥉'
      ];

      const lines =
        ranked.map(
          (
            item,
            index
          ) =>
            `${medals[index] || `**${index + 1}.**`} <@${item.userId}> — **${formatNumber(
              item.plays
            )}** plays`
        );

      const embed =
        new Embed()
          .title(
            `Who Knows ${correctedArtist}?`
          )
          .description(
            lines.join(
              '\n'
            )
          )
          .color(
            LASTFM_COLOR
          )
          .footer(
            `Based on ${results.length} linked server member${results.length === 1 ? '' : 's'}.`
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[whoknows]',
        err.message
      );

      return msg.reply(
        "couldn't build that server ranking right now."
      );
    }
  }
);

// ============================================================
// /SERVERTOP
// ============================================================

bot.command(
  'servertop',
  'Show the server’s combined top artists',
  async msg => {
    const serverId =
      await getServerId(
        msg
      );

    if (!serverId) {
      return msg.reply(
        '`/servertop` only works inside a server.'
      );
    }

    const periodRaw =
      String(
        msg.args || ''
      )
        .trim()
        .toLowerCase();

    const period =
      periodRaw
        ? PERIODS[
            periodRaw
          ]
        : PERIODS[
            '7d'
          ];

    if (!period) {
      return msg.reply(
        'use `7d`, `1m`, `3m`, `6m`, `12m`, or `overall`.'
      );
    }

    const linked =
      await linkedUsersInServer(
        serverId
      );

    if (!linked.length) {
      return msg.reply(
        'nobody in this server has linked Last.fm yet.'
      );
    }

    try {
      const totals =
        new Map();

      let counted = 0;

      for (
        const person
        of linked.slice(
          0,
          50
        )
      ) {
        try {
          const artists =
            await getTopArtists(
              person.username,
              period.api,
              50
            );

          counted += 1;

          for (
            const artist
            of artists
          ) {
            const key =
              String(
                artist.name
              ).toLowerCase();

            const existing =
              totals.get(
                key
              ) || {
                name:
                  artist.name,

                plays:
                  0,

                listeners:
                  0
              };

            existing.plays +=
              Number(
                artist.playcount ||
                0
              );

            existing.listeners +=
              1;

            totals.set(
              key,
              existing
            );
          }
        } catch (err) {
          console.error(
            `[servertop:${person.username}]`,
            err.message
          );
        }
      }

      const top =
        [
          ...totals.values()
        ]
          .sort(
            (
              a,
              b
            ) =>
              b.plays -
              a.plays
          )
          .slice(
            0,
            10
          );

      if (!top.length) {
        return msg.reply(
          'not enough Last.fm data to build a server top yet.'
        );
      }

      const lines =
        top.map(
          (
            artist,
            index
          ) =>
            `**${index + 1}.** ${artist.name} — **${formatNumber(
              artist.plays
            )}** plays`
        );

      const embed =
        new Embed()
          .title(
            `Server Top Artists — ${period.label}`
          )
          .description(
            lines.join(
              '\n'
            )
          )
          .color(
            LASTFM_COLOR
          )
          .footer(
            `Combined from ${counted} linked member${counted === 1 ? '' : 's'} • based on each member’s top 50 artists`
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[servertop]',
        err.message
      );

      return msg.reply(
        "couldn't build the server top right now."
      );
    }
  }
);

// ============================================================
// /WEEKLY
// ============================================================

bot.command(
  'weekly',
  'Show the latest Last.fm weekly artist chart',
  async msg => {
    const {
      targetId,
      authorId
    } =
      parseTargetAndPeriod(
        msg
      );

    const username =
      getLinkedUsername(
        targetId
      );

    if (!username) {
      return msg.reply(
        missingLinkMessage(
          targetId,
          authorId
        )
      );
    }

    try {
      const result =
        await cachedLastfm(
          'user.getWeeklyArtistChart',
          {
            user:
              username
          }
        );

      const artists =
        asArray(
          result
            ?.weeklyartistchart
            ?.artist
        ).slice(
          0,
          10
        );

      const attr =
        result
          ?.weeklyartistchart
          ?.[
            '@attr'
          ] || {};

      if (!artists.length) {
        return msg.reply(
          `**${username}** does not have a weekly chart yet.`
        );
      }

      const lines =
        artists.map(
          (
            artist,
            index
          ) =>
            `**${index + 1}.** ${artist.name} — **${formatNumber(
              artist.playcount
            )}** plays`
        );

      let range =
        'Latest weekly chart';

      const from =
        Number(
          attr.from ||
          0
        );

      const to =
        Number(
          attr.to ||
          0
        );

      if (
        from > 0 &&
        to > 0
      ) {
        const fromText =
          new Date(
            from *
            1000
          ).toLocaleDateString(
            'en-US',
            {
              month:
                'short',

              day:
                'numeric'
            }
          );

        const toText =
          new Date(
            to *
            1000
          ).toLocaleDateString(
            'en-US',
            {
              month:
                'short',

              day:
                'numeric',

              year:
                'numeric'
            }
          );

        range =
          `${fromText} – ${toText}`;
      }

      const embed =
        new Embed()
          .title(
            `${username}'s Weekly Artists`
          )
          .url(
            profileUrl(
              username
            )
          )
          .description(
            lines.join(
              '\n'
            )
          )
          .color(
            LASTFM_COLOR
          )
          .footer(
            `${range} • Last.fm`
          );

      return msg.reply(
        '',
        {
          embeds:
            [embed]
        }
      );
    } catch (err) {
      console.error(
        '[weekly]',
        err.message
      );

      return msg.reply(
        "couldn't get that weekly chart from Last.fm."
      );
    }
  }
);

// ============================================================
// /MUSICHELP
// ============================================================

bot.command(
  'musichelp',
  'Show Tempo commands',
  msg => {
    return msg.reply(
`**Tempo commands**

**Account**
\`/lastfm set <username>\` — link your Last.fm
\`/lastfm remove\` — unlink it
\`/lastfm status\` — show your linked account

**Listening**
\`/fm\` — current / last played track
\`/recent\` — 10 recent tracks
\`/profile\` — Last.fm profile
\`/scrobbles\` — total scrobbles + daily average
\`/weekly\` — latest weekly artist chart

**Top lists**
\`/topartists [period]\`
\`/toptracks [period]\`
\`/topalbums [period]\`

**Artists + tracks**
\`/plays <artist>\` — your plays for an artist
\`/artist <artist>\` — artist info + your plays
\`/track <artist> - <track>\` — track info + your plays

**Social**
\`/compare @user\` — detailed taste comparison
\`/taste @user\` — quick compatibility
\`/whoknows <artist>\` — server artist leaderboard
\`/servertop [period]\` — combined server top artists

You can use \`@user\` with \`/fm\`, \`/recent\`, \`/profile\`, \`/scrobbles\`, \`/weekly\`, and the top-list commands.

**Periods:** \`7d\`, \`1m\`, \`3m\`, \`6m\`, \`12m\`, \`overall\``
    );
  }
);

// ============================================================
// READY
// ============================================================

bot.on(
  'ready',
  async me => {
    console.log(
      `[tempo] logged in as ${me.username}`
    );

    try {
      await bot.setStatus(
        'online',
        'scrobbling'
      );
    } catch (err) {
      console.error(
        '[status]',
        err.message
      );
    }
  }
);

bot.on(
  'error',
  err => {
    console.error(
      '[tempo]',
      err
    );
  }
);

bot.start().catch(
  err => {
    console.error(
      '[yapper] could not start:',
      err.message
    );

    process.exit(1);
  }
);
