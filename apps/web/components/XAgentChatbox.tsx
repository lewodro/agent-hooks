"use client";

import { useState, type FormEvent, type JSX } from "react";
import "./XAgentChatbox.css";

export interface XAgentExperience {
  event: string;
  outcome: string;
}

export interface XAgentChatboxProps {
  experiences?: readonly XAgentExperience[];
  onPrompt?: (
    prompt: string,
    experiences: readonly XAgentExperience[],
  ) => Promise<string>;
}

interface Message {
  role: "agent" | "you";
  text: string;
}

function simulateBrainResponse(
  prompt: string,
  experiences: readonly XAgentExperience[],
): string {
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
  const relevant = experiences
    .map((experience) => ({
      experience,
      score: experience.event
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((word) => words.has(word)).length,
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (relevant && relevant.score > 0) {
    return `Local brain recall: “${relevant.experience.event}” → ${relevant.experience.outcome}. I can use this as context for a draft, but it is not chain verification or execution approval.`;
  }
  return "Local preview: I would retrieve related hook outcomes, check their sources, and draft an X update for a human to review. No X post or Solana transaction was sent.";
}

export function XAgentChatbox({
  experiences = [],
  onPrompt,
}: XAgentChatboxProps): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "Harbor local preview ready. Ask about a hook outcome or request an X draft.",
    },
  ]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    setMessages((current) => [...current, { role: "you", text }]);
    setBusy(true);
    try {
      const response = onPrompt
        ? await onPrompt(text, experiences)
        : simulateBrainResponse(text, experiences);
      setMessages((current) => [...current, { role: "agent", text: response }]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: "agent", text: "Preview failed. Check the local agent connection and try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="x-agent" aria-label="X agent local preview">
      <header className="x-agent__header">
        <span className="x-agent__lamp" aria-hidden="true" />
        <span>HARBOR / LOCAL BRAIN</span>
        <span className="x-agent__mode">SIMULATION · NO WALLET</span>
      </header>
      <div className="x-agent__transcript" aria-live="polite" aria-busy={busy}>
        {messages.map((message, index) => (
          <p className={`x-agent__message x-agent__message--${message.role}`} key={`${index}-${message.role}`}>
            <span className="x-agent__speaker">{message.role === "you" ? "YOU" : "AGENT"}</span>
            {message.text}
          </p>
        ))}
        {busy && <p className="x-agent__typing">retrieving local experience…</p>}
      </div>
      <form className="x-agent__form" onSubmit={handleSubmit}>
        <label className="x-agent__prompt-label" htmlFor="x-agent-prompt">PROMPT</label>
        <input
          id="x-agent-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          placeholder="Ask about a hook outcome…"
          maxLength={500}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !prompt.trim()}>
          {busy ? "THINKING" : "RUN PREVIEW"}
        </button>
      </form>
      <p className="x-agent__disclaimer">Local simulation only. Publishing and signing require separate approval flows.</p>
    </section>
  );
}
