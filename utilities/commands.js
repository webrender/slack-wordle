import { Client, Intents } from "discord.js";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import { SlashCommandBuilder } from "@discordjs/builders";
import {
    BOT_TOKEN,
    CLIENT_ID,
    GUILD_ID,
    COMMAND_PERMISSIONS,
} from "../config.js";

const commands = [
    new SlashCommandBuilder()
        .setName("wordle")
        .setDescription("Play Wordle.")
        .addStringOption((option) =>
            option
                .setName("word")
                .setDescription("Your guess.")
                .setRequired(true)
        ),
];

(async function () {
    const commandJson = [];
    commands.forEach((command) => {
        commandJson.push(command.toJSON());
    });

    try {
        // register the commands
        console.log("Started refreshing application (/) commands.");
        const rest = new REST({ version: "9" }).setToken(BOT_TOKEN);
        const res = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            {
                body: commands,
            }
        );

        console.log(res);
        console.log("Successfully reloaded application (/) commands.");

        // register the command permissions
        const client = new Client({
            intents: [
                Intents.FLAGS.GUILDS,
                Intents.FLAGS.GUILD_MESSAGES,
                Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
                Intents.FLAGS.GUILD_MEMBERS,
                Intents.FLAGS.GUILD_PRESENCES,
            ],
        });

        client.on("ready", async () => {
            if (!client.application?.owner) await client.application?.fetch();

            await Promise.all(
                res.map(async (cmd) => {
                    const c = COMMAND_PERMISSIONS.find(
                        (p) => p.name === cmd.name
                    );
                    if (c) {
                        const command = await client.guilds.cache
                            .get(GUILD_ID)
                            ?.commands.fetch(cmd.id);

                        const response = await command.permissions.set({
                            permissions: c.permissions,
                        });
                        console.log(response);
                    }
                })
            );

            client.destroy();
        });

        client.login(BOT_TOKEN);
    } catch (error) {
        console.error(error);
    }
})();
