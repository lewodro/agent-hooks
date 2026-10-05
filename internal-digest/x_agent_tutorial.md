# Local X agent tutorial

This guide runs the [Qwen 2.5 0.5B Instruct model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) through Transformers to draft one Agent Hooks post from context you provide. The implementation follows the model card's chat-template and generation API. By default the bot is dry-run only. Interactive publishing uses `--post` and asks you to type `POST`; unattended publishing is a separate opt-in requiring both `--auto-post` and `X_AGENT_AUTOPUBLISH=true`. Tweepy calls its [v2 `Client.create_tweet`](https://docs.tweepy.org/en/stable/client.html) API using the configured user's X authorization. It does not sign blockchain transactions or access treasury keys.

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

Each operator configures their own X account authorization in a private env file. The default is `.env.agent` at the repository root; `--env-file /path/to/profile.env` can select a separate file per account or deployment. Choose one user-context auth mode. OAuth 1.0a:

```dotenv
X_CONSUMER_KEY=...
X_CONSUMER_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

Or OAuth 2.0 Authorization Code + PKCE user authorization (this must be a user access token, not an app-only bearer token):

```dotenv
X_AUTH_MODE=oauth2
X_USER_ACCESS_TOKEN=...
```

For OAuth 2.0, request only necessary scopes: `tweet.write` to publish, and `tweet.read users.read` if the application also needs to verify the authenticated profile. `offline.access` allows a refresh token for continued user authorization; token issuance and refresh should be handled by a secure deployment credential store. The OAuth 1.0a and OAuth 2.0 user-context flows are supported by Tweepy; app-only bearer tokens cannot publish as a user. See the [X PKCE authorization guide](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) and [Tweepy authentication guide](https://docs.tweepy.org/en/stable/authentication.html).

The file is git-ignored. Never paste credential values into prompts, issues, logs, or commits. X controls app permissions, API access, quotas, and associated costs.

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

## 5. Optional unattended daily publishing

The CLI does not create a scheduler or start a background service. If you choose to run it from your own cron/systemd/hosted scheduler, set `X_AGENT_AUTOPUBLISH=true` in that profile's private env file and invoke `--auto-post`. This is explicit per-profile authorization to let the local model publish without a final prompt. Feed it only verified daily facts, keep the posting account separate from wallet authority, monitor the job, and revoke the X app authorization to stop access. The local ignored history blocks another recorded post on the same UTC day, but it is not a cross-machine quota or durable distributed lock; schedule one publisher per profile.

```dotenv
X_AGENT_AUTOPUBLISH=true
```

```sh
python apps/x-agent-bot/agent_x.py \
  --topic "Agent Hooks daily update" \
  --context "Reviewed facts with links or verifiable project changes." \
  --auto-post
```

Do not enable this mode until you have tested drafts and confirmed that the selected X profile is the intended author. X API access and permissions may require paid or approved access.

## Data and trust boundaries

- Keep source notes, internal digests, model logs, and audit notes under the ignored paths listed in the root `.gitignore`; the tutorial is the only intended public document in this directory.
- Local inference is a drafting aid, not verification. Attach links/evidence to the context and check them independently before posting.
- X credentials are separate from all Solana, Bitcoin, and Ethereum wallet authority. The bot has no wallet SDK, signer, treasury connection, or hook deployment permission.
- This is a prototype. Model outputs can be wrong, and X API posting is a public external action.
