
import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";

import prismMedia from "prism-media";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const CONNECTION_TIMEOUT_MS = 15_000;
const SILENCE_DURATION_MS = 1_000;
const POST_TTS_COOLDOWN_MS = 1_500;

const PCM_SAMPLE_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;
const MAX_UTTERANCE_SECONDS = 15;
const MIN_UTTERANCE_SECONDS = 0.25;
const OMNIVOICE_TIMEOUT_MS = 120_000;

const OMNIVOICE_URL =
  process.env.OMNIVOICE_URL ?? "http://127.0.0.1:8765/synthesize";

const BOT_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BOT_SOURCE_DIR, "../../..");
const LEGACY_BOT_DIR = join(REPOSITORY_ROOT, "discord-bot");
const PYTHON_PATH = process.env.LUMI_WHISPER_PYTHON ??
  join(LEGACY_BOT_DIR, ".venv", "Scripts", "python.exe");
const WHISPER_WORKER_PATH = join(
  REPOSITORY_ROOT,
  "services",
  "speech",
  "whisper",
  "whisper_worker.py",
);

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let whisperWorker = null;
let whisperReadyPromise = null;
let transcriptHandler = null;

const pendingRequests = new Map();
const voicePlayers = new Map();

// Guilds where Lumi is generating or playing speech, including cooldown.
const lumiSpeaking = new Set();

// Active voice receiver sessions, allowing playback to cancel recordings.
const receiverCancellers = new Map();

// Incremented whenever Lumi starts speaking. Invalidates older transcriptions.
const voiceGenerations = new Map();

const wakeStates = new Map();
const busyUsers = new Set();

const WAKE_TIMEOUT_MS = 10_000;

function getVoiceGeneration(guildId) {
  return voiceGenerations.get(guildId) ?? 0;
}

function invalidateGuildAudio(guildId) {
  voiceGenerations.set(guildId, getVoiceGeneration(guildId) + 1);

  const cancelActiveStreams = receiverCancellers.get(guildId);

  if (cancelActiveStreams) {
    cancelActiveStreams();
  }
}

export function configureVoiceAssistant(handler) {
  if (typeof handler !== "function") {
    throw new TypeError(
      "configureVoiceAssistant expects a transcript handler function.",
    );
  }

  transcriptHandler = handler;
  console.log("[Lumi Voice] Transcript handler configured.");
}

function ensureWhisperWorker() {
  if (whisperReadyPromise) return whisperReadyPromise;

  whisperReadyPromise = new Promise((resolve, reject) => {
    console.log("[Lumi Whisper] Starting Python worker...");

    const worker = spawn(PYTHON_PATH, [WHISPER_WORKER_PATH], {
      cwd: LEGACY_BOT_DIR,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    whisperWorker = worker;
    let ready = false;

    const stdout = createInterface({
      input: worker.stdout,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => {
      let message;

      try {
        message = JSON.parse(line);
      } catch {
        console.error("[Lumi Whisper] Invalid worker response:", line);
        return;
      }

      if (message.type === "ready") {
        ready = true;

        console.log(
          `[Lumi Whisper] Ready: ${message.model} on ${message.device}`,
        );

        resolve();
        return;
      }

      const pending = pendingRequests.get(message.id);
      if (!pending) return;

      pendingRequests.delete(message.id);

      if (message.type === "error") {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message);
      }
    });

    worker.stderr.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.log(output);
    });

    worker.once("error", (error) => {
      console.error("[Lumi Whisper] Worker process error:", error);

      if (!ready) reject(error);
    });

    worker.once("exit", (code) => {
      const error = new Error(`Whisper worker exited with code ${code}`);

      console.error("[Lumi Whisper]", error.message);

      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }

      pendingRequests.clear();
      whisperWorker = null;
      whisperReadyPromise = null;

      if (!ready) reject(error);
    });
  });

  return whisperReadyPromise;
}

async function transcribePcm(pcmBuffer) {
  await ensureWhisperWorker();

  if (!whisperWorker || whisperWorker.killed) {
    throw new Error("Whisper worker is not running.");
  }

  const id = randomUUID();

  const request = {
    type: "transcribe",
    id,
    audio: pcmBuffer.toString("base64"),
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    whisperWorker.stdin.write(JSON.stringify(request) + "\n", (error) => {
      if (error) {
        pendingRequests.delete(id);
        reject(error);
      }
    });
  });
}

function decodeWavToDiscordPcm(wavBuffer) {
  if (
    wavBuffer.toString("ascii", 0, 4) !== "RIFF" ||
    wavBuffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("OmniVoice returned an invalid WAV file.");
  }

  let offset = 12;
  let format = null;
  let data = null;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkStart + chunkSize > wavBuffer.length) {
      throw new Error("WAV contains an incomplete chunk.");
    }

    if (chunkId === "fmt ") {
      format = {
        audioFormat: wavBuffer.readUInt16LE(chunkStart),
        channels: wavBuffer.readUInt16LE(chunkStart + 2),
        sampleRate: wavBuffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: wavBuffer.readUInt16LE(chunkStart + 14),
      };
    }

    if (chunkId === "data") {
      data = wavBuffer.subarray(chunkStart, chunkStart + chunkSize);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!format || !data) {
    throw new Error("WAV is missing its format or audio data.");
  }

  if (
    format.audioFormat !== 1 ||
    format.bitsPerSample !== 16 ||
    ![1, 2].includes(format.channels) ||
    format.sampleRate <= 0
  ) {
    throw new Error("Expected PCM16 mono or stereo WAV from OmniVoice.");
  }

  const sourceFrameSize = format.channels * 2;
  const sourceFrames = Math.floor(data.length / sourceFrameSize);

  if (!sourceFrames) {
    throw new Error("OmniVoice returned empty audio.");
  }

  const targetFrames = Math.max(
    1,
    Math.floor(sourceFrames * PCM_SAMPLE_RATE / format.sampleRate),
  );

  const output = Buffer.alloc(
    targetFrames * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE,
  );

  for (let i = 0; i < targetFrames; i++) {
    const sourcePosition = i * format.sampleRate / PCM_SAMPLE_RATE;
    const frameA = Math.min(Math.floor(sourcePosition), sourceFrames - 1);
    const frameB = Math.min(frameA + 1, sourceFrames - 1);
    const fraction = sourcePosition - frameA;

    for (let channel = 0; channel < PCM_CHANNELS; channel++) {
      const sourceChannel = format.channels === 1 ? 0 : channel;

      const a = data.readInt16LE(
        frameA * sourceFrameSize + sourceChannel * 2,
      );

      const b = data.readInt16LE(
        frameB * sourceFrameSize + sourceChannel * 2,
      );

      const sample = Math.round(a + (b - a) * fraction);

      output.writeInt16LE(
        Math.max(-32768, Math.min(32767, sample)),
        (i * PCM_CHANNELS + channel) * 2,
      );
    }
  }

  return output;
}

async function speakInVoice(guildId, text) {
  const spokenText = String(text ?? "").trim().slice(0, 1200);

  if (!spokenText) {
    console.warn("[Lumi TTS] Skipped empty speech text.");
    return;
  }

  const connection = getVoiceConnection(guildId);

  if (!connection) {
    throw new Error("Lumi is no longer connected to voice.");
  }

  if (connection.state.status !== VoiceConnectionStatus.Ready) {
    throw new Error(
      `Discord voice connection is not ready: ${connection.state.status}`,
    );
  }

  let player = voicePlayers.get(guildId);

  if (!player) {
    player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Stop,
      },
    });

    player.on("error", (error) => {
      console.error("[Lumi Playback] Player error:", error);

      // Do not clear lumiSpeaking here.
      // speakInVoice owns the playback and cooldown lifecycle.
    });

    player.on("stateChange", (oldState, newState) => {
      console.log(
        `[Lumi Playback] ${oldState.status} -> ${newState.status}`,
      );

      // Do not clear lumiSpeaking on Idle.
      // The microphone must remain blocked during the cooldown.
    });

    connection.subscribe(player);
    voicePlayers.set(guildId, player);
  }

  console.log(
    `[Lumi TTS] Sending text to OmniVoice: ${spokenText.slice(0, 160)}`,
  );

  // Block voice processing immediately, before TTS generation begins.
  lumiSpeaking.add(guildId);

  // Cancel audio already being collected and invalidate pending transcriptions.
  invalidateGuildAudio(guildId);

  console.log("[Lumi Voice] Microphone processing paused.");

  try {
    const response = await fetch(OMNIVOICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OMNIVOICE_TIMEOUT_MS),
      body: JSON.stringify({ text: spokenText }),
    });

    const contentType = response.headers.get("content-type") ?? "";

    console.log(
      `[Lumi TTS] HTTP ${response.status} | Content-Type: ${contentType}`,
    );

    if (!response.ok) {
      throw new Error(
        `OmniVoice HTTP ${response.status}: ${await response.text()}`,
      );
    }

    if (!contentType.toLowerCase().includes("audio/wav")) {
      throw new Error(
        `Expected audio/wav, received ${contentType}: ${(await response.text()).slice(0, 500)}`,
      );
    }

    const wavBuffer = Buffer.from(await response.arrayBuffer());
    const pcm = decodeWavToDiscordPcm(wavBuffer);

    console.log(
      `[Lumi TTS] Received ${(wavBuffer.length / 1024).toFixed(1)} KB WAV.`,
    );

    console.log(
      `[Lumi TTS] Converted to ${(pcm.length / 1024).toFixed(1)} KB PCM.`,
    );

    const resource = createAudioResource(Readable.from([pcm]), {
      inputType: StreamType.Raw,
    });

    player.play(resource);

    await entersState(player, AudioPlayerStatus.Playing, 10_000);

    console.log("[Lumi Playback] Audio playback started in Discord.");

    await entersState(player, AudioPlayerStatus.Idle, 120_000);

    console.log("[Lumi Playback] Finished speaking.");
  } catch (error) {
    throw error;
  } finally {
    // Keep the receiver blocked briefly after playback ends.
    console.log(
      `[Lumi Voice] Waiting ${POST_TTS_COOLDOWN_MS}ms before listening again.`,
    );

    await sleep(POST_TTS_COOLDOWN_MS);

    lumiSpeaking.delete(guildId);

    console.log("[Lumi Voice] Microphone processing resumed.");
  }
}

function normalizeTranscript(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWakeCommand(text) {
  if (!text) return null;

  const original = text.trim();
  if (!original) return null;

  const normalized = original
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?;:'"()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = normalized.split(" ");

  const wakeAliases = new Set([
    "lumi",
    "loomie",
    "loomy",
    "loomi",
    "noomi",
  ]);

  if (wakeAliases.has(words[0])) {
    return original.split(/\s+/).slice(1).join(" ").trim();
  }

  if (
    words.length >= 2 &&
    ["hey", "hi", "hello"].includes(words[0]) &&
    wakeAliases.has(words[1])
  ) {
    return original.split(/\s+/).slice(2).join(" ").trim();
  }

  return null;
}

function handleTranscript(guildId, userId, transcript) {
  if (lumiSpeaking.has(guildId)) {
    console.log("[Lumi Voice] Ignored transcript during Lumi playback.");
    return;
  }

  const text = normalizeTranscript(transcript);
  if (!text) return;

  const key = `${guildId}:${userId}`;
  const wakeCommand = extractWakeCommand(text);

  if (wakeCommand !== null) {
    clearTimeout(wakeStates.get(key));
    wakeStates.delete(key);

    if (wakeCommand) {
      void runAssistant(guildId, userId, wakeCommand);
    } else {
      const timer = setTimeout(() => {
        wakeStates.delete(key);
        console.log("[Lumi Wake] Listening window expired.");
      }, WAKE_TIMEOUT_MS);

      timer.unref?.();
      wakeStates.set(key, timer);

      void speakInVoice(guildId, "I'm listening.").catch((error) =>
        console.error("[Lumi Wake] Acknowledgement failed:", error),
      );
    }

    return;
  }

  if (!wakeStates.has(key)) return;

  clearTimeout(wakeStates.get(key));
  wakeStates.delete(key);

  void runAssistant(guildId, userId, text);
}

async function runAssistant(guildId, userId, prompt) {
  const key = `${guildId}:${userId}`;

  if (busyUsers.has(key)) {
    console.log(`[Lumi Voice] Ignored overlapping command from ${userId}.`);
    return;
  }

  if (!transcriptHandler) {
    console.error("[Lumi Voice] No transcript handler configured.");
    return;
  }

  busyUsers.add(key);

  try {
    console.log(`[Lumi Voice] Command: ${prompt}`);
    console.log("[Lumi AI] Sending command to Ollama...");

    const answer = await transcriptHandler(guildId, userId, prompt);

    if (!answer || !String(answer).trim()) {
      console.warn("[Lumi AI] Agent API returned an empty response.");
      return;
    }

    console.log(
      `[Lumi AI] Response received: ${String(answer).slice(0, 300)}`,
    );

    console.log("[Lumi TTS] Passing response to OmniVoice...");

    await speakInVoice(guildId, answer);

    console.log("[Lumi Voice] Response sent to Discord.");
  } catch (error) {
    console.error("[Lumi Voice] Assistant response failed:", error);
  } finally {
    busyUsers.delete(key);
  }
}

function attachVoiceReceiver(connection, guildId, botUserId) {
  const receiver = connection.receiver;
  const activeStreams = new Map();

  function cancelSession(userId, session) {
    if (session.cancelled) return;

    session.cancelled = true;
    session.chunks = [];

    session.opusStream.destroy();
    session.decoder.destroy();

    if (activeStreams.get(userId) === session) {
      activeStreams.delete(userId);
    }
  }

  function cancelAllActiveStreams() {
    for (const [userId, session] of activeStreams.entries()) {
      cancelSession(userId, session);
    }

    activeStreams.clear();
  }

  receiverCancellers.set(guildId, cancelAllActiveStreams);

  function onSpeakingStart(userId) {
    if (lumiSpeaking.has(guildId)) {
      console.log("[Lumi Voice] Ignoring incoming audio while Lumi is speaking.");
      return;
    }

    if (userId === botUserId || activeStreams.has(userId)) return;

    console.log(`[Lumi Voice] Speech detected: ${userId}`);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SILENCE_DURATION_MS,
      },
    });

    const decoder = new prismMedia.opus.Decoder({
      rate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      frameSize: 960,
    });

    const session = {
      opusStream,
      decoder,
      cancelled: false,
      chunks: [],
      pcmBytes: 0,
    };

    activeStreams.set(userId, session);

    decoder.on("data", (chunk) => {
      if (session.cancelled || lumiSpeaking.has(guildId)) return;

      session.pcmBytes += chunk.length;

      const maxBytes =
        PCM_SAMPLE_RATE *
        PCM_CHANNELS *
        PCM_BYTES_PER_SAMPLE *
        MAX_UTTERANCE_SECONDS;

      if (session.pcmBytes > maxBytes) {
        console.warn(
          `[Lumi Whisper] Ignored utterance longer than ${MAX_UTTERANCE_SECONDS}s.`,
        );

        cancelSession(userId, session);
        return;
      }

      session.chunks.push(Buffer.from(chunk));
    });

    decoder.once("end", async () => {
      if (activeStreams.get(userId) === session) {
        activeStreams.delete(userId);
      }

      if (session.cancelled || lumiSpeaking.has(guildId)) return;

      // Remember which audio generation this recording belongs to.
      const transcriptionGeneration = getVoiceGeneration(guildId);

      const pcmBuffer = Buffer.concat(session.chunks);
      session.chunks = [];

      const duration =
        pcmBuffer.length /
        (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE);

      if (duration < MIN_UTTERANCE_SECONDS) return;

      console.log(
        `[Lumi PCM] ${userId}: ${duration.toFixed(2)} seconds`,
      );

      try {
        const result = await transcribePcm(pcmBuffer);

        // Discard if Lumi spoke at any point during this transcription.
        if (
          lumiSpeaking.has(guildId) ||
          transcriptionGeneration !== getVoiceGeneration(guildId)
        ) {
          console.log(
            "[Lumi Voice] Discarded stale transcript from before playback.",
          );
          return;
        }

        if (result.text?.trim()) {
          console.log(
            `[Lumi STT] ${userId} (${result.language}): ${result.text}`,
          );

          handleTranscript(guildId, userId, result.text);
        } else {
          console.log("[Lumi STT] No speech recognized.");
        }
      } catch (error) {
        console.error("[Lumi STT] Transcription failed:", error);
      }
    });

    decoder.once("error", (error) => {
      if (session.cancelled) return;

      console.error("[Lumi PCM] Decoder error:", error);

      session.cancelled = true;
      session.chunks = [];

      if (activeStreams.get(userId) === session) {
        activeStreams.delete(userId);
      }
    });

    opusStream.once("error", (error) => {
      if (session.cancelled) return;

      console.error("[Lumi Voice] Opus stream error:", error);

      session.cancelled = true;
      session.chunks = [];

      decoder.destroy();

      if (activeStreams.get(userId) === session) {
        activeStreams.delete(userId);
      }
    });

    opusStream.pipe(decoder);
  }

  receiver.speaking.on("start", onSpeakingStart);

  function cleanup() {
    receiver.speaking.off("start", onSpeakingStart);

    cancelAllActiveStreams();

    if (receiverCancellers.get(guildId) === cancelAllActiveStreams) {
      receiverCancellers.delete(guildId);
    }

    for (const [key, timer] of wakeStates.entries()) {
      if (key.startsWith(`${guildId}:`)) {
        clearTimeout(timer);
        wakeStates.delete(key);
      }
    }

    lumiSpeaking.delete(guildId);
    voiceGenerations.set(guildId, getVoiceGeneration(guildId) + 1);

    const player = voicePlayers.get(guildId);

    if (player) {
      player.stop(true);
      voicePlayers.delete(guildId);
    }

    console.log(`[Lumi Voice] Receiver stopped for guild ${guildId}`);
  }

  connection.on("stateChange", (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      cleanup();
    }
  });

  console.log(`[Lumi Voice] PCM receiver ready for guild ${guildId}`);
}

export async function joinLumiVoice(message) {
  const guild = message.guild;
  const userChannel = message.member?.voice?.channel;

  if (!userChannel) {
    await message.reply(
      "Join a voice channel first, then ask me to join.",
    );
    return;
  }

  if (userChannel.type !== ChannelType.GuildVoice) {
    await message.reply(
      "For now, I can only join regular voice channels.",
    );
    return;
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe();
  const permissions = userChannel.permissionsFor(botMember);

  if (
    !permissions?.has([
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ])
  ) {
    await message.reply(
      "I need Connect and Speak permissions in that channel.",
    );
    return;
  }

  let connection = getVoiceConnection(guild.id);

  if (connection?.joinConfig.channelId === userChannel.id) {
    await message.reply(
      "I'm already connected to your voice channel.",
    );
    return;
  }

  if (connection) connection.destroy();

  try {
    connection = joinVoiceChannel({
      channelId: userChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on("error", (error) => {
      console.error("[Lumi Voice] Connection error:", error);
    });

    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      CONNECTION_TIMEOUT_MS,
    );

    attachVoiceReceiver(connection, guild.id, botMember.id);

    await message.reply(
      `Connected to **${userChannel.name}**. Say "Hey Lumi" when you want to talk.`,
    );
  } catch (error) {
    console.error("[Lumi Voice] Failed to join:", error);

    connection?.destroy();

    await message.reply(
      "I couldn't connect to that voice channel. Check my permissions and try again.",
    );
  }
}

export async function leaveLumiVoice(message) {
  const connection = getVoiceConnection(message.guild.id);

  if (!connection) {
    await message.reply("I'm not connected to a voice channel.");
    return;
  }

  connection.destroy();

  await message.reply("Disconnected from the voice channel.");
}
