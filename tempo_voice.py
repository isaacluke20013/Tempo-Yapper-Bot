"""Tempo's isolated voice playback worker.

Uses Yapper's supported Python LiveKit/E2EE helper and yt-dlp for a
single track, leaving the existing JavaScript command bot untouched.
Requires YAPPER_BOT_TOKEN, yapper.py, livekit, cryptography, yt-dlp, ffmpeg.
"""
import asyncio
import json
import os
import re
import signal
import sys
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

from yapper import Bot
from yt_dlp import YoutubeDL

RATE = 48000
CHANNELS = 2
FRAME_SAMPLES = 960
FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2
SUPPORTED_YOUTUBE = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
SUPPORTED_SPOTIFY = {"open.spotify.com", "spotify.com"}


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False), flush=True)


def spotify_search(url):
    parsed = urlsplit(url)
    if not re.fullmatch(r"/(?:intl-[a-z]{2}/)?track/[A-Za-z0-9]+/?", parsed.path):
        raise ValueError("Use a Spotify track link, not an album or playlist.")
    endpoint = "https://open.spotify.com/oembed?url=" + quote(url, safe="")
    request = Request(endpoint, headers={"User-Agent": "TempoYapperMusic/1.0"})
    with urlopen(request, timeout=12) as response:
        metadata = json.load(response)
    title = str(metadata.get("title") or "").strip()
    if not title:
        raise ValueError("Spotify didn't return this track's title.")
    return title


def resolve_track(query):
    query = query.strip()[:600]
    if not query:
        raise ValueError("Give a Spotify/YouTube link or a song name.")
    parsed = urlsplit(query) if "://" in query else None
    if parsed and parsed.scheme.lower() not in ("https", "http"):
        raise ValueError("Only Spotify or YouTube links are supported.")
    if parsed:
        host = (parsed.hostname or "").lower()
        if host in SUPPORTED_SPOTIFY:
            query = spotify_search(query)
        elif host not in SUPPORTED_YOUTUBE:
            raise ValueError("Use a Spotify/YouTube link or type a song and artist.")
        elif parsed.path.rstrip("/") in ("/playlist", "/channel", "/@"):
            raise ValueError("Use one YouTube video, not a playlist or channel.")

    opts = {
        "format": "bestaudio/best",
        "default_search": "ytsearch1",
        "noplaylist": True,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 15,
        "extractor_retries": 2,
        "retries": 2,
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(query, download=False)
        if "entries" in info:
            info = next((x for x in info.get("entries") or [] if x), None)
        if not info:
            raise ValueError("No matching YouTube song found.")
        stream_url = info.get("url")
        if not stream_url and info.get("formats"):
            options = [f for f in info["formats"] if f.get("url") and f.get("acodec") != "none"]
            stream_url = options[-1].get("url") if options else None
        if not stream_url or urlsplit(stream_url).scheme != "https":
            raise ValueError("YouTube didn't provide a playable audio stream.")
        name = str(info.get("title") or query).strip()[:180]
        headers = info.get("http_headers") or {}
        return name, stream_url, headers


async def play(server_id, channel_id, query):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGTERM, stop.set)
        loop.add_signal_handler(signal.SIGINT, stop.set)
    except (NotImplementedError, RuntimeError):
        pass

    call = None
    ffmpeg = None
    joined = False
    bot = Bot(os.environ.get("YAPPER_BOT_TOKEN"), log=False)
    try:
        title, url, headers = await asyncio.wait_for(
            asyncio.to_thread(resolve_track, query), timeout=75
        )
        if stop.is_set():
            return
        call = await asyncio.wait_for(
            bot.connect_voice(server_id, channel_id, sample_rate=RATE, channels=CHANNELS),
            timeout=45,
        )
        joined = True
        args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
        header_lines = []
        for name, value in headers.items():
            if (re.fullmatch(r"[A-Za-z0-9-]+", str(name))
                and "\r" not in str(value) and "\n" not in str(value)):
                header_lines.append(str(name) + ": " + str(value))
        if header_lines:
            args += ["-headers", "\r\n".join(header_lines) + "\r\n"]
        args += [
            "-i", url, "-vn", "-ac", str(CHANNELS), "-ar", str(RATE),
            "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"
        ]
        ffmpeg = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        frames = 0
        while not stop.is_set():
            try:
                data = await ffmpeg.stdout.readexactly(FRAME_BYTES)
            except asyncio.IncompleteReadError as exc:
                data = exc.partial
            if not data:
                break
            if len(data) < FRAME_BYTES:
                data = data + (b"\x00" * (FRAME_BYTES - len(data)))
            from livekit import rtc
            frame = rtc.AudioFrame(
                data=data, sample_rate=RATE, num_channels=CHANNELS,
                samples_per_channel=FRAME_SAMPLES
            )
            await call.source.capture_frame(frame)
            frames += 1
            if frames == 1:
                emit("playing", title=title, channel_id=channel_id)
        if ffmpeg.returncode is None:
            if stop.is_set():
                ffmpeg.terminate()
            try:
                await asyncio.wait_for(ffmpeg.wait(), timeout=4)
            except asyncio.TimeoutError:
                ffmpeg.kill()
                await ffmpeg.wait()
        if not frames and not stop.is_set():
            detail = (await ffmpeg.stderr.read()).decode(errors="replace")[-300:]
            raise RuntimeError("Unable to decode audio" + (": " + detail if detail else "."))
        if not stop.is_set():
            await asyncio.sleep(0.75)
            emit("finished", title=title)
    except Exception as exc:
        if not stop.is_set():
            emit("error", message=str(exc)[:350])
    finally:
        if ffmpeg and ffmpeg.returncode is None:
            ffmpeg.kill()
            try:
                await asyncio.wait_for(ffmpeg.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass
        if call:
            try:
                await asyncio.wait_for(call.leave(), timeout=10)
            except Exception:
                pass
        if joined:
            try:
                await asyncio.wait_for(asyncio.to_thread(bot.leave_voice, server_id), timeout=10)
            except Exception:
                pass


if __name__ == "__main__":
    if len(sys.argv) < 4:
        emit("error", message="Missing server/channel/track arguments.")
        sys.exit(2)
    try:
        asyncio.run(play(sys.argv[1], sys.argv[2], sys.argv[3]))
    except Exception as exc:
        emit("error", message=str(exc)[:350])
        sys.exit(1)
