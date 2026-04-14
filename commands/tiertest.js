import {
  SlashCommandBuilder,
  PermissionFlagsBits
} from 'discord.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load JSON (Node 24 compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')
);

export default {
  data: new SlashCommandBuilder()
    .setName('tiertest')
    .setDescription('Tier test management')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(sub =>
      sub
        .setName('starttesting')
        .setDescription('Start testing in this mode')
    )
    .addSubcommand(sub =>
      sub
        .setName('jointesting')
        .setDescription('Join as a tester in this mode')
    )
    .addSubcommand(sub =>
      sub
        .setName('stoptest')
        .setDescription('Stop testing in this mode')
    ),

  async execute(interaction, { modesState, getModeByChannelId, updateQueueMessage, tryAssignNext, showNoTestersMessage }) {
    const sub = interaction.options.getSubcommand();

    // Determine mode from channel
    const mode = getModeByChannelId(interaction.channelId);
    if (!mode) {
      return interaction.reply({
        content: 'This command can only be used in a mode channel.',
        flags: 64
      });
    }

    const member = interaction.member;
    const testerRoleId = config.testerRoleId;

    if (!member.roles.cache.has(testerRoleId)) {
      return interaction.reply({
        content: 'You do not have the tester role.',
        flags: 64
      });
    }

    const state = modesState.get(mode);

    // STARTTESTING / JOINTESTING
    if (sub === 'starttesting' || sub === 'jointesting') {
      const wasEmpty = state.testers.size === 0;

      state.testers.add(interaction.user.id);

      // If this is the first tester → rebuild queue + announcement
      if (wasEmpty) {
        await updateQueueMessage(interaction.guild, mode);

        const channel = interaction.guild.channels.cache.get(state.queueChannelId);
        if (channel) {
          await channel.send({
            content: "||@here|| ||@everyone||\nA tester is now available!"
          });
        }
      }

      await interaction.reply({
        content: `You are now an active tester for **${mode}**.`,
        flags: 64
      });

      await tryAssignNext(interaction.guild, mode);
    }

    // STOPTEST
    if (sub === 'stoptest') {
      if (!state.testers.has(interaction.user.id)) {
        return interaction.reply({
          content: 'You are not testing in this mode.',
          flags: 64
        });
      }

      const hasTicket = [...state.tickets.values()].some(t => t.testerId === interaction.user.id);
      if (hasTicket) {
        return interaction.reply({
          content: 'You still have an open ticket. Close it first.',
          flags: 64
        });
      }

      state.testers.delete(interaction.user.id);

      if (state.testers.size === 0) {
        await showNoTestersMessage(interaction.guild, mode);
      } else {
        await updateQueueMessage(interaction.guild, mode);
      }

      await interaction.reply({
        content: `You stopped testing in **${mode}**.`,
        flags: 64
      });
    }
  }
};
