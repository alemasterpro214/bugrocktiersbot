import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import tiertestCommand from './commands/tiertest.js';

const commands = [tiertestCommand.data.toJSON()];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Aggiornamento comandi slash...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Comandi registrati.');
  } catch (error) {
    console.error(error);
  }
})();
