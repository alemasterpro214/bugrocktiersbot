import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load JSON (Node 24 compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, './config.json'), 'utf8')
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// State per mode
const modesState = new Map();

for (const modeName of Object.keys(config.modes)) {
  modesState.set(modeName, {
    queueMessageId: null,
    queueChannelId: config.modes[modeName],
    testers: new Set(),
    queue: [],
    tickets: new Map(),
    cooldowns: new Map()
  });
}

client.commands = new Collection();
import tiertestCommand from './commands/tiertest.js';
client.commands.set(tiertestCommand.data.name, tiertestCommand);

client.once(Events.ClientReady, () => {
  console.log(`Bot online as ${client.user.tag}`);
});

// Find mode by channel
function getModeByChannelId(channelId) {
  for (const [mode, chanId] of Object.entries(config.modes)) {
    if (chanId === channelId) return mode;
  }
  return null;
}

// FULL CHANNEL PURGE
async function purgeChannel(channel) {
  let fetched;
  do {
    fetched = await channel.messages.fetch({ limit: 100 });
    await channel.bulkDelete(fetched, true).catch(() => {});
  } while (fetched.size >= 2);
}

// Show "No Testers Online"
async function showNoTestersMessage(guild, modeName) {
  const state = modesState.get(modeName);
  const channel = guild.channels.cache.get(state.queueChannelId);
  if (!channel) return;

  // Purge everything
  await purgeChannel(channel);

  const now = new Date();
  const formatted =
    now.toLocaleDateString("en-GB") + " " + now.toLocaleTimeString("en-GB");

  const embed = new EmbedBuilder()
    .setTitle("No Testers Online")
    .setDescription(`Last Time Online: **${formatted}**`)
    .setColor(0xff0000);

  const sent = await channel.send({ embeds: [embed] });
  state.queueMessageId = sent.id;
}

// Update queue message
async function updateQueueMessage(guild, modeName) {
  const state = modesState.get(modeName);

  // If no testers → offline message
  if (state.testers.size === 0) {
    return showNoTestersMessage(guild, modeName);
  }

  const channel = guild.channels.cache.get(state.queueChannelId);
  if (!channel) return;

  let message = null;
  if (state.queueMessageId) {
    try {
      message = await channel.messages.fetch(state.queueMessageId);
    } catch {}
  }

  // Queue list
  const queueList = state.queue.length > 0
    ? state.queue.map((id, i) => `${i + 1}. <@${id}>`).join('\n')
    : 'Queue is empty.';

  // Testers list
  let testersList = 'No active testers.';
  if (state.testers.size > 0) {
    testersList = [...state.testers]
      .map(id => {
        const member = guild.members.cache.get(id);
        const nickname = member?.nickname || member?.user?.username || 'Unknown';
        return `• <@${id}> — **${nickname}**`;
      })
      .join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(`Queue for ${modeName}`)
    .addFields(
      { name: 'Queue', value: queueList },
      { name: 'Active Testers', value: testersList }
    )
    .setColor(0x00AEFF);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`joinQueue:${modeName}`)
      .setLabel('Join Queue')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`leaveQueue:${modeName}`)
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Danger)
  );

  if (!message) {
    const sent = await channel.send({ embeds: [embed], components: [row] });
    state.queueMessageId = sent.id;
  } else {
    await message.edit({ embeds: [embed], components: [row] });
  }
}

// Cooldown
function hasCooldown(state, userId) {
  const until = state.cooldowns.get(userId);
  return until && Date.now() < until;
}

function setCooldown(state, userId, days = 7) {
  state.cooldowns.set(userId, Date.now() + days * 86400000);
}

// Find free tester
function findFreeTester(state) {
  const busy = new Set();
  for (const t of state.tickets.values()) busy.add(t.testerId);
  for (const tester of state.testers) {
    if (!busy.has(tester)) return tester;
  }
  return null;
}

// Try assign next
async function tryAssignNext(guild, modeName) {
  const state = modesState.get(modeName);
  if (state.queue.length === 0) return;

  const freeTester = findFreeTester(state);
  if (!freeTester) return;

  const userId = state.queue[0];
  const tester = await guild.members.fetch(freeTester);
  const dm = await tester.createDM();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`acceptTest:${modeName}:${userId}`)
      .setLabel('Accept Test')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`declineTest:${modeName}:${userId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Secondary)
  );

  await dm.send({
    content: `Do you want to open a ticket for <@${userId}> in **${modeName}**?`,
    components: [row]
  });
}

// Create ticket
async function createTicket(guild, modeName, testerId, userId) {
  const state = modesState.get(modeName);

  const channel = await guild.channels.create({
    name: `tiertest-${modeName}-${userId}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: testerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
    ]
  });

  state.queue = state.queue.filter(id => id !== userId);
  setCooldown(state, userId);
  state.tickets.set(userId, { channelId: channel.id, testerId });

  await updateQueueMessage(guild, modeName);

  const rows = [];
  const size = 5;
  for (let i = 0; i < config.tiers.length; i += size) {
    const row = new ActionRowBuilder();
    for (const tier of config.tiers.slice(i, i + size)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tierSelect:${modeName}:${userId}:${tier}`)
          .setLabel(tier)
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  await channel.send({
    content: `Ticket for <@${userId}> — Tester: <@${testerId}>\nSelect the tier:`,
    components: rows
  });
}

// Close ticket
async function closeTicket(guild, modeName, userId, tier) {
  const state = modesState.get(modeName);
  const ticket = state.tickets.get(userId);
  if (!ticket) return;

  const channel = guild.channels.cache.get(ticket.channelId);
  if (channel) {
    await channel.send(`Test completed. Assigned tier: **${tier}**`);
    await channel.delete();
  }

  state.tickets.delete(userId);
}

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd) {
      await cmd.execute(interaction, {
        modesState,
        getModeByChannelId,
        updateQueueMessage,
        tryAssignNext,
        showNoTestersMessage
      });
    }
  }

  if (interaction.isButton()) {
    const [action, modeName, userId, tier] = interaction.customId.split(':');
    let guild = interaction.guild;
    const state = modesState.get(modeName);

    // Fix DM → guild
    if (!guild) {
      const modeChannel = interaction.client.channels.cache.get(config.modes[modeName]);
      guild = modeChannel?.guild;
    }

    if (!guild) {
      return interaction.reply({
        content: 'Error: unable to find the guild.',
        flags: 64
      });
    }

    // JOIN QUEUE
    if (action === 'joinQueue') {

      // NEW RULE: testers cannot join queues
      if (state.testers.has(interaction.user.id)) {
        return interaction.reply({
          content: "You can't join the queues while testing!",
          flags: 64
        });
      }

      if (hasCooldown(state, interaction.user.id))
        return interaction.reply({ content: 'You are on cooldown.', flags: 64 });

      if (state.queue.includes(interaction.user.id))
        return interaction.reply({ content: 'You are already in the queue.', flags: 64 });

      if (state.queue.length >= 20)
        return interaction.reply({ content: 'Queue is full (max 20).', flags: 64 });

      state.queue.push(interaction.user.id);
      await updateQueueMessage(guild, modeName);
      await interaction.reply({ content: 'You joined the queue.', flags: 64 });
      await tryAssignNext(guild, modeName);
    }

    // LEAVE QUEUE
    if (action === 'leaveQueue') {
      state.queue = state.queue.filter(id => id !== interaction.user.id);
      await updateQueueMessage(guild, modeName);
      await interaction.reply({ content: 'You left the queue.', flags: 64 });
    }

    // ACCEPT TEST
    if (action === 'acceptTest') {
      if (!state.testers.has(interaction.user.id))
        return interaction.reply({ content: 'You are not a tester.', flags: 64 });

      if (state.queue[0] !== userId)
        return interaction.reply({ content: 'Queue has changed.', flags: 64 });

      await interaction.reply({ content: 'Opening ticket...', flags: 64 });
      await createTicket(guild, modeName, interaction.user.id, userId);
    }

    // DECLINE TEST
    if (action === 'declineTest') {
      return interaction.reply({ content: 'You declined the test.', flags: 64 });
    }

    // TIER SELECT
    if (action === 'tierSelect') {
      const ticket = state.tickets.get(userId);
      if (!ticket)
        return interaction.reply({ content: 'Ticket not found.', flags: 64 });

      if (ticket.testerId !== interaction.user.id)
        return interaction.reply({ content: 'You are not the assigned tester.', flags: 64 });

      const tierIndex = config.tiers.indexOf(tier);
      const ht3Index = config.tiers.indexOf('HT3');
      const isHigh = tierIndex >= ht3Index;

      const resultsChannel = guild.channels.cache.get(
        isHigh ? config.highResultsChannelId : config.resultsChannelId
      );

      const member = await guild.members.fetch(userId);
      const username = member.user.tag;

      await resultsChannel.send(
        `**${modeName}** — ${username} → Tier **${tier}** (tester: <@${ticket.testerId}>)`
      );

      await interaction.reply({ content: `Tier **${tier}** assigned.`, flags: 64 });
      await closeTicket(guild, modeName, userId, tier);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
