import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import mongoose from 'mongoose';

// ====== CHANNELS YOU TRACK ======
const CHANNEL_WHITELIST = [
  '1403062836506263642', // ass-buffet
  '1403060664322363614', // milk-farm
  '1403060467475152986', // meat-market
  '1403064291610857543', // hentai-hospital
  '1403013451118280878', // gas-station
];

const BORDER_CONTROL_ID     = process.env.BORDER_CONTROL_CHANNEL_ID;
const DEALER_ROLE_ID        = process.env.DEALER_ROLE_ID;
const JUNKIE_ROLE_ID        = process.env.JUNKIE_ROLE_ID;
const CHURCH_PASS_ROLE_ID   = process.env.CHURCH_PASS_ROLE_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

const JUNKIE_TARGET = 50;  // reactions
const DEALER_TARGET = 50;  // media posts

const REACTION_COOLDOWN_MS = 60_000;
const POST_COOLDOWN_MS     = 30_000;
const LEADERBOARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

await mongoose.connect(process.env.MONGODB_URI, { dbName: 'addictcity' });

const counterSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  junkieReacts: { type: Number, default: 0 },
  dealerPosts:  { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

const metadataSchema = new mongoose.Schema({
  key:   { type: String, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed }
});
const Metadata = mongoose.model('Metadata', metadataSchema);

async function addCount(userId, field) {
  const updated = await Counter.findOneAndUpdate(
    { userId }, { $inc: { [field]: 1 } }, { new: true, upsert: true }
  ).lean();
  return updated[field];
}

const reactSeen = new Map(); // `${userId}:${messageId}`
const postSeen  = new Map(); // `${userId}` last time
const inCountableChannel = id => CHANNEL_WHITELIST.includes(id);

async function getMetadata(key) {
  const row = await Metadata.findOne({ key }).lean();
  return row?.value;
}

async function setMetadata(key, value) {
  await Metadata.findOneAndUpdate({ key }, { value }, { upsert: true });
}

async function topCounters(field, limit = 5) {
  const rows = await Counter.find().sort({ [field]: -1 }).limit(limit).lean();
  return rows.map((row, idx) => `${idx + 1}. <@${row.userId}> — **${row[field]}**`);
}

async function postLeaderboard(guild) {
  if (!LEADERBOARD_CHANNEL_ID) return false;
  const channel = guild.channels.cache.get(LEADERBOARD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return false;

  const [topReacts, topPosts] = await Promise.all([
    topCounters('junkieReacts'),
    topCounters('dealerPosts')
  ]);

  const embed = new EmbedBuilder()
    .setTitle('🏆 Addict City Leaderboards')
    .setDescription('Latest tallies for reactions and media posts.')
    .addFields(
      { name: 'Reactions', value: topReacts.length ? topReacts.join('\n') : 'No reactions tracked yet.' },
      { name: 'Media Posts', value: topPosts.length ? topPosts.join('\n') : 'No media posts tracked yet.' }
    )
    .setColor(0xffc107)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  return true;
}

async function announceVisaUpgrade(member, which, total) {
  const ch = member.guild.channels.cache.get(BORDER_CONTROL_ID);
  if (!ch || !ch.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle('🪪 VISA UPGRADE')
    .setDescription(`<@${member.id}> unlocked **CHURCH** by hitting **${total} ${which}**.`)
    .setColor(which === 'reactions' ? 0xff4ddb : 0xffa500);
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function tryGrantChurch(member, isJunkie, total) {
  if (member.roles.cache.has(CHURCH_PASS_ROLE_ID)) return;
  const target = isJunkie ? JUNKIE_TARGET : DEALER_TARGET;
  if (total >= target) {
    await member.roles.add(CHURCH_PASS_ROLE_ID).catch(() => {});
    await announceVisaUpgrade(member, isJunkie ? 'reactions' : 'posts', total);
  }
}

// Dealer: count media posts
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (!inCountableChannel(msg.channelId)) return;
    if (msg.attachments?.size <= 0) return;

    const now = Date.now();
    const last = postSeen.get(msg.author.id) || 0;
    if (now - last < POST_COOLDOWN_MS) return;
    postSeen.set(msg.author.id, now);

    const total = await addCount(msg.author.id, 'dealerPosts');

    const m = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (!m) return;
    if (DEALER_ROLE_ID && !m.roles.cache.has(DEALER_ROLE_ID)) {
      await m.roles.add(DEALER_ROLE_ID).catch(() => {});
    }
    await tryGrantChurch(m, false, total);
  } catch {}
});

// Junkie: count reactions
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!message.guild) return;
    if (!inCountableChannel(message.channelId)) return;

    const key = `${user.id}:${message.id}`;
    const last = reactSeen.get(key) || 0;
    if (Date.now() - last < REACTION_COOLDOWN_MS) return;
    reactSeen.set(key, Date.now());

    const total = await addCount(user.id, 'junkieReacts');

    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    if (JUNKIE_ROLE_ID && !member.roles.cache.has(JUNKIE_ROLE_ID)) {
      await member.roles.add(JUNKIE_ROLE_ID).catch(() => {});
    }
    await tryGrantChurch(member, true, total);
  } catch {}
});

// Tiny stats helpers
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (msg.content === '!reacts' || msg.content === '!posts') {
    const row = await Counter.findOne({ userId: msg.author.id }).lean();
    const junk = row?.junkieReacts || 0;
    const deal = row?.dealerPosts  || 0;
    if (msg.content === '!reacts') msg.reply(`You’ve logged **${junk}** counted reactions.`);
    else msg.reply(`You’ve logged **${deal}** counted media posts.`);
  }
});

const LEADERBOARD_STATE_KEY = 'leaderboard:lastPostedAt';

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const lastPostedAt = await getMetadata(LEADERBOARD_STATE_KEY);
  const now = Date.now();
  if (lastPostedAt && now - lastPostedAt < LEADERBOARD_COOLDOWN_MS) return;

  const posted = await postLeaderboard(guild).catch(() => false);
  if (posted) {
    await setMetadata(LEADERBOARD_STATE_KEY, now);
  }
});
client.login(process.env.DISCORD_TOKEN);
