import {
    Client,
    Intents,
    MessageActionRow,
    MessageButton,
    MessageEmbed,
} from "discord.js";
import vm from "vm";
import { JSDOM } from "jsdom";
import { BOT_TOKEN, PORT, OAUTH_TOKEN } from "./config.js";
import fetch from "node-fetch";
import timezonedDate from "timezoned-date";
import express from "express";
import bodyParser from "body-parser";

const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES],
});

let games = {};
let gameDisplays = {};
let GameApp;
const page = await fetch("https://www.powerlanguage.co.uk/wordle/");
const pageText = await page.text();
const regex = /main.([a-zA-Z0-9])+.js/g;
const filename = pageText.match(regex);
if (filename) {
    const url = `https://www.powerlanguage.co.uk/wordle/${filename}`;
    const js = await fetch(url);
    const jsText = await js.text();
    global.window = new JSDOM("", {
        url: "https://www.powerlanguage.co.uk/",
    }).window;
    global.Date = timezonedDate.makeConstructor(-600);
    global.document = global.window.document;
    global.HTMLElement = window.HTMLElement;
    global.customElements = window.customElements;
    global.dataLayer = window.dataLayer || [];
    const res = vm.runInThisContext(jsText);
    // games[] = new res.GameApp();
    GameApp = res.GameApp;
    // console.log(GameApp.solution.substr(0, 1));
}

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    interaction.reply("foo");
});

client.on("ready", async () => {
    console.log("ready");
});

client.login(BOT_TOKEN);
var app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.get("/", function (req, res) {
    res.send("foo");
});

app.post("/", async function (req, res) {
    // console.log(req.body, gameApp.dayOffset);
    if (req.body.payload) {
        const payload = JSON.parse(req.body.payload);
        const game = games[payload.user.id];
        console.log(payload);
        var chars = payload.actions[0].value.split("");
        chars.forEach((c) => game.addLetter(c));
        game.submitGuess();
        game.tileIndex = 0;
        game.canInput = true;
        console.log(game.evaluations, game.letterEvaluations, game.boardState);
        const wordEvalStrings = [];
        const publicRowEvals = [];
        game.boardState.forEach((row, idx) => {
            if (row !== "") {
                let rowEvalString = "";
                game.evaluations[idx].forEach((e) => {
                    if (e === "correct") {
                        rowEvalString += "🟩";
                    }
                    if (e === "present") {
                        rowEvalString += "🟨";
                    }
                    if (e === "absent") {
                        rowEvalString += "⬛️";
                    }
                });
                wordEvalStrings.push(`${row.toUpperCase()} ${rowEvalString}`);
                publicRowEvals.push(rowEvalString);
            }
        });
        const ures = await fetch("https://slack.com/api/chat.update", {
            method: "post",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OAUTH_TOKEN}`,
            },
            body: JSON.stringify({
                channel: payload.channel.id,
                ts: gameDisplays[payload.user.id],
                text: `*${payload.user.username}'s* Wordle ${game.dayOffset} ${
                    game.rowIndex
                }/6

${publicRowEvals.join("\n")}`,
            }),
        });
        console.log(await ures.text());
        await fetch(payload.response_url, {
            method: "post",
            body: JSON.stringify({
                replace_original: true,
                blocks: [
                    {
                        type: "input",
                        element: {
                            type: "plain_text_input",
                            action_id: `${game.dayOffset}|`,
                        },
                        label: {
                            type: "plain_text",
                            text: "Guess a word:",
                            emoji: false,
                        },
                        dispatch_action: true,
                    },
                    {
                        type: "section",
                        text: {
                            type: "plain_text",
                            text: `${wordEvalStrings.join("\n")}

🟩 ${Object.keys(game.letterEvaluations)
                                .filter(
                                    (k) =>
                                        game.letterEvaluations[k] === "correct"
                                )
                                .join(" ")
                                .toUpperCase()}
🟨 ${Object.keys(game.letterEvaluations)
                                .filter(
                                    (k) =>
                                        game.letterEvaluations[k] === "present"
                                )
                                .join(" ")
                                .toUpperCase()}
⬛️ ${Object.keys(game.letterEvaluations)
                                .filter(
                                    (k) =>
                                        game.letterEvaluations[k] === "absent"
                                )
                                .join(" ")
                                .toUpperCase()}`,
                        },
                    },
                ],
            }),
            headers: { "Content-Type": "application/json" },
        });
    } else {
        games[req.body.user_id] = new GameApp();
        const game = games[req.body.user_id];
        game.connectedCallback();
        // await fetch(req.body.response_url, {
        console.log(req.body.channel_id);
        const resp = await fetch("https://slack.com/api/chat.postMessage", {
            method: "post",
            body: JSON.stringify({
                channel: req.body.channel_id,
                text: `*${req.body.user_name}'s* Wordle ${game.dayOffset} 0/6

🔲🔲🔲🔲🔲`,
                response_type: "in_channel",
            }),
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OAUTH_TOKEN}`,
            },
        });
        const resJson = await resp.json();
        gameDisplays[req.body.user_id] = resJson.message.ts;
        res.json({
            blocks: [
                {
                    type: "input",
                    element: {
                        type: "plain_text_input",
                        action_id: `${game.dayOffset}|`,
                    },
                    label: {
                        type: "plain_text",
                        text: "Guess a word:",
                        emoji: false,
                    },
                    dispatch_action: true,
                },
            ],
        });
    }
});

app.listen(PORT, function () {
    console.log("Wordle listening on port " + PORT + "!");
});
