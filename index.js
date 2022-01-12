import Bolt from "@slack/bolt";
import vm from "vm";
import fs from "fs";
import { JSDOM } from "jsdom";
import { PORT, CLIENT_SECRET, CLIENT_ID } from "./config.js";
import fetch from "node-fetch";
import timezonedDate from "timezoned-date";
import express from "express";
import bodyParser from "body-parser";

// make an array of the alphabet, we'll need this later
const alpha = Array.from(Array(26)).map((e, i) => i + 65);
const alphabet = alpha.map((x) => String.fromCharCode(x));

// in-memory storage of GameApps (the actual wordle logic)
let games = {};

// in-memory storage of game displays (the id of the parent message)
let gameDisplays = {};
let GameApp;
let jsText;

// get the wordle page, pull out the JS url, and then fetch that JS
const page = await fetch("https://www.powerlanguage.co.uk/wordle/");
const pageText = await page.text();
const regex = /main.([a-zA-Z0-9])+.js/g;
const filename = pageText.match(regex);
if (filename) {
    const url = `https://www.powerlanguage.co.uk/wordle/${filename}`;
    const js = await fetch(url);
    jsText = await js.text();
}

// express initialization
var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", async function (req, res) {
    console.log(req.query);
    if (req.query.code) {
        const authResponse = await fetch(
            `https://slack.com/api/oauth.v2.access?code=${req.query.code}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
        );
        const response = await authResponse.json();
        let rawfile = fs.readFileSync("tokens.json");
        let tokens = JSON.parse(rawfile);
        tokens[response.team.id] = response.access_token;
        fs.writeFileSync("tokens.json", JSON.stringify(tokens));
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// start the game and compose+send the parent message - reply logic is further down
app.post("/", async function (req, res) {
    console.log(req.body);
    const rawfile = fs.readFileSync("tokens.json");
    const tokens = JSON.parse(rawfile);
    const oauthToken = tokens[req.body.team_id];
    // get the users timezone so we can pull the correct wordle puzzle
    const userInfoResponse = await fetch(
        `https://slack.com/api/users.info?user=${req.body.user_id}`,
        {
            method: "get",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Bearer ${oauthToken}`,
            },
        }
    );
    const userInfo = await userInfoResponse.json();
    console.log(userInfo);
    // set Date so that it reflects the user's timezone
    global.Date = timezonedDate.makeConstructor(
        (userInfo.user.tz_offset || 0) / 60
    );
    // create new virtual DOM for wordle to live in and hook up some globals
    global.window = new JSDOM("", {
        url: "https://www.powerlanguage.co.uk/",
    }).window;
    global.document = global.window.document;
    global.HTMLElement = window.HTMLElement;
    global.customElements = window.customElements;
    global.dataLayer = window.dataLayer || [];
    // run the JS in the node VM and put the game in memory
    const v = vm.runInThisContext(jsText);
    GameApp = v.GameApp;
    res.send("");
    // namespace this game against the user id so multiple games can be running
    games[req.body.user_id] = new GameApp();
    const game = games[req.body.user_id];
    // wordle does some DOM things here
    game.connectedCallback();
    // post the initial message
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "post",
        body: JSON.stringify({
            channel: req.body.channel_id,
            text: `<@${req.body.user_id}>'s Wordle ${game.dayOffset} 0/6

🔲🔲🔲🔲🔲`,
            response_type: "in_channel",
        }),
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${oauthToken}`,
        },
    });
    const resJson = await resp.json();
    gameDisplays[req.body.user_id] = resJson.message.ts;
    // start the thread
    await fetch("https://slack.com/api/chat.postMessage", {
        method: "post",
        body: JSON.stringify({
            channel: req.body.channel_id,
            thread_ts: resJson.message.ts,
            text: `<@${req.body.user_id}>, post your guesses here!`,
            response_type: "in_channel",
        }),
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${oauthToken}`,
        },
    });
});

// reply when someone posts in a wordle thread
app.post("/slack/events", async function (req, res) {
    console.log(req.body);
    const rawfile = fs.readFileSync("tokens.json");
    const tokens = JSON.parse(rawfile);
    const oauthToken = tokens[req.body.team_id];
    // this is just so slack registers the url
    if (req.body.challenge) {
        res.send(req.body.challenge);
    } else {
        res.sendStatus(200);
        const { user, channel, thread_ts, text } = req.body.event;
        // check that we have a parent message for this user
        if (gameDisplays[user] && gameDisplays[user] === thread_ts) {
            const wordEvalStrings = [];
            const publicRowEvals = [];
            const game = games[user];
            // don't go further if there are spaces
            if (text.includes(" ")) {
                return;
            }
            // dont go further if the word isnt 5 letters
            if (text.length != 5) {
                await fetch("https://slack.com/api/chat.postMessage", {
                    method: "post",
                    body: JSON.stringify({
                        channel: channel,
                        thread_ts: thread_ts,
                        text: `Word should be 5 letters long.`,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${oauthToken}`,
                    },
                });
                return;
            }
            var chars = text.split("");
            chars.forEach((c) => game.addLetter(c));
            game.submitGuess();
            game.tileIndex = 0;
            game.canInput = true;
            const boardStateFiltered = game.boardState.filter((r) => !!r);
            // throw an error and erase the row if the word's not in the word list
            if (game.rowIndex !== boardStateFiltered.length) {
                await fetch("https://slack.com/api/chat.postMessage", {
                    method: "post",
                    body: JSON.stringify({
                        channel: channel,
                        thread_ts: thread_ts,
                        text: `Word not in word list!`,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${oauthToken}`,
                    },
                });
                game.boardState[boardStateFiltered.length - 1] = "";
            } else {
                // parse the game's row evaluation and compose the square grid
                game.boardState.forEach((row, idx) => {
                    console.log("BOARD", idx, row);
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
                        publicRowEvals.push(rowEvalString);
                        wordEvalStrings.push(
                            `${row.toUpperCase()} ${rowEvalString}`
                        );
                    }
                });
                // update the parent message with the new row
                await fetch("https://slack.com/api/chat.update", {
                    method: "post",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${oauthToken}`,
                    },
                    body: JSON.stringify({
                        channel: channel,
                        ts: gameDisplays[user],
                        text: `<@${user}>'s Wordle ${game.dayOffset} ${
                            game.rowIndex
                        }/6
        
${publicRowEvals.join("\n")}`,
                    }),
                });
                // post the reply for the current guess
                await fetch("https://slack.com/api/chat.postMessage", {
                    method: "post",
                    body: JSON.stringify({
                        channel: channel,
                        thread_ts: thread_ts,
                        text: `\`\`\`${wordEvalStrings.join("\n")}\`\`\`
            
🟩 ${Object.keys(game.letterEvaluations)
                            .filter(
                                (k) => game.letterEvaluations[k] === "correct"
                            )
                            .join(" ")
                            .toUpperCase()}
🟨 ${Object.keys(game.letterEvaluations)
                            .filter(
                                (k) => game.letterEvaluations[k] === "present"
                            )
                            .join(" ")
                            .toUpperCase()}
⬛️ ${Object.keys(game.letterEvaluations)
                            .filter(
                                (k) => game.letterEvaluations[k] === "absent"
                            )
                            .join(" ")
                            .toUpperCase()}
⬜️ ${alphabet
                            .filter(
                                (l) =>
                                    !Object.keys(
                                        game.letterEvaluations
                                    ).includes(l.toLowerCase())
                            )
                            .join(" ")}`,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${oauthToken}`,
                    },
                });
                // if the problem is solved, delete the game
                const filteredEvalutations = game.evaluations.filter(
                    (e) => !!e
                );
                if (
                    filteredEvalutations[filteredEvalutations.length - 1].every(
                        (i) => i === "correct"
                    )
                ) {
                    delete games[user];
                    delete gameDisplays[user];
                }
            }
        }
    }
});

app.listen(PORT, function () {
    console.log("Wordle listening on port " + PORT + "!");
});
