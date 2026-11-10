import dotenv from "dotenv";
import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOT_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BOT_SOURCE_DIR, "../../..");
dotenv.config({ path: join(REPOSITORY_ROOT, "discord-bot", ".env") });

const { chatAgent } = await import("./agent-api.js");
const {
  configureVoiceAssistant,
  joinLumiVoice,
  leaveLumiVoice,
} = await import("./voice.js");
const MAX_HISTORY_MESSAGES = 20;

const histories = new Map();
const busy = new Set();

function splitReply(text, maxLength = 1900) {
  const chunks = [];
  let remaining = String(text ?? "").trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength * 0.5) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function askLumi(historyKey, prompt) {
  const history = histories.get(historyKey) ?? [];
  const channel = historyKey.startsWith("voice:") ? "voice" : "chat";
  const answer = await chatAgent({
    channel,
    conversationId: historyKey,
    sessionId: historyKey,
    history,
    text: prompt,
  });

  if (!answer) throw new Error("The agent API returned an empty response.");

  const updatedHistory = [
    ...history,
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  ].slice(-MAX_HISTORY_MESSAGES);

  histories.set(historyKey, updatedHistory);
  return answer;
}

async function handleVoicePrompt(guildId, userId, prompt) {
  const historyKey = `voice:${guildId}:${userId}`;
  return askLumi(historyKey, prompt);
}

configureVoiceAssistant(handleVoicePrompt);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`[Lumi] Online as ${client.user.tag}`);
  console.log('[Lumi] Voice commands: "!lumi join" and "!lumi leave".');
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const isCommand = /^!lumi\b/i.test(content);

  if (!isMentioned && !isCommand) return;

  const commandText = content.replace(/^!lumi\b/i, "").trim();

  if (isCommand && /^join$/i.test(commandText)) {
    await joinLumiVoice(message);
    return;
  }

  if (isCommand && /^leave$/i.test(commandText)) {
    await leaveLumiVoice(message);
    return;
  }

  if (isCommand && /^reset$/i.test(commandText)) {
    histories.delete(`text:${message.guild.id}:${message.author.id}`);
    await message.reply("I've cleared our conversation history.");
    return;
  }

  const prompt = isMentioned
    ? content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim()
    : commandText;

  if (!prompt) {
    await message.reply("I'm here. What would you like to talk about?");
    return;
  }

  const historyKey = `text:${message.guild.id}:${message.author.id}`;
  if (busy.has(historyKey)) {
    await message.reply("Give me a moment — I'm still thinking about your last message.");
    return;
  }

  busy.add(historyKey);
  try {
    const answer = await askLumi(historyKey, prompt);
    for (const chunk of splitReply(answer)) await message.reply(chunk);
  } catch (error) {
    console.error("[Lumi] Chat failed:", error);
    await message.reply("I couldn't get a response from Lumi's agent service. Check that the local agent API is running.");
  } finally {
    busy.delete(historyKey);
  }
});

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing. Add it to the existing discord-bot/.env file.");
}

client.login(process.env.DISCORD_TOKEN);