---
name: exa-search
description: Fast AI-powered web search. Uses Exa API when available, falls back to agent-browser + DuckDuckGo automatically. Prefer this over agent-browser for general web research.
allowed-tools: Bash(exa-search:*)
---

# Web Search with exa-search

Fast web search that automatically falls back to browser search if the Exa API quota is exhausted or unavailable.

## Usage

```bash
exa-search "your query"                  # Basic search (5 results)
exa-search "your query" --num 10         # More results
exa-search "your query" --type fast      # Faster, slightly lower quality
exa-search "your query" --type deep      # Slower, higher quality (runs multiple query variations)
exa-search "your query" --highlights     # Key excerpts instead of full text (saves tokens)
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--num N` | 5 | Number of results to return |
| `--type` | auto | `auto` (balanced), `fast`, or `deep` |
| `--highlights` | off | Return key excerpts instead of full page text |

## Notes

- Returns title, URL, and content for each result
- If the Exa API quota is exhausted or the key is missing, automatically falls back to DuckDuckGo via agent-browser
- Use `--highlights` to reduce token usage when you only need key excerpts, not full content
- Use `--type deep` for research tasks where quality matters more than speed
