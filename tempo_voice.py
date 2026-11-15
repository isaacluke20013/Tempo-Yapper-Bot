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


def normalized_lookup(query):
    query = query.strip()[:600]
    if not query:
        raise ValueError("Give a Spotify/YouTube link or a song name.")
    parsed = urlsplit(query) if "://" in query else None
    if parsed and parsed.scheme.lower() not in ("https", "http"):
        raise ValueError("Only Spotify or YouTube links are supported.")
    original_link = None
    if parsed:
        host = (parsed.hostname or "").lower()
        if host in SUPPORTED_SPOTIFY:
            original_link = query
            query = spotify_search(query)
        elif host not in SUPPORTED_YOUTUBE:
            raise ValueError("Use a Spotify/YouTube link or type a song and artist.")
        elif parsed.path.rstrip("/") in ("/playlist", "/channel", "/@"):
            raise ValueError("Use one YouTube video, not a playlist or channel.")
        else:
            original_link = query
    return query, original_link


def track_fields(info, fallback, original_link=None):
    title = str(info.get("track") or info.get("title") or fallback).strip()[:180]
    artist = str(
        info.get("artist") or info.get("creator") or
        info.get("uploader") or info.get("channel") or ""
    ).strip()[:110]
    try:
        duration = round(float(info.get("duration") or 0))
    except (TypeError, ValueError, OverflowError):
        duration = 0
    duration = duration if 0 < duration < 24 * 60 * 60 else None
    link = original_link or info.get("webpage_url") or info.get("original_url")
    if not link and re.fullmatch(r"[A-Za-z0-9_-]{11}", str(info.get("id") or "")):
        link = "https://www.youtube.com/watch?v=" + info["id"]
    if link and urlsplit(str(link)).scheme != "https":
        link = None
    return {"title": title, "artist": artist, "duration": duration, "link": link}


def lookup_metadata(query):
    query, original_link = normalized_lookup(query)
    opts = {
        "default_search": "ytsearch1",
        "noplaylist": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 12,
        "extractor_retries": 1,
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(query, download=False)
    if not info:
        raise ValueError("No matching YouTube song found.")
    if "entries" in info:
        info = next((entry for entry in info.get("entries") or [] if entry), None)
    if not info:
        raise ValueError("No matching YouTube song found.")
    return track_fields(info, query, original_link)


def resolve_track(query):
    query, original_link = normalized_lookup(query)
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
        fields = track_fields(info, query, original_link)
        headers = info.get("http_headers") or {}
        return fields, stream_url, headers



class TempoWorker:
    """One encrypted VC connection per server, reused across queued songs."""

    def __init__(self, server_id, channel_id):
        self.server_id = server_id
        self.channel_id = channel_id
        self.bot = Bot(os.environ.get("YAPPER_BOT_TOKEN"), log=False)
        self.call = None
        self.allowed = asyncio.Event()
        self.allowed.set()
        self.track_task = None
        self.track_id = None
        self.probes = {}
        self.probe_slots = asyncio.Semaphore(2)

    async def probe_track(self, track_id, query):
        try:
            async with self.probe_slots:
                fields = await asyncio.wait_for(
                    asyncio.to_thread(lookup_metadata, query), timeout=40
                )
            emit("metadata", id=track_id, **fields)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            emit("metadata_error", id=track_id, message=str(exc)[:180])

    async def play_track(self, query, track_id):
        ffmpeg = None
        outcome = None
        details = {}
        try:
            fields, url, headers = await asyncio.wait_for(
                asyncio.to_thread(resolve_track, query), timeout=75
            )
            title = fields["title"]
            emit("resolved", id=track_id, **fields)
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
            from livekit import rtc
            while True:
                await self.allowed.wait()
                try:
                    data = await ffmpeg.stdout.readexactly(FRAME_BYTES)
                except asyncio.IncompleteReadError as exc:
                    data = exc.partial
                if not data:
                    break
                # A pause arriving during a read freezes this exact PCM frame.
                await self.allowed.wait()
                if len(data) < FRAME_BYTES:
                    data += b"\x00" * (FRAME_BYTES - len(data))
                frame = rtc.AudioFrame(
                    data=data, sample_rate=RATE, num_channels=CHANNELS,
                    samples_per_channel=FRAME_SAMPLES
                )
                await self.call.source.capture_frame(frame)
                frames += 1
                if frames == 1:
                    emit("playing", id=track_id, channel_id=self.channel_id, **fields)

            if ffmpeg.returncode is None:
                try:
                    await asyncio.wait_for(ffmpeg.wait(), timeout=4)
                except asyncio.TimeoutError:
                    ffmpeg.kill()
                    await ffmpeg.wait()
            if not frames or ffmpeg.returncode not in (None, 0):
                detail = (await ffmpeg.stderr.read()).decode(errors="replace")[-300:]
                raise RuntimeError("Unable to decode song" + (": " + detail if detail else "."))
            # Allow the final buffered PCM frames to reach the call.
            await asyncio.sleep(0.5)
            outcome, details = "finished", {"id": track_id, "title": title}
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            outcome, details = "track_error", {"id": track_id, "message": str(exc)[:350]}
        finally:
            if ffmpeg and ffmpeg.returncode is None:
                ffmpeg.kill()
                try:
                    await asyncio.wait_for(ffmpeg.wait(), timeout=3)
                except asyncio.TimeoutError:
                    pass
            self.track_task = None
            if outcome:
                emit(outcome, **details)

    async def run(self):
        try:
            self.call = await asyncio.wait_for(
                self.bot.connect_voice(self.server_id, self.channel_id,
                                       sample_rate=RATE, channels=CHANNELS),
                timeout=45
            )
            emit("ready", channel_id=self.channel_id)
            # Persistent stdin control channel: play, pause, resume, leave.
            reader = asyncio.StreamReader()
            loop = asyncio.get_running_loop()
            protocol = asyncio.StreamReaderProtocol(reader)
            await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    command = json.loads(line)
                except (ValueError, TypeError):
                    emit("warning", message="Invalid control message.")
                    continue
                action = command.get("action")
                if action == "play":
                    if self.track_task and not self.track_task.done():
                        emit("warning", message="The previous track is still playing.")
                        continue
                    query = str(command.get("query") or "")[:600]
                    self.track_id = str(command.get("id") or "")
                    self.track_task = asyncio.create_task(
                        self.play_track(query, self.track_id)
                    )
                elif action == "probe":
                    track_id = str(command.get("id") or "")
                    query = str(command.get("query") or "")[:600]
                    if track_id and track_id not in self.probes:
                        task = asyncio.create_task(self.probe_track(track_id, query))
                        self.probes[track_id] = task
                        task.add_done_callback(
                            lambda completed, key=track_id: self.probes.pop(key, None)
                        )
                elif action == "skip":
                    track_id = str(command.get("id") or "")
                    if track_id and track_id == self.track_id:
                        if self.track_task and not self.track_task.done():
                            self.track_task.cancel()
                            try:
                                await self.track_task
                            except asyncio.CancelledError:
                                pass
                        emit("skipped", id=track_id)
                elif action == "pause":
                    self.allowed.clear()
                    emit("paused")
                elif action == "resume":
                    self.allowed.set()
                    emit("resumed")
                elif action == "leave":
                    break
        except Exception as exc:
            emit("error", message=str(exc)[:350])
        finally:
            self.allowed.set()
            if self.track_task and not self.track_task.done():
                self.track_task.cancel()
                try:
                    await self.track_task
                except asyncio.CancelledError:
                    pass
            for task in self.probes.values():
                task.cancel()
            if self.probes:
                await asyncio.gather(*self.probes.values(), return_exceptions=True)
            if self.call:
                try:
                    await asyncio.wait_for(self.call.leave(), timeout=10)
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(
                        asyncio.to_thread(self.bot.leave_voice, self.server_id), timeout=10
                    )
                except Exception:
                    pass


if __name__ == "__main__":
    if len(sys.argv) < 3:
        emit("error", message="Missing server or channel arguments.")
        sys.exit(2)
    try:
        asyncio.run(TempoWorker(sys.argv[1], sys.argv[2]).run())
    except Exception as exc:
        emit("error", message=str(exc)[:350])
        sys.exit(1)
