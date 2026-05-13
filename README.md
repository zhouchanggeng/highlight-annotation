# Highlight Annotation

Highlight Annotation is an Obsidian plugin for collecting, annotating, searching, and managing Markdown highlights.

## Features

- List highlights written as `==highlight text==` in the current note or across the vault.
- Store annotations outside Markdown in `.highlight-annotation/highlights/*.json`.
- Add multiple comments to the same highlight.
- Edit or delete a single comment.
- Clear all comments for a highlight while keeping the highlight.
- Delete a highlight and its annotations together.
- Preview annotations by hovering over highlighted text.
- Search highlight text, comments, and file paths with matched text rendering.
- Ignore files or folders during vault-wide scans.
- Generate comments with an OpenAI-compatible API from the annotation modal.

## Installation With BRAT

1. Install the BRAT plugin in Obsidian.
2. Open the command palette.
3. Run `BRAT: Add a beta plugin for testing`.
4. Enter this repository:

   ```text
   https://github.com/zhouchanggeng/highlight-annotation
   ```

5. Enable `Highlight Annotation` in Obsidian community plugins.

## Manual Installation

Copy these files into your vault:

```text
.obsidian/plugins/highlight-annotation/manifest.json
.obsidian/plugins/highlight-annotation/main.js
.obsidian/plugins/highlight-annotation/styles.css
```

Then reload Obsidian and enable the plugin.

## Annotation Storage

Annotations are stored in the vault under:

```text
.highlight-annotation/highlights/
.highlight-annotation/metadata/
```

Markdown files keep only the normal highlight syntax:

```markdown
==highlight text==
```

The plugin does not write annotation comments into the Markdown body.

## AI Annotation

The plugin supports OpenAI-compatible chat completion APIs. Configure the API URL, API key, model, temperature, and prompt in plugin settings. The API key is stored locally in Obsidian plugin data and is not included in this repository.

## Notes

- This plugin is designed for desktop and mobile Obsidian, but AI requests depend on network availability and the configured provider.
- Do not publish your local `data.json` or `.highlight-annotation/` folder if you fork or redistribute the plugin.
