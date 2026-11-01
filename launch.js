import fs from 'node:fs';
import './tempo-extra.js';

const botUrl = new URL('./bot.js', import.meta.url);
const runtimeUrl = new URL('./bot.runtime.js', import.meta.url);
let source = fs.readFileSync(botUrl, 'utf8');

const helpHeader = '**Tempo commands**\n\n';
if (source.includes(helpHeader)) {
  source = source.replace(
    helpHeader,
    helpHeader +
      "**Voice controls**\n" +
      "\\`/tempo join\\` — join your current VC\n" +
      "\\`/tempo leave\\` — leave voice\n" +
      "\\`/tempo play <song/link>\\` — play music when Yapper exposes audio playback\n" +
      "\\`/tempo pause\\` — pause playback\n" +
      "\\`/tempo resume\\` — resume playback\n\n"
  );
}

// Keep routine Yapper/network hiccups from flooding Railway logs.
source = source.replace(
  /bot\.on\(\s*'error',\s*err => \{\s*console\.error\(\s*'\[tempo\]',\s*err\s*\);\s*\}\s*\);/m,
`let lastTransientNetworkLogAt = 0;
let suppressedTransientNetworkErrors = 0;
let fatalYapperAuthError = false;

bot.on(
  'error',
  err => {
    const message = String(
      err?.message ||
      err ||
      'unknown error'
    );

    const code = String(
      err?.cause?.code ||
      err?.code ||
      ''
    );

    if (
      /token rejected|unauthorized|http 401|\\b401\\b/i.test(
        message
      )
    ) {
      fatalYapperAuthError = true;
      console.error('[tempo] Yapper token rejected.');
      return;
    }

    const transient =
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|network|HTTP 502|HTTP 503|HTTP 504|failed \\(502\\)|failed \\(503\\)|failed \\(504\\)/i.test(
        `${message} ${code}`
      );

    if (transient) {
      suppressedTransientNetworkErrors++;
      const now = Date.now();

      if (
        now - lastTransientNetworkLogAt >=
        60_000
      ) {
        const extra =
          suppressedTransientNetworkErrors > 1
            ? ` (${suppressedTransientNetworkErrors - 1} similar errors suppressed)`
            : '';

        console.warn(
          `[tempo] Yapper connection interrupted; retrying automatically${extra}.`
        );

        lastTransientNetworkLogAt = now;
        suppressedTransientNetworkErrors = 0;
      }

      return;
    }

    console.error(
      '[tempo]',
      err
    );
  }
);`
);

// If the outer Yapper event loop ever escapes its built-in retry logic,
// restart it inside this same Railway container instead of exiting Node.
source = source.replace(
  /bot\.start\(\)\.catch\(\s*err => \{\s*console\.error\(\s*'\[yapper\] could not start:',\s*err\.message\s*\);\s*process\.exit\(1\);\s*\}\s*\);/m,
`const restartBotDelay =
  ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );

async function keepTempoAlive() {
  let restartCount = 0;

  while (true) {
    try {
      await bot.start();

      if (fatalYapperAuthError) {
        console.error(
          '[yapper] fatal authentication error; stopping.'
        );
        process.exit(1);
      }

      console.warn(
        '[yapper] event loop stopped unexpectedly; reconnecting.'
      );
    } catch (err) {
      const message = String(
        err?.message ||
        err ||
        'unknown error'
      );

      if (
        fatalYapperAuthError ||
        /token rejected|unauthorized|http 401|\\b401\\b/i.test(
          message
        )
      ) {
        console.error(
          '[yapper] fatal authentication error:',
          message
        );
        process.exit(1);
      }

      console.warn(
        '[yapper] event loop stopped unexpectedly:',
        message
      );
    }

    bot.running = false;
    restartCount++;

    const delay = Math.min(
      30_000,
      3_000 * restartCount
    );

    console.warn(
      `[yapper] reconnecting in ${Math.round(delay / 1000)}s.`
    );

    await restartBotDelay(delay);
  }
}

void keepTempoAlive();`
);

fs.writeFileSync(runtimeUrl, source, 'utf8');
await import('./bot.runtime.js');
