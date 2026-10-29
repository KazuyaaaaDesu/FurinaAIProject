
import dotenv from "dotenv";
import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------
// Paths and environment
// --------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const envResult = dotenv.config({
  path: path.join(__dirname, ".env"),
});

if (envResult.error) {
  throw new Error(
    "Could not load discord-bot/.env. Make sure the file exists.",
  );
}

const TOKEN = process.env.DISCORD_TOKEN;
const OLLAMA_URL =
  process.env.OLLAMA_URL ??
  "http://127.0.0.1:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:latest";

const MAX_HISTORY_MESSAGES = 12;
const MAX_DISCORD_LENGTH = 1900;
const MAX_PROMPT_LENGTH = 4000;
const OLLAMA_TIMEOUT_MS = 120_000;

if (!TOKEN) {
  throw new Error(
    "DISCORD_TOKEN is missing from discord-bot/.env.",
  );
}

// --------------------------------------------------
// Load Lumi's existing personality
// --------------------------------------------------

const personalityPath = path.join(
  ROOT,
  "Fufuu.Wpf",
  "Assets",
  "Personality.md",
);

const personality = await readFile(personalityPath, "utf8");

// --------------------------------------------------
// Discord client
// --------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Temporary Discord-only history.
// This does not read or modify WPF conversation history.
const histories = new Map();
const busy = new Set();

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function splitReply(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > MAX_DISCORD_LENGTH) {
    let cut = remaining.lastIndexOf(
      "\n",
      MAX_DISCORD_LENGTH,
    );

    if (cut < MAX_DISCORD_LENGTH * 0.5) {
      cut = remaining.lastIndexOf(
        " ",
        MAX_DISCORD_LENGTH,
      );
    }

    if (cut < 1) {
      cut = MAX_DISCORD_LENGTH;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function askLumi(key, prompt) {
  const history = histories.get(key) ?? [];

  const messages = [
    { role: "system", content: personality },
    ...history,
    { role: "user", content: prompt },
  ];

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_ctx: 8192,
        num_predict: 512,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ?? `Ollama returned HTTP ${response.status}.`,
    );
  }

  const answer = data.message?.content?.trim();

  if (!answer) {
    throw new Error("Ollama returned an empty response.");
  }

  const updatedHistory = [
    ...history,
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  ].slice(-MAX_HISTORY_MESSAGES);

  histories.set(key, updatedHistory);

  return answer;
}

// --------------------------------------------------
// Ready event
// --------------------------------------------------

client.once("clientReady", () => {
  console.log(`Lumi Discord bot online as ${client.user.tag}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Ollama endpoint: ${OLLAMA_URL}`);
  console.log("Responding only to mentions and !lumi commands.");
  console.log("Discord history is temporary and separate from WPF.");
});

// --------------------------------------------------
// Message handling
// --------------------------------------------------

client.on("messageCreate", async (message) => {
  // Ignore bots, including Lumi itself.
  if (message.author.bot) return;

  // Only operate in server channels for this initial version.
  if (!message.guild) return;

  const content = message.content.trim();

  const botUser = client.user;
  if (!botUser) return;

  const mentioned = message.mentions.users.has(botUser.id);

  const commandMatch = /^!lumi(?:\s+([\s\S]*))?$/i.exec(content);

  // Ignore messages that don't mention Lumi or use !lumi.
  if (!mentioned && !commandMatch) return;

  const mentionPattern = new RegExp(
    `<@!?${botUser.id}>`,
    "g",
  );

  let prompt = commandMatch
    ? (commandMatch[1] ?? "").trim()
    : content.replace(mentionPattern, "").trim();

  // Keep each user's history separate per Discord channel.
  const key = `${message.channelId}:${message.author.id}`;

  // Clear this user's temporary conversation context.
  if (/^reset$/i.test(prompt)) {
    histories.delete(key);

    await message.reply({
      content: "A fresh start! Our Discord conversation context is cleared.",
      allowedMentions: { repliedUser: false },
    });

    return;
  }

  if (!prompt) {
    await message.reply({
      content: "Well? You have my attention. What is it?",
      allowedMentions: { repliedUser: false },
    });

    return;
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    await message.reply({
      content: `Please keep each message under ${MAX_PROMPT_LENGTH} characters.`,
      allowedMentions: { repliedUser: false },
    });

    return;
  }

  if (busy.has(key)) {
    await message.reply({
      content: "One moment! I'm still composing my previous reply.",
      allowedMentions: { repliedUser: false },
    });

    return;
  }

  busy.add(key);

  try {
    await message.channel.sendTyping();

    const answer = await askLumi(key, prompt);
    const chunks = splitReply(answer);

    if (chunks.length === 0) {
      await message.reply({
        content: "I couldn't form a response that time.",
        allowedMentions: { repliedUser: false },
      });

      return;
    }

    // Reply to the triggering message with the first chunk.
    await message.reply({
      content: chunks[0],
      allowedMentions: { repliedUser: false },
    });

    // Send additional chunks without mentioning anyone.
    for (const chunk of chunks.slice(1)) {
      await message.channel.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.error("Discord response failed:", error);

    await message.reply({
      content:
        "I couldn't reach my conversational stage. Check that Ollama is running and the model is available.",
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  } finally {
    busy.delete(key);
  }
});

// --------------------------------------------------
// Login and shutdown
// --------------------------------------------------

client.login(TOKEN).catch((error) => {
  console.error("Discord login failed:", error);
  process.exitCode = 1;
});

async function shutdown() {
  console.log("Shutting down Lumi Discord bot...");
  client.destroy();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
