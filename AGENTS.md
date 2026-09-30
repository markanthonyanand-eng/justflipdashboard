# Instructions for coding agents

Before changing landing-page generation, read [LANDING-PAGE-WORKFLOW.md](./LANDING-PAGE-WORKFLOW.md). It records the working AURELIA House flow, the project-fact isolation rules, the OpenCode/Gemini engine behavior, and the requirements for adding direct local LLM support.

Keep the staging-and-validation publish path intact: failed generations must not replace the current live page. A self-contained project brief owns its facts and media; do not merge in data from the currently selected dashboard project. Verify the actual staging file exists; never treat an agent's text claiming it wrote the file as proof.

Current local-model support means configuring OpenCode to use a local model. The dashboard does not yet connect directly to a local model endpoint. Keep that distinction clear and follow the workflow note if implementing a direct local provider.
