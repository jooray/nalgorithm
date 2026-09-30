# Post drafts for the nalgorithm account

Drafts for the `nalgorithm` npub (`npub1dka50zsfvru0tsv2sqd40ktnwyd3236c3hzx62hhlxw9un408tcqz6wkt0`), to be posted through Emanator. Nothing from this file has been published. The account's first post went out on its own at 15:47 on 2026-09-29, written by the user (see below), so the drafts here should not repeat it.

**Already published (2026-09-29 15:47):** "Hello from nalgorithm! I am an open-source algorithm for Nostr, based on _your_ preferences and your likes. I can sort your timeline, but I am also a Nostr client that generates a daily voice digest, for your mornings. I stay positive and interesting. And I say GM. Soon, you'll be able to run me without your own AI API keys. And yes, I can use the new jev to rank the posts, that is fast and fun!" It covers draft 1 (what it is), the gist of 5 and 8 (voice digest, keyless hosted version soon) and 4 (jev). Voice of the account: first person, upbeat, says GM. Rewrite the remaining drafts in that first-person voice rather than the neutral one used below, and skip or shrink 1, 4 and the teaser part of 8.

Each draft says when it can go out. Do not post the ones marked WAIT before the thing they describe exists. Links: app `https://cypherpunk.today/nalgorithm/`, source `https://github.com/jooray/nalgorithm`. Attach the icon (already on Blossom) to the first post if the client does not show the profile picture.

## 1. What it is (POST NOW)

```
Nostr timelines are in the order things were posted, not in the order you'd care about them.

nalgorithm fixes that. Log in with your npub, tell it in a sentence or two what you're interested in, and it scores the last day of posts from people you follow, best first.

It's open source and runs in your browser with your own API key. No account, no server of ours in the middle.

https://cypherpunk.today/nalgorithm/
```

## 2. How the ranking works (POST NOW)

```
How nalgorithm ranks your feed:

1. It fetches the last day of notes from the people you follow.
2. A language model gives each one a score from 0 to 10 against a short description of what you want to see. You write that description.
3. It reads what you've liked and adds a summary of your taste on top.
4. Every score comes with a one-line reason, so you can see why something is at the top and change the prompt if it's wrong.

Nothing is hidden and nothing is optimised for engagement. It's your prompt.
```

## 3. Your keys stay yours (POST NOW)

```
The web app has no backend. Your API key lives in your browser and calls go straight to the model provider you pick (Venice, OpenRouter, Ollama, or any OpenAI-compatible endpoint).

That means it costs what the provider charges and nothing more. It also means you can read the code and check that this is what it does.

MIT licence: https://github.com/jooray/nalgorithm
```

## 4. Cheap scoring (POST NOW, wording is deliberately careful)

```
Scoring posts is high volume and low difficulty, so the model matters less than the price.

nalgorithm can use Venice's jev-latest decision model for it. It's listed at $0.042 per million input tokens and nothing for output. That's a small fraction of a cent per post, so ranking a whole day of your follows costs about as much as a rounding error.

(It's marked beta on their side, so the chat models stay available as a fallback.)
```

Checked against Venice's model list on 2026-09-29. Drop the "small fraction of a cent" line if you'd rather not put a number on it; the arithmetic assumes roughly 300 tokens per post.

## 5. The voice digest (WAIT for a sample)

```
The other thing nalgorithm does: it takes the top posts of the day and turns them into a short spoken digest, like a radio host catching you up.

The text is written by a model, run through a pass that strips the usual AI-sounding phrases, and read out loud by a text-to-speech voice. I listen to mine over coffee.

Here's one from this morning: [audio link]
```

Needs an example digest and its audio. It has not been generated yet: running it needs the digest config, which holds live keys, so it should be run by you or with a config you approve. Quoting other people's notes in a public audio clip is worth a thought; safest is a digest from a feed of accounts that agreed, or just your own posts.

## 6. The humanizer pass (POST NOW, optional)

```
Small thing I like about the digest: before it gets read aloud, a second model pass removes the tells. No "pivotal", no "testament to", no "it's not X, it's Y", no lists of three where two would do.

The rules come from Wikipedia's "Signs of AI writing" page. The pass is a separate open source skill, so anything that writes text can use it: https://github.com/jooray/humanizer
```

## 7. This account (POST NOW)

```
About this account: it's a bot, run by @jooray. It will post about nalgorithm releases and will eventually deliver digests by DM.

It doesn't follow anyone yet and it doesn't reply to mentions. If something's broken, the issue tracker is at https://github.com/jooray/nalgorithm
```

Check the DM sentence: "eventually" is accurate, DM delivery does not exist yet. Also check the mention: the draft uses a plain `@jooray`; in Emanator use the real npub mention.

## 8. Hosted version (WAIT until it is live)

```
A hosted version of nalgorithm is coming for people who don't want to bring an API key.

10,000 sats a month, paid over Lightning and tied to your npub, not to an account. You get the ranked feed on the web and a daily voice digest sent to you as a Nostr DM. Three days free to try it.

Bring-your-own-key stays free and stays the same code.
```

Do not post before the billing service, the server and the DM delivery are running. Prices and the trial length are the decided numbers as of 2026-09-29.

## 9. Activation over Nostr (WAIT, later phase)

```
You'll be able to set it all up without opening a browser: DM the account your prompt and your settings, zap it to pay. Zap a friend's npub in the comment and they get the time instead.
```

Only after zap activation and DM commands are built; neither exists.

## 10. Ask for feedback (POST NOW)

```
If you use nalgorithm: what did it rank wrong? A prompt that didn't work, a post that should have been at the top, a follow that drowns everything else. I'm collecting those to improve the scoring.

Reply here or open an issue.
```

Only post the reply invitation if you'll actually monitor replies (the account does not reply on its own).

## Suggested order

Posts 1, 2, 3 over the first days, 7 alongside the first, 4 and 6 later in the week, 10 at the end. Hold 5 until there is a sample, and 8 and 9 until the service exists.
