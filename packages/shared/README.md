# @openfilm/shared

What Framino's clients share: a chat turn and the events a client sees, how an agent's activity reads, prompt
references, title limits and Markdown parsing.

```ts
import { buildPromptDisplay, type Turn } from '@openfilm/shared';
import { scanMarkdownBlocks } from '@openfilm/shared/markdown';
```

Part of [Framino](https://github.com/openfilm/openfilm). MIT licensed.
