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
      "\\`/tempoplay <YouTube/Spotify track link or song [artist]>\\` — play in your current VC\n" +
      "\\`/tempoqueue\\` — show the current song and the queue\n" +
      "\\`/tempopause\\` — pause in place\n" +
      "\\`/temporesume\\` — resume at that spot\n" +
      "\\`/tempostop\\` — stop music, clear queue, and leave voice\n" +
      "\\`/tempo join\\` — join your current VC\n" +
      "\\`/tempo leave\\` — leave voice\n" +
      "\\`/tempo pause\\` / \\`/tempo resume\\` / \\`/tempo queue\\` — aliases\n" +
      "Tempo leaves after 5 minutes idle or when voice is empty.\n\n"
  );
}

fs.writeFileSync(runtimeUrl, source, 'utf8');
await import('./bot.runtime.js');
