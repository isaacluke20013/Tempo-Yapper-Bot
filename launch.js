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

fs.writeFileSync(runtimeUrl, source, 'utf8');
await import('./bot.runtime.js');
