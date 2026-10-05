# Local X agent tutorial

This guide runs the [Qwen 2.5 0.5B Instruct model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) through Transformers to draft one Agent Hooks post from context you provide. The implementation follows the model card's chat-template and generation API. By default the bot is dry-run only. Publishing needs the `--post` flag, X write credentials, and typing `POST` after reviewing the generated text. Tweepy calls its [v2 `Client.create_tweet`](https://docs.tweepy.org/en/stable/client.html) API only after that confirmation. It does not sign Solana transactions or access treasury keys.

The first model run downloads `Qwen/Qwen2.5-0.5B-Instruct` from Hugging Face and caches it locally. CPU inference works but can be slow; install a compatible PyTorch build for your machine using the [official PyTorch instructions](https://pytorch.org/get-started/locally/). Qwen's Transformers model card demonstrates the `apply_chat_template` generation path used here.

## 1. Install

From the repository root:

```sh
python3 -m venv .venv-x-agent
source .venv-x-agent/bin/activate
python -m pip install --upgrade pip
python -m pip install -r apps/x-agent-bot/requirements.txt
```

## 2. Configure X posting (optional)

Create `.env.agent` at the repository root. Keep the account credentials private and use a dedicated X app with only the access it needs:

```dotenv
X_CONSUMER_KEY=...
X_CONSUMER_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

The file is git-ignored. Never paste these values into prompts, issues, logs, or commits. X API account/app permissions and access are controlled by X and may require paid or approved API access.

## 3. Draft locally

Pass a topic plus factual, reviewed context. The model is instructed to treat context as source material rather than instructions and not invent transaction or performance claims.

```sh
python apps/x-agent-bot/agent_x.py \
  --topic "Agent Hooks development update" \
  --context "Today we added an Anchor 0.31 policy example that checks output slippage and a slot cooldown. It is an example integration, not deployed."
```

Review every claim. The bot prints the draft and exits without calling X.

## 4. Publish one reviewed post

When the X credentials are configured, run with `--post`. The bot prints the final draft, then waits for the exact confirmation `POST`. It refuses a second recorded post on the same UTC day. Posting records go to ignored `internal-digest/x_agent_posts.jsonl`.

```sh
python apps/x-agent-bot/agent_x.py \
  --topic "Agent Hooks development update" \
  --context "Reviewed, verifiable update goes here." \
  --post
```

The repo intentionally does not run a background scheduler: a human runs this workflow when the daily facts are ready. Automating a scheduled publisher would require explicit deployment, monitoring, account approval, and a separate decision about the human-review gate.

## Data and trust boundaries

- Keep source notes, internal digests, model logs, and audit notes under the ignored paths listed in the root `.gitignore`; the tutorial is the only intended public document in this directory.
- Local inference is a drafting aid, not verification. Attach links/evidence to the context and check them independently before posting.
- X credentials are separate from any Solana wallet. The bot has no wallet SDK, signer, treasury connection, or hook deployment permission.
- This is a prototype. Model outputs can be wrong, and X API posting is a public external action.
