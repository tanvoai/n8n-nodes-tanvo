# n8n-nodes-tanvo

[![npm](https://img.shields.io/npm/v/n8n-nodes-tanvo)](https://www.npmjs.com/package/n8n-nodes-tanvo) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An [n8n](https://n8n.io) community node for [Tanvo](https://tanvo.ai/?utm_source=github&utm_medium=referral), an AI image, video and music studio. Generate images (Nano Banana, Seedream, GPT Image, Qwen, Grok Imagine), short videos with sound (Kling, Veo, Seedance, Wan, MiniMax) and songs (Suno V6), or run one of 80 ready-made photo apps (pet portraits, figurines, old photo restoration, tattoo designs, trend videos) inside your workflows. Results come back as JSON and, optionally, as binary data for the next node.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Example workflows](#example-workflows) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) and install `n8n-nodes-tanvo`:

1. In n8n, open **Settings → Community Nodes** and select **Install**.
2. Enter `n8n-nodes-tanvo` and confirm.

## Credentials

The node uses a Tanvo API key.

1. Sign in at [tanvo.ai](https://tanvo.ai/?utm_source=github&utm_medium=referral) (new accounts start with free credits).
2. Open [Settings → API keys](https://tanvo.ai/settings/apikeys?utm_source=github&utm_medium=referral) and create a key. It starts with `sk_` and is shown once.
3. In n8n, create a **Tanvo API** credential and paste the key. **Base URL** stays `https://tanvo.ai`.

Runs are billed in credits at the same prices as the website; failed runs are refunded automatically. Each model's price is shown in the model list.

## Operations

| Resource | Operation | What it does |
|---|---|---|
| Image | Generate | Text to image, or edit / combine reference images (from URLs or binary fields of earlier nodes) |
| Video | Generate | Text to video, or animate a start frame, with an optional end frame and native audio |
| Music | Generate | A song in two takes: describe it, sing your own lyrics, or go instrumental |
| App | Run | Run one of an app's preset looks (tuned prompt, model and settings) on photos |
| Generation | Get | Status and files of a run started earlier |

Every generate and run operation can **wait for the result** (with a timeout) and **download the files into binary data** (`data`, `data_1`, …), or return the run at once so you can check it later with Generation → Get or receive it on a webhook (set **Options → Webhook URL** to an n8n Webhook node). **Options → Request Key** makes a submission idempotent: a repeat with the same key returns the first run and is not charged again.

The node can also be used as a tool by n8n's AI Agent.

## Example workflows

- **Product photos from a sheet**: Google Sheets (new row with a product photo URL) → Tanvo *App → Run* with the *AI Product Photo Editor* app → Google Drive upload of `data`.
- **Daily social image**: Schedule trigger → Tanvo *Image → Generate* with a prompt built from the date → post the binary to your social account.
- **Pet portraits on demand**: Form trigger with a file upload → Tanvo *App → Run*, *Pet Portrait Generator*, photo source *Binary Fields* → Gmail the result back.
- **Long videos without blocking**: Tanvo *Video → Generate* with *Wait for Result* off and a Webhook URL → a Webhook node receives the finished run.

## Compatibility

Built with `@n8n/node-cli` and tested on n8n 1.x and 2.x (n8n-workflow 2). No external dependencies.

## Resources

- [Tanvo API reference](https://tanvo.ai/developers/api?utm_source=github&utm_medium=referral)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- Also from Tanvo: [tanvo-mcp](https://github.com/tanvoai/tanvo-mcp), [tanvo-js](https://github.com/tanvoai/tanvo-js), [tanvo-python](https://github.com/tanvoai/tanvo-python)

## License

[MIT](LICENSE)
