# tracebac: design

## The idea
The three sample questions sound like search questions, but each one really means "remember what we talked about, then tell me what has changed since". Web search is the easy half. Memory is the hard half, so I built the agent around it.

tracebac is a ledger with a chat on top. Every answer is saved as dated claims, each with its source and the exact quote it came from. The model decides where a message goes and writes research answers. Code does everything that has to be exact: dates, finding the old conversation, re-checking sources, and counting what changed.

## How a question is handled
- **Route.** One small model call decides what kind of message it is and rewrites a follow-up as a full question ("games before that?" becomes a question about the right team). Guards in code catch the costly mistakes: a question about the past never goes to the web, and a factual question is never answered from the model's memory. "hi" and "thanks" don't use a model at all.
- **Dates.** "Last Tuesday" or "3 November" is worked out by code, using the timezone saved with each message. The model never does date maths. If nothing matches, the reply is built by code, so it can't invent a conversation that never happened.
- **Research.** Searches run in parallel, pages are read, and the answer cites numbered sources. For questions about now it also searches the last 30 days and shows each source's publish date. Afterwards a background step saves the answer as claims.
- **Re-check.** The old sources are fetched again. If the saved quote is still on the page, the claim is unchanged, with no model needed. Anything else goes to one batched model call that must quote its evidence, or the answer says "couldn't confirm". The "1 of 5 changed" summary is counted and written by code.

## Memory
One SQLite file, no setup. There are no embeddings or vector database: these questions point at the past by date, topic and name, which a normal database finds exactly. Embeddings would add another rate-limited service to every message for no gain.

## Built for free tiers
There are no paid keys, so rate limits shaped the design. Each model role falls back across Cerebras, Groq, Gemini and OpenRouter, and search falls back across Tavily, Exa and Serper. The quote check keeps re-checks cheap. The cost is that answers are plainer than a paid model's, and a long session can run out of quota. When that happens the app shows the sources it found instead of failing.

## Considered and rejected
- **A search loop with the whole transcript in context:** it can't find "last Tuesday", and every step costs a rate-limited request.
- **Vector memory:** "3 November" isn't close in meaning to anything.
- **Summarising history:** it loses the exact price and source, so nothing can be re-checked.
- **The model doing date maths or writing the change report:** confident mistakes.
- **Answering from the model's memory when it feels sure:** it once listed last season's fixtures, including a player who had left the club.

## Limits
- Free search returns blogs often, so some answers rest on secondary sources.
- A tool added after the original conversation has no earlier record to compare, and the answer says so.
- The free writer models can still misread a source (one flipped a score).
- A fresh clone has no history. `npm run replay` creates some.

## With another week
1. Capture a baseline on demand for names with no earlier record.
2. Typed prices and units, so changes read like "+16%, $80 more for 20 seats".
3. Standing watches: "tell me when any of these changes".
4. Local embeddings, once history is big enough that keyword search misses paraphrases.
