const { ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, normalizePath, requestUrl } = require("obsidian");
const { Decoration, ViewPlugin } = require("@codemirror/view");

const MARK_CLASS = "hl-annotation";
const VIEW_TYPE_ANNOTATION_LIST = "highlight-annotation-list";
const LEGACY_VIEW_TYPE_FLASHCARD_REVIEW = "highlight-flashcard-review";
const ANNOTATION_PREFIX = "hl-annotation:";
const HIDDEN_COMMENT_CLASS = "hl-annotation-hidden-comment";
const EXTERNAL_STORAGE_DIR = ".highlight-annotation";
const EXTERNAL_HIGHLIGHTS_DIR = `${EXTERNAL_STORAGE_DIR}/highlights`;
const EXTERNAL_METADATA_DIR = `${EXTERNAL_STORAGE_DIR}/metadata`;
const EXTERNAL_FILE_MAPPING_PATH = `${EXTERNAL_METADATA_DIR}/file-mapping.json`;
const HOVER_TOOLTIP_DELAY_MS = 1200;
const FILE_SWITCH_EDITOR_STALE_GUARD_MS = 300;
const DEFAULT_IGNORE_PATTERNS = [
  ".excalidraw",
  "Spaces/Archives/"
];
const DEFAULT_GENERAL_SETTINGS = {
  openSourceOnDeleteHighlight: true,
  saveWordTranslations: true,
  wordBookPath: "Sources/\u5355\u8bcd/\u82f1\u6587\u5355\u8bcd\u672c.md"
};
const DEFAULT_AI_SETTINGS = {
  enabled: false,
  apiUrl: "https://api.openai.com/v1/chat/completions",
  apiKeySecretId: "",
  model: "gpt-4.1-mini",
  temperature: 0.2,
  prompt:
    "\u8bf7\u4e3a\u4e0b\u9762\u8fd9\u6bb5\u9ad8\u4eae\u6587\u5b57\u5199\u4e00\u6761\u7b80\u6d01\u3001\u6709\u6d1e\u5bdf\u529b\u7684\u4e2d\u6587\u6279\u6ce8\u3002\u8981\u6c42\uff1a\u89e3\u91ca\u5173\u952e\u542b\u4e49\uff0c\u6307\u51fa\u503c\u5f97\u8bb0\u4f4f\u7684\u70b9\uff1b\u4e0d\u8981\u590d\u8ff0\u539f\u6587\uff1b\u63a7\u5236\u5728 1-3 \u53e5\u8bdd\u3002\n\n\u9ad8\u4eae\u6587\u5b57\uff1a{{text}}"
};
const DEFAULT_AI_API_KEY_SECRET_ID = "highlight-annotation-ai-api-key";
const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 36500;
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;
const FSRS_WEIGHTS = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034,
  0.6567
];

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeHtml(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeHighlightText(value) {
  return normalizeText(String(value ?? "").replace(/^==/, "").replace(/==$/, ""));
}

function normalizeExternalComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .filter((comment) => comment && String(comment.content ?? "").trim())
    .map((comment, index) => ({
      id: comment.id ?? `comment-${comment.created ?? Date.now()}-${index}`,
      content: String(comment.content ?? "").trim(),
      created: comment.created ?? Date.now(),
      updated: comment.updated ?? comment.created ?? Date.now()
    }));
}

function getCommentsText(comments) {
  return normalizeExternalComments(comments)
    .map((comment) => comment.content)
    .join("\n\n");
}

function getSearchNeedle(query) {
  return normalizeText(String(query ?? ""));
}

function renderHighlightedText(containerEl, text, query) {
  containerEl.empty();
  const source = String(text ?? "");
  const needle = getSearchNeedle(query);
  if (!needle) {
    containerEl.appendText(source);
    return;
  }

  const sourceLower = source.toLowerCase();
  const needleLower = needle.toLowerCase();
  let cursor = 0;
  let index = sourceLower.indexOf(needleLower);

  while (index >= 0) {
    if (index > cursor) {
      containerEl.appendText(source.slice(cursor, index));
    }

    containerEl.createEl("mark", {
      cls: "hl-annotation-search-hit",
      text: source.slice(index, index + needle.length)
    });
    cursor = index + needle.length;
    index = sourceLower.indexOf(needleLower, cursor);
  }

  if (cursor < source.length) {
    containerEl.appendText(source.slice(cursor));
  }
}

function getLineNumber(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

function getHighlightSignature(content) {
  return parseAnnotations(content)
    .map((annotation) => `${annotation.start}:${annotation.end}:${normalizeText(annotation.text)}`)
    .join("|");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeWordText(value) {
  return String(value ?? "")
    .trim()
    .replace(/[“”"'`.,!?;:()[\]{}<>，。！？；：（）【】《》]/g, "")
    .replace(/\s+/g, " ");
}

function isLikelyEnglishWord(value) {
  const word = normalizeWordText(value);
  return Boolean(word && /^[A-Za-z][A-Za-z\s-]*$/.test(word) && word.length <= 80);
}

function stripMarkdownFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseJsonText(value) {
  return JSON.parse(String(value ?? "").replace(/^\uFEFF/, ""));
}

function dateOnly(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function daysBetween(left, right) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((dateOnly(right).getTime() - dateOnly(left).getTime()) / msPerDay));
}

function getRetrievability(elapsedDays, stability) {
  if (!stability) {
    return 0;
  }

  return Math.pow(1 + FSRS_FACTOR * elapsedDays / stability, FSRS_DECAY);
}

function nextInterval(stability) {
  const interval = stability / FSRS_FACTOR * (Math.pow(DESIRED_RETENTION, 1 / FSRS_DECAY) - 1);
  return clamp(Math.round(interval), 1, MAX_INTERVAL_DAYS);
}

function initialDifficulty(rating) {
  return clamp(FSRS_WEIGHTS[4] - Math.exp((rating - 1) * FSRS_WEIGHTS[5]) + 1, 1, 10);
}

function initialStability(rating) {
  return Math.max(FSRS_WEIGHTS[rating - 1], 0.1);
}

function nextDifficulty(difficulty, rating) {
  const delta = -FSRS_WEIGHTS[6] * (rating - 3);
  const next = difficulty + meanReversion(FSRS_WEIGHTS[4], delta * (10 - difficulty) / 9);
  return clamp(next, 1, 10);
}

function meanReversion(init, current) {
  return FSRS_WEIGHTS[7] * init + (1 - FSRS_WEIGHTS[7]) * current;
}

function nextRecallStability(difficulty, stability, retrievability, rating) {
  const hardPenalty = rating === 2 ? FSRS_WEIGHTS[15] : 1;
  const easyBonus = rating === 4 ? FSRS_WEIGHTS[16] : 1;
  return stability * (
    1 +
    Math.exp(FSRS_WEIGHTS[8]) *
      (11 - difficulty) *
      Math.pow(stability, -FSRS_WEIGHTS[9]) *
      (Math.exp((1 - retrievability) * FSRS_WEIGHTS[10]) - 1) *
      hardPenalty *
      easyBonus
  );
}

function nextForgetStability(difficulty, stability, retrievability) {
  return Math.min(
    FSRS_WEIGHTS[11] *
      Math.pow(difficulty, -FSRS_WEIGHTS[12]) *
      (Math.pow(stability + 1, FSRS_WEIGHTS[13]) - 1) *
      Math.exp((1 - retrievability) * FSRS_WEIGHTS[14]),
    stability
  );
}

function createCardId(path, line, text) {
  return `${path}::${line}::${normalizeText(text).slice(0, 160)}`;
}

function createExternalId(path, start, text) {
  const seed = `${path}::${start}::${normalizeText(text)}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return `ha-${hash.toString(36)}-${start}`;
}

function toSafeExternalFileName(path) {
  return `${path
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .toLowerCase()}.json`;
}

function normalizeIgnorePatterns(patterns) {
  if (Array.isArray(patterns)) {
    return patterns.map((pattern) => String(pattern).trim()).filter(Boolean);
  }

  if (typeof patterns === "string") {
    return patterns
      .split(/\r?\n|,/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
  }

  return [...DEFAULT_IGNORE_PATTERNS];
}

function matchesIgnorePattern(filePath, pattern) {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const normalizedPattern = pattern.replace(/\\/g, "/").trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith("/")) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  if (normalizedPattern.includes("/")) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
  }

  return normalizedPath.includes(normalizedPattern);
}

function shouldSkipSystemHighlight(annotation) {
  const text = normalizeText(annotation.text);
  if (!text) {
    return true;
  }

  return (
    text.includes("Switch to EXCALIDRAW VIEW") ||
    text.charCodeAt(0) === 0x26a0 ||
    /^[^\p{L}\p{N}]+$/u.test(text)
  );
}

function shouldSkipFlashcardAnnotation(annotation) {
  return shouldSkipSystemHighlight(annotation);
}

function formatDueDate(timestamp) {
  if (!timestamp) {
    return "\u672a\u5b66\u4e60";
  }

  return new Date(timestamp).toLocaleDateString();
}

function normalizeFlashcardGroup(tag) {
  return tag
    .replace(/^#/, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function matchesFlashcardGroup(card, group) {
  if (!group || group === "all") {
    return true;
  }

  if (group === "__ungrouped") {
    return !card.groups?.length;
  }

  return card.groups?.includes(group);
}

function isReviewedToday(card) {
  if (!card.lastReview) {
    return false;
  }

  const today = dateOnly(new Date()).getTime();
  return dateOnly(new Date(card.lastReview)).getTime() === today;
}

function getPathFlashcardGroups(path) {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  const groups = [];

  if (normalizedPath.startsWith("sources/\u5355\u8bcd/")) {
    groups.push("word");
  }

  return groups;
}

function getMarkdownAnnotationRegex() {
  return /==(?!=)([^\n=](?:[\s\S]*?[^\n=])?)==(?!=)/g;
}

function getFollowingAnnotationCommentRegex() {
  return /^(\s*)%%hl-annotation:\s*([\s\S]*?)%%/;
}

function getAnnotationCommentRegex() {
  return /%%hl-annotation:\s*[\s\S]*?%%/g;
}

function getHtmlRegex() {
  return /<mark\s+class="hl-annotation"\s+data-annotation="([\s\S]*?)">([\s\S]*?)<\/mark>/g;
}

function getPlainHighlightRegex() {
  return /==(?!=)([^\n=](?:[\s\S]*?[^\n=])?)==(?!=)/g;
}

function getIgnoredRanges(content, includeHtmlTags = false) {
  const ranges = [];
  const addRange = (start, end) => {
    ranges.push({ start, end });
  };

  const fencedCodeRegex = /(^|\n)([ \t]*```[\s\S]*?)(\n[ \t]*```|$)/g;
  let match;
  while ((match = fencedCodeRegex.exec(content)) !== null) {
    addRange(match.index, match.index + match[0].length);
  }

  const inlineCodeRegex = /`[^`\n]*`/g;
  while ((match = inlineCodeRegex.exec(content)) !== null) {
    addRange(match.index, match.index + match[0].length);
  }

  if (includeHtmlTags) {
    const htmlTagRegex = /<[^>\n]+>/g;
    while ((match = htmlTagRegex.exec(content)) !== null) {
      addRange(match.index, match.index + match[0].length);
    }
  }

  return ranges;
}

function isInsideRanges(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function isValidPlainHighlight(content, start, end, text) {
  const previousChar = content[start - 1] ?? "";
  const firstTextChar = content[start + 2] ?? "";
  const nextChar = content[end] ?? "";

  if (previousChar === "=" || nextChar === "=") {
    return false;
  }

  if (firstTextChar === "&" && /[A-Za-z0-9+/=_-]/.test(previousChar)) {
    return false;
  }

  return Boolean(text.trim());
}

function parseMarkdownAnnotationSelection(selection) {
  const match = selection.match(/^==([\s\S]*?)==((?:\s*%%hl-annotation:\s*[\s\S]*?%%)+)$/);
  if (!match) {
    return null;
  }

  const comments = collectAnnotationComments(match[2], 0);
  return {
    kind: "markdown",
    text: match[1],
    note: comments.note,
    commentsEnd: match[0].length
  };
}

function parseHtmlAnnotationSelection(selection) {
  const match = selection.match(
    /^<mark\s+class="hl-annotation"\s+data-annotation="([\s\S]*?)">([\s\S]*?)<\/mark>$/
  );
  if (!match) {
    return null;
  }

  return {
    kind: "html",
    text: unescapeHtml(match[2]),
    note: unescapeHtml(match[1]).trim()
  };
}

function parsePlainHighlightSelection(selection) {
  const match = selection.match(/^==([\s\S]*?)==$/);
  if (!match) {
    return null;
  }

  return {
    kind: "highlight",
    text: match[1],
    note: ""
  };
}

function parseAnnotations(content) {
  const annotations = [];
  const codeRanges = getIgnoredRanges(content);
  const plainHighlightIgnoredRanges = getIgnoredRanges(content, true);
  const markdownRegex = getMarkdownAnnotationRegex();
  const htmlRegex = getHtmlRegex();
  const plainHighlightRegex = getPlainHighlightRegex();
  let match;

  while ((match = markdownRegex.exec(content)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (
      isInsideRanges(start, end, codeRanges) ||
      !isValidPlainHighlight(content, start, end, match[1])
    ) {
      markdownRegex.lastIndex = start + 2;
      continue;
    }

    const comments = collectAnnotationComments(content, end);
    if (!comments.note) {
      continue;
    }

    annotations.push({
      kind: "markdown",
      start,
      end: comments.end,
      text: match[1],
      note: comments.note,
      raw: content.slice(start, comments.end),
      line: getLineNumber(content, start)
    });

    markdownRegex.lastIndex = comments.end;
  }

  while ((match = htmlRegex.exec(content)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (isInsideRanges(start, end, codeRanges)) {
      continue;
    }

    annotations.push({
      kind: "html",
      start,
      end,
      text: unescapeHtml(match[2]),
      note: unescapeHtml(match[1]).trim(),
      raw: match[0],
      line: getLineNumber(content, start)
    });
  }

  while ((match = plainHighlightRegex.exec(content)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (
      isInsideRanges(start, end, plainHighlightIgnoredRanges) ||
      !isValidPlainHighlight(content, start, end, match[1])
    ) {
      plainHighlightRegex.lastIndex = start + 2;
      continue;
    }

    const overlapsExisting = annotations.some(
      (annotation) => start < annotation.end && end > annotation.start
    );

    if (overlapsExisting) {
      continue;
    }

    annotations.push({
      kind: "highlight",
      start,
      end,
      text: match[1],
      note: "",
      raw: match[0],
      line: getLineNumber(content, match.index)
    });
  }

  return annotations.sort((left, right) => left.start - right.start);
}

function migrateInlineAnnotationContent(content) {
  const annotations = [];
  const migratedContent = content.replace(
    /==(?!=)([^\n=](?:[^\n=]*?[^\n=])?)==(?!=)((?:\s*%%hl-annotation:\s*[\s\S]*?%%)+)/g,
    (match, text) => {
      const comments = collectAnnotationComments(match.slice(match.indexOf("==", 2) + 2), 0);
      const cleanText = text;
      const replacement = `==${cleanText}==`;
      const start = content.indexOf(match);
      annotations.push({
        kind: "markdown",
        start: -1,
        end: -1,
        text: cleanText,
        note: comments.note,
        raw: match,
        line: getLineNumber(content, start)
      });
      return replacement;
    }
  );

  let searchFrom = 0;
  annotations.forEach((annotation) => {
    const raw = `==${annotation.text}==`;
    const start = migratedContent.indexOf(raw, searchFrom);
    annotation.start = start;
    annotation.end = start >= 0 ? start + raw.length : -1;
    searchFrom = annotation.end;
  });

  return {
    content: migratedContent,
    annotations: annotations.filter((annotation) => annotation.start >= 0 && annotation.note)
  };
}

function collectAnnotationComments(content, offset) {
  let cursor = offset;
  const notes = [];
  const regex = getFollowingAnnotationCommentRegex();

  while (cursor < content.length) {
    const slice = content.slice(cursor);
    const match = slice.match(regex);
    if (!match) {
      break;
    }

    notes.push(match[2].trim());
    cursor += match[0].length;
  }

  return {
    end: cursor,
    note: Array.from(new Set(notes.filter(Boolean))).join("\n")
  };
}

function buildHiddenCommentDecorations(view) {
  const ranges = [];
  const content = view.state.doc.toString();
  const regex = getAnnotationCommentRegex();
  let match;

  while ((match = regex.exec(content)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;

    ranges.push(
      Decoration.replace({
        inclusive: false,
        class: HIDDEN_COMMENT_CLASS
      }).range(start, end)
    );
  }

  parseAnnotations(content)
    .filter((annotation) => annotation.note)
    .forEach((annotation) => {
      const textEnd = annotation.start + annotation.raw.indexOf(annotation.text) + annotation.text.length;
      const start = textEnd;
      const end = annotation.end;
      if (end <= start) {
        return;
      }

      ranges.push(
        Decoration.replace({
          inclusive: false,
          class: HIDDEN_COMMENT_CLASS
        }).range(start, end)
      );
    });

  const mergedRanges = ranges
    .map((range) => ({ from: range.from, to: range.to, range }))
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .filter((item, index, all) => {
      if (!index) {
        return true;
      }

      return item.from >= all[index - 1].to;
    })
    .map((item) => item.range);

  return Decoration.set(mergedRanges, true);
}

function hideRenderedAnnotationComments(element) {
  element.querySelectorAll(".cm-line").forEach((lineEl) => {
    const commentEls = Array.from(lineEl.querySelectorAll(".cm-comment"));
    if (!commentEls.some((commentEl) => commentEl.textContent?.includes("hl-annotation:"))) {
      return;
    }

    commentEls.forEach((commentEl) => {
      commentEl.addClass(HIDDEN_COMMENT_CLASS);
    });
  });

  element.querySelectorAll(".cm-comment").forEach((commentEl) => {
    if (commentEl.textContent?.includes("hl-annotation:")) {
      commentEl.addClass(HIDDEN_COMMENT_CLASS);
    }
  });
}

function hideAnnotationCommentsInDocument() {
  hideRenderedAnnotationComments(document);
  decorateVisibleAnnotationHighlights(document);
}

function decorateVisibleAnnotationHighlights(root) {
  root.querySelectorAll(".cm-line").forEach((lineEl) => {
    const lineText = lineEl.textContent ?? "";
    if (!lineText.includes("hl-annotation:")) {
      return;
    }

    const noteMatch = lineText.match(/hl-annotation:\s*(.*?)%%/);
    const note = noteMatch?.[1]?.trim();
    if (!note) {
      return;
    }

    lineEl.querySelectorAll(".cm-highlight").forEach((highlightEl) => {
      highlightEl.addClass(MARK_CLASS);
    });
  });
}

function findHighlightHoverElement(target) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const highlightEl = target.closest("mark, .cm-highlight, .hl-annotation");
  if (!(highlightEl instanceof HTMLElement)) {
    return null;
  }

  if (
    highlightEl.closest(
      ".hl-annotation-view, .hl-flashcard-modal, .hl-annotation-hover-tooltip, .suggestion-container, .modal"
    )
  ) {
    return null;
  }

  if (!normalizeHighlightText(highlightEl.textContent)) {
    return null;
  }

  return highlightEl;
}

function buildEditorDecorations(view) {
  return Decoration.set(buildHiddenCommentDecorations(view), true);
}

const hiddenAnnotationCommentExtension = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildEditorDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildEditorDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations
  }
);

function registerAnnotationCommentObserver(plugin) {
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches?.(".cm-line, .cm-comment") ||
              node.querySelector?.(".cm-line, .cm-comment"))
        )
      )
    ) {
      hideAnnotationCommentsInDocument();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  plugin.register(() => observer.disconnect());
}

class AnnotationModal extends Modal {
  constructor(app, selectedText, initialNote, onSubmit, aiOptions = null) {
    super(app);
    this.selectedText = selectedText;
    this.initialNote = initialNote;
    this.onSubmit = onSubmit;
    this.aiOptions = aiOptions;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hl-annotation-modal");

    contentEl.createEl("h3", { text: "\u6dfb\u52a0\u6216\u7f16\u8f91\u6279\u6ce8" });
    contentEl.createEl("p", {
      text: `\u9ad8\u4eae\u5185\u5bb9\uff1a${this.selectedText}`
    });

    const textarea = contentEl.createEl("textarea", {
      cls: "hl-annotation-input"
    });
    textarea.rows = 6;
    textarea.placeholder = "\u8f93\u5165\u8fd9\u6bb5\u9ad8\u4eae\u6587\u5b57\u7684\u6279\u6ce8";
    textarea.value = this.initialNote ?? "";

    const helper = contentEl.createDiv({ cls: "hl-annotation-helper" });
    helper.setText("\u6279\u6ce8\u4f1a\u4fdd\u5b58\u5230 .highlight-annotation/highlights/*.json\uff0cMarkdown \u6b63\u6587\u53ea\u4fdd\u7559 ==\u9ad8\u4eae==");

    const buttonRow = contentEl.createDiv({ cls: "hl-annotation-actions" });
    const aiButton = buttonRow.createEl("button", {
      text: "\u7528 AI \u751f\u6210"
    });
    aiButton.addClass("hl-annotation-ai-button");
    aiButton.disabled = !this.aiOptions?.enabled;
    if (!this.aiOptions?.enabled) {
      aiButton.title = "\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u542f\u7528\u5e76\u914d\u7f6e AI \u6279\u6ce8";
    }

    const submitButton = buttonRow.createEl("button", {
      text: "\u4fdd\u5b58"
    });
    submitButton.addClass("mod-cta");

    const cancelButton = buttonRow.createEl("button", {
      text: "\u53d6\u6d88"
    });

    aiButton.addEventListener("click", async () => {
      if (!this.aiOptions?.enabled || typeof this.aiOptions.generate !== "function") {
        new Notice("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u914d\u7f6e AI \u6279\u6ce8");
        return;
      }

      const previousText = aiButton.textContent;
      aiButton.disabled = true;
      submitButton.disabled = true;
      aiButton.setText("\u751f\u6210\u4e2d...");

      try {
        const note = await this.aiOptions.generate(this.selectedText, textarea.value.trim());
        textarea.value = note;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      } catch (error) {
        console.error("Highlight Annotation AI error", error);
        new Notice(error?.message || "AI \u6279\u6ce8\u751f\u6210\u5931\u8d25");
      } finally {
        aiButton.disabled = false;
        submitButton.disabled = false;
        aiButton.setText(previousText || "\u7528 AI \u751f\u6210");
      }
    });

    submitButton.addEventListener("click", () => {
      const note = textarea.value.trim();
      if (!note) {
        new Notice("\u8bf7\u8f93\u5165\u6279\u6ce8\u5185\u5bb9");
        return;
      }
      this.close();
      this.onSubmit(note);
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && this.aiOptions?.enabled) {
        event.preventDefault();
        aiButton.click();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitButton.click();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitButton.click();
      }
    });

    window.setTimeout(() => {
      textarea.focus();
      textarea.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, onConfirm) {
    super(app);
    this.title = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", {
      cls: "hl-annotation-confirm-text",
      text: this.message
    });

    const buttonRow = contentEl.createDiv({ cls: "hl-annotation-actions" });
    const submitButton = buttonRow.createEl("button", {
      text: "\u5220\u9664"
    });
    submitButton.addClass("mod-warning");

    const cancelButton = buttonRow.createEl("button", {
      text: "\u53d6\u6d88"
    });

    submitButton.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class HighlightAnnotationSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const aiSettings = this.plugin.settings.ai;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Highlight Annotation" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u914d\u7f6e OpenAI \u517c\u5bb9\u63a5\u53e3\u540e\uff0c\u53ef\u5728\u6279\u6ce8\u5f39\u7a97\u4e2d\u4f7f\u7528 AI \u751f\u6210\u9ad8\u4eae\u6279\u6ce8\u3002"
    });

    new Setting(containerEl)
      .setName("\u542f\u7528 AI \u6279\u6ce8")
      .setDesc("\u5f00\u542f\u540e\uff0c\u6279\u6ce8\u5f39\u7a97\u4f1a\u663e\u793a\u201c\u7528 AI \u751f\u6210\u201d\u6309\u94ae\u3002")
      .addToggle((toggle) => {
        toggle.setValue(aiSettings.enabled).onChange(async (value) => {
          aiSettings.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API URL")
      .setDesc("\u4f7f\u7528 OpenAI chat completions \u517c\u5bb9\u5730\u5740\uff0c\u4f8b\u5982 https://api.openai.com/v1/chat/completions\u3002")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_AI_SETTINGS.apiUrl)
          .setValue(aiSettings.apiUrl)
          .onChange(async (value) => {
            aiSettings.apiUrl = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass("hl-annotation-setting-wide-input");
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("\u4fdd\u5b58\u5728 Obsidian \u5bc6\u94a5\u5b58\u50a8\u4e2d\uff0c\u4e0d\u5199\u5165\u63d2\u4ef6 data.json\u3002")
      .addExtraButton((button) => {
        button
          .setIcon("refresh-cw")
          .setTooltip("\u68c0\u67e5 API Key")
          .onClick(async () => {
            const apiKey = await this.plugin.getAiApiKey();
            new Notice(apiKey ? "API Key \u5df2\u914d\u7f6e" : "\u8bf7\u9009\u62e9\u6216\u65b0\u5efa API Key");
          });
      })
      .addComponent((containerEl) => {
        const secretComponent = new SecretComponent(this.plugin.app, containerEl);
        secretComponent
          .setValue(aiSettings.apiKeySecretId ?? "")
          .onChange(async (value) => {
            aiSettings.apiKeySecretId = value;
            await this.plugin.saveSettings();
          });
        return secretComponent;
      });

    new Setting(containerEl)
      .setName("\u6a21\u578b")
      .setDesc("\u586b\u5199\u4f60\u7684\u670d\u52a1\u5546\u652f\u6301\u7684 chat model \u540d\u79f0\u3002")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_AI_SETTINGS.model)
          .setValue(aiSettings.model)
          .onChange(async (value) => {
            aiSettings.model = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("\u6e29\u5ea6")
      .setDesc("\u5efa\u8bae 0-0.4\uff0c\u8f83\u4f4e\u7684\u503c\u66f4\u7a33\u5b9a\u3002")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_AI_SETTINGS.temperature))
          .setValue(String(aiSettings.temperature))
          .onChange(async (value) => {
            const parsed = Number(value);
            aiSettings.temperature = Number.isFinite(parsed) ? clamp(parsed, 0, 2) : DEFAULT_AI_SETTINGS.temperature;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("\u63d0\u793a\u8bcd\u6a21\u677f")
      .setDesc("\u7528 {{text}} \u8868\u793a\u9ad8\u4eae\u6587\u5b57\uff0c{{currentNote}} \u8868\u793a\u5f53\u524d\u6279\u6ce8\u5185\u5bb9\u3002")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_AI_SETTINGS.prompt)
          .setValue(aiSettings.prompt)
          .onChange(async (value) => {
            aiSettings.prompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 7;
        text.inputEl.addClass("hl-annotation-setting-prompt");
      });

    new Setting(containerEl)
      .setName("\u6d4b\u8bd5 AI \u914d\u7f6e")
      .setDesc("\u4f7f\u7528\u4e00\u6bb5\u793a\u4f8b\u9ad8\u4eae\u68c0\u67e5\u8bf7\u6c42\u662f\u5426\u80fd\u6b63\u5e38\u8fd4\u56de\u3002")
      .addButton((button) => {
        button.setButtonText("\u6d4b\u8bd5").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("\u6d4b\u8bd5\u4e2d...");
          try {
            const note = await this.plugin.generateAiAnnotation("\u4fe1\u606f\u8fc7\u5883\u4e0d\u7559\u75d5", "");
            new Notice(`AI \u8fd4\u56de\uff1a${note.slice(0, 80)}`);
          } catch (error) {
            console.error("Highlight Annotation AI settings test error", error);
            new Notice(error?.message || "AI \u914d\u7f6e\u6d4b\u8bd5\u5931\u8d25");
          } finally {
            button.setDisabled(false);
            button.setButtonText("\u6d4b\u8bd5");
          }
        });
      });

    new Setting(containerEl)
      .setName("\u5220\u9664\u9ad8\u4eae\u65f6\u6253\u5f00\u6e90\u6587\u4ef6")
      .setDesc("\u5f00\u542f\u65f6\uff0c\u70b9\u51fb\u201c\u5220\u9664\u9ad8\u4eae\u201d\u4f1a\u5148\u6253\u5f00\u5bf9\u5e94\u7b14\u8bb0\u4ee5\u4fbf\u786e\u8ba4\u4e0a\u4e0b\u6587\uff1b\u5173\u95ed\u540e\u4f1a\u5728\u540e\u53f0\u76f4\u63a5\u4fee\u6539\u5bf9\u5e94\u6587\u4ef6\u3002")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openSourceOnDeleteHighlight)
          .onChange(async (value) => {
            this.plugin.settings.openSourceOnDeleteHighlight = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("\u4fdd\u5b58 AI \u5355\u8bcd\u7ffb\u8bd1")
      .setDesc("\u5f00\u542f\u540e\uff0c\u53f3\u952e\u82f1\u6587\u5355\u8bcd\u751f\u6210\u7ffb\u8bd1\u65f6\u4f1a\u8ffd\u52a0\u5230\u6307\u5b9a\u5355\u8bcd\u672c\u3002")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.saveWordTranslations)
          .onChange(async (value) => {
            this.plugin.settings.saveWordTranslations = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("\u5355\u8bcd\u672c\u4fdd\u5b58\u8def\u5f84")
      .setDesc("\u751f\u6210\u7684\u5355\u8bcd\u6761\u76ee\u4f1a\u8ffd\u52a0\u5230\u8fd9\u4e2a Markdown \u6587\u4ef6\u3002")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_GENERAL_SETTINGS.wordBookPath)
          .setValue(this.plugin.settings.wordBookPath)
          .onChange(async (value) => {
            this.plugin.settings.wordBookPath = value.trim() || DEFAULT_GENERAL_SETTINGS.wordBookPath;
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass("hl-annotation-setting-wide-input");
      });

    new Setting(containerEl)
      .setName("\u5ffd\u7565\u6587\u4ef6\u6216\u6587\u4ef6\u5939")
      .setDesc("\u5168\u5e93\u626b\u63cf\u548c\u95ea\u5361\u540c\u6b65\u65f6\u8df3\u8fc7\u8fd9\u4e9b\u8def\u5f84\uff1b\u6bcf\u884c\u4e00\u6761\uff0c\u53ef\u5199 .excalidraw\u3001Folder/ \u6216 Folder/file.md\u3002")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_IGNORE_PATTERNS.join("\n"))
          .setValue(this.plugin.settings.ignorePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignorePatterns = normalizeIgnorePatterns(value);
            await this.plugin.saveSettings();
            this.plugin.refreshAnnotationViews();
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("hl-annotation-setting-ignore");
      });
  }
}

class AnnotationListView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderToken = 0;
    this.searchQuery = "";
    this.filterScope = "all";
    this.viewMode = "current";
    this.searchDebounce = null;
    this.shouldFocusSearch = false;
    this.searchSelectionStart = null;
    this.searchSelectionEnd = null;
    this.selectedAnnotationKey = null;
    this.focusAfterRender = null;
    this.scrollTopAfterRender = null;
    this.suppressCurrentFileRefreshUntil = 0;
  }

  getViewType() {
    return VIEW_TYPE_ANNOTATION_LIST;
  }

  getDisplayText() {
    return "\u9ad8\u4eae\u5217\u8868";
  }

  getIcon() {
    return "highlighter";
  }

  async onOpen() {
    await this.render();
  }

  async refresh() {
    this.scrollTopAfterRender = this.contentEl.scrollTop;
    await this.render();
  }

  filterAnnotations(annotations) {
    const scopedAnnotations = this.filterScope === "note"
      ? annotations.filter((annotation) => annotation.note)
      : annotations;

    if (!this.searchQuery) {
      return scopedAnnotations;
    }

    const query = this.searchQuery.toLowerCase();
    return scopedAnnotations.filter((annotation) => {
      const text = annotation.text.toLowerCase();
      const note = annotation.note.toLowerCase();

      if (this.filterScope === "text") {
        return text.includes(query);
      }

      if (this.filterScope === "note") {
        return note.includes(query);
      }

      return text.includes(query) || note.includes(query);
    });
  }

  getAnnotationKey(file, annotation) {
    return [
      file.path,
      annotation.start,
      annotation.line,
      normalizeText(annotation.text)
    ].join("::");
  }

  selectAnnotation(file, annotation, focusAfterRender = null) {
    this.selectedAnnotationKey = this.getAnnotationKey(file, annotation);
    this.focusAfterRender = focusAfterRender;
    this.scrollTopAfterRender = this.contentEl.scrollTop;
  }

  async selectAndRevealAnnotation(file, annotation) {
    this.viewMode = file?.path === this.plugin.getCurrentFile()?.path ? "current" : "all";
    this.searchQuery = "";
    this.filterScope = "all";
    this.selectedAnnotationKey = this.getAnnotationKey(file, annotation);
    this.focusAfterRender = null;
    this.scrollTopAfterRender = null;
    await this.render();
  }

  restoreListPosition(listEl) {
    const selectedEl = this.selectedAnnotationKey
      ? listEl.querySelector(`[data-annotation-key="${CSS.escape(this.selectedAnnotationKey)}"]`)
      : null;

    window.setTimeout(() => {
      if (this.scrollTopAfterRender !== null) {
        this.contentEl.scrollTop = this.scrollTopAfterRender;
        this.scrollTopAfterRender = null;
      }

      if (!selectedEl) {
        this.focusAfterRender = null;
        return;
      }

      selectedEl.scrollIntoView({ block: "nearest" });
      const focusTarget = this.focusAfterRender
        ? selectedEl.querySelector(`[data-action="${this.focusAfterRender}"]`)
        : selectedEl;
      focusTarget?.focus();
      this.focusAfterRender = null;
    }, 0);
  }

  renderAnnotationCard(listEl, file, annotation, options = {}) {
    const shouldHighlightText = this.searchQuery && this.filterScope !== "note";
    const shouldHighlightNote = this.searchQuery && this.filterScope !== "text";
    const shouldHighlightPath = this.searchQuery && this.filterScope === "all";
    const itemEl = listEl.createDiv({ cls: "hl-annotation-item highlight-card" });
    itemEl.tabIndex = 0;
    const annotationKey = this.getAnnotationKey(file, annotation);
    itemEl.dataset.annotationKey = annotationKey;
    if (annotationKey === this.selectedAnnotationKey) {
      itemEl.addClass("is-selected");
      itemEl.addClass("selected");
    }

    const titleBarEl = itemEl.createDiv({ cls: "hl-annotation-card-title highlight-card-title-bar" });
    const titleLeftEl = titleBarEl.createDiv({ cls: "highlight-card-title-left" });
    const pathEl = titleLeftEl.createSpan({
      cls: "hl-annotation-file-path highlight-card-title-text",
    });
    renderHighlightedText(
      pathEl,
      options.showPath ? file.path : file.basename,
      shouldHighlightPath ? this.searchQuery : ""
    );
    titleLeftEl.createSpan({
      cls: "hl-annotation-item-line highlight-line-number-badge",
      text: `L${annotation.line}`
    });

    const titleActionsEl = titleBarEl.createDiv({ cls: "hl-annotation-item-actions highlight-card-title-right" });
    const addButton = titleActionsEl.createEl("button", {
      cls: "hl-annotation-title-btn highlight-title-btn",
      attr: {
        "data-action": "edit",
        "aria-label": "\u6dfb\u52a0\u6279\u6ce8"
      },
      text: "\u6dfb\u52a0"
    });

    const deleteHighlightButton = titleActionsEl.createEl("button", {
      cls: "hl-annotation-title-btn hl-annotation-title-btn-danger highlight-title-btn",
      attr: {
        "data-action": "delete-highlight",
        "aria-label": "\u5220\u9664\u9ad8\u4eae\u548c\u6279\u6ce8"
      },
      text: "\u5220\u9664\u9ad8\u4eae"
    });

    let clearButton = null;
    if (annotation.comments?.length) {
      clearButton = titleActionsEl.createEl("button", {
        cls: "hl-annotation-title-btn hl-annotation-title-btn-danger highlight-title-btn",
        attr: {
          "data-action": "delete",
          "aria-label": "\u6e05\u7a7a\u5168\u90e8\u6279\u6ce8"
        },
        text: "\u6e05\u7a7a\u6279\u6ce8"
      });
    }

    const contentEl = itemEl.createDiv({ cls: "hl-annotation-card-content highlight-content" });
    const textContainerEl = contentEl.createDiv({ cls: "highlight-text-container" });
    textContainerEl.createDiv({ cls: "highlight-text-decorator" });
    const textEl = textContainerEl.createDiv({ cls: "hl-annotation-item-text highlight-text" });
    renderHighlightedText(textEl, annotation.text, shouldHighlightText ? this.searchQuery : "");

    const notesSectionEl = itemEl.createDiv({ cls: "hl-annotation-notes-section hi-notes-section" });
    const notesListEl = notesSectionEl.createDiv({ cls: "hi-notes-list" });
    const comments = normalizeExternalComments(annotation.comments);
    if (!comments.length) {
      const noteEl = notesListEl.createDiv({ cls: "hl-annotation-note hi-note" });
      const noteContentEl = noteEl.createDiv({ cls: "hl-annotation-item-note hi-note-content" });
      noteContentEl.setText("\u672a\u6dfb\u52a0\u6279\u6ce8");
      noteContentEl.addClass("is-empty");
    } else {
      comments.forEach((comment, index) => {
        const noteEl = notesListEl.createDiv({ cls: "hl-annotation-note hi-note" });
        const noteMetaEl = noteEl.createDiv({ cls: "hl-annotation-note-meta" });
        noteMetaEl.createSpan({
          cls: "hl-annotation-note-index",
          text: `#${index + 1}`
        });
        const noteActionsEl = noteMetaEl.createDiv({ cls: "hl-annotation-note-actions" });
        const editCommentButton = noteActionsEl.createEl("button", {
          cls: "hl-annotation-note-action",
          text: "\u7f16\u8f91"
        });
        const deleteCommentButton = noteActionsEl.createEl("button", {
          cls: "hl-annotation-note-action is-danger",
          text: "\u5220\u6b64\u6761"
        });
        const noteContentEl = noteEl.createDiv({ cls: "hl-annotation-item-note hi-note-content" });
        renderHighlightedText(noteContentEl, comment.content, shouldHighlightNote ? this.searchQuery : "");
        const editComment = async (event) => {
          event.stopPropagation();
          selectCurrent("edit");
          await this.plugin.editAnnotationCommentInFile(file, annotation, comment);
        };

        editCommentButton.addEventListener("click", editComment);
        deleteCommentButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          selectCurrent("delete");
          await this.plugin.deleteAnnotationCommentInFile(file, annotation, comment);
        });
      });
    }

    const selectCurrent = (focusAfterRender = null) => {
      this.selectAnnotation(file, annotation, focusAfterRender);
      listEl.querySelectorAll(".hl-annotation-item.is-selected").forEach((selectedEl) => {
        selectedEl.removeClass("is-selected");
        selectedEl.removeClass("selected");
      });
      itemEl.addClass("is-selected");
      itemEl.addClass("selected");
    };

    addButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      selectCurrent("edit");
      await this.plugin.addAnnotationCommentInFile(file, annotation);
    });

    deleteHighlightButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      selectCurrent("delete-highlight");
      await this.plugin.deleteHighlightInFile(file, annotation);
    });

    if (clearButton) {
      clearButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        selectCurrent("delete");
        await this.plugin.deleteAnnotationInFile(file, annotation);
      });
    }

    itemEl.addEventListener("click", async () => {
      selectCurrent();
      await this.plugin.revealAnnotation(file, annotation);
    });

    itemEl.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCurrent();
        await this.plugin.revealAnnotation(file, annotation);
      }
    });
  }

  renderWithSearchFocus() {
    if (this.searchDebounce) {
      window.clearTimeout(this.searchDebounce);
    }

    this.shouldFocusSearch = true;
    this.searchDebounce = window.setTimeout(() => {
      this.searchDebounce = null;
      this.render();
    }, 120);
  }

  restoreSearchFocus(searchEl) {
    if (!this.shouldFocusSearch) {
      return;
    }

    this.shouldFocusSearch = false;
    window.setTimeout(() => {
      searchEl.focus();
      const start = this.searchSelectionStart ?? searchEl.value.length;
      const end = this.searchSelectionEnd ?? start;
      searchEl.setSelectionRange(start, end);
    }, 0);
  }

  buildToolbar(contentEl) {
    const toolbarEl = contentEl.createDiv({ cls: "hl-annotation-toolbar" });
    const searchEl = toolbarEl.createEl("input", {
      cls: "hl-annotation-search",
      type: "search",
      placeholder: "\u641c\u7d22\u9ad8\u4eae\u6216\u6279\u6ce8"
    });
    searchEl.value = this.searchQuery;
    searchEl.addEventListener("input", (event) => {
      const target = event.target;
      this.searchQuery = target.value.trim();
      this.searchSelectionStart = target.selectionStart;
      this.searchSelectionEnd = target.selectionEnd;
      this.renderWithSearchFocus();
    });

    const selectEl = toolbarEl.createEl("select", {
      cls: "hl-annotation-filter"
    });
    [
      { value: "all", label: "\u5168\u90e8" },
      { value: "text", label: "\u53ea\u641c\u9ad8\u4eae" },
      { value: "note", label: "\u53ea\u641c\u6279\u6ce8" }
    ].forEach((option) => {
      const optionEl = selectEl.createEl("option", {
        value: option.value,
        text: option.label
      });
      optionEl.selected = option.value === this.filterScope;
    });

    selectEl.addEventListener("change", (event) => {
      this.filterScope = event.target.value;
      this.render();
    });

    this.restoreSearchFocus(searchEl);
  }

  async getAnnotationsForFile(file) {
    const content = await this.plugin.getFileContent(file);
    const annotations = (await this.plugin.getMergedAnnotations(file, content)).filter(
      (annotation) => !shouldSkipSystemHighlight(annotation)
    );
    return { content, annotations };
  }

  async render() {
    const currentToken = ++this.renderToken;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hl-annotation-view");

    const file = this.plugin.getCurrentFile();
    const headerEl = contentEl.createDiv({ cls: "hl-annotation-view-header" });
    headerEl.createEl("h3", { text: "\u9ad8\u4eae\u5217\u8868" });

    const actionsEl = headerEl.createDiv({ cls: "hl-annotation-view-header-actions" });
    const allAnnotationsButton = actionsEl.createEl("button", {
      cls: "hl-annotation-header-button",
      attr: {
        "aria-label": "\u5217\u51fa\u5168\u5e93\u9ad8\u4eae\u6807\u6ce8"
      }
    });
    allAnnotationsButton.setText(this.viewMode === "all" ? "\u5f53\u524d" : "\u5168\u90e8");
    allAnnotationsButton.addEventListener("click", () => {
      this.viewMode = this.viewMode === "all" ? "current" : "all";
      this.render();
    });

    const refreshButton = actionsEl.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "\u5237\u65b0\u6279\u6ce8\u5217\u8868"
      }
    });
    refreshButton.setText("\u5237\u65b0");
    refreshButton.addEventListener("click", () => {
      this.render();
    });

    this.buildToolbar(contentEl);

    if (this.viewMode === "all") {
      await this.renderAllAnnotations(contentEl, currentToken);
      return;
    }

    if (!file) {
      this.renderEmptyState(
        contentEl,
        "\u8bf7\u5148\u6253\u5f00\u4e00\u7bc7 Markdown \u7b14\u8bb0\uff0c\u53f3\u4fa7\u680f\u4f1a\u663e\u793a\u5f53\u524d\u7b14\u8bb0\u7684\u6279\u6ce8\u3002"
      );
      return;
    }

    const fileTitle = contentEl.createDiv({ cls: "hl-annotation-view-file" });
    fileTitle.setText(file.basename);

    const { annotations } = await this.getAnnotationsForFile(file);
    if (currentToken !== this.renderToken) {
      return;
    }

    const filteredAnnotations = this.filterAnnotations(annotations);
    const annotatedCount = annotations.filter((annotation) => annotation.note).length;
    const commentCount = annotations.reduce(
      (total, annotation) => total + normalizeExternalComments(annotation.comments).length,
      0
    );

    const summaryEl = contentEl.createDiv({ cls: "hl-annotation-summary" });
    summaryEl.setText(
      `\u5171 ${annotations.length} \u6761\u9ad8\u4eae\uff0c${annotatedCount} \u6761\u5e26\u6279\u6ce8\uff0c\u6279\u6ce8 ${commentCount} \u6761\uff0c\u5f53\u524d\u663e\u793a ${filteredAnnotations.length} \u6761`
    );

    if (!annotations.length) {
      this.renderEmptyState(
        contentEl,
        "\u5f53\u524d\u7b14\u8bb0\u8fd8\u6ca1\u6709\u9ad8\u4eae\u5185\u5bb9\u3002"
      );
      return;
    }

    if (!filteredAnnotations.length) {
      this.renderEmptyState(
        contentEl,
        "\u6ca1\u6709\u627e\u5230\u7b26\u5408\u641c\u7d22\u6761\u4ef6\u7684\u6279\u6ce8\u3002"
      );
      return;
    }

    const listEl = contentEl.createDiv({ cls: "hl-annotation-list" });
    filteredAnnotations.forEach((annotation) => {
      this.renderAnnotationCard(listEl, file, annotation);
    });

    this.restoreListPosition(listEl);
  }

  filterAnnotationEntries(entries) {
    const scopedEntries = this.filterScope === "note"
      ? entries.filter(({ annotation }) => annotation.note)
      : entries;

    if (!this.searchQuery) {
      return scopedEntries;
    }

    const query = this.searchQuery.toLowerCase();
    return scopedEntries.filter(({ file, annotation }) => {
      const text = annotation.text.toLowerCase();
      const note = annotation.note.toLowerCase();

      if (this.filterScope === "text") {
        return text.includes(query);
      }

      if (this.filterScope === "note") {
        return note.includes(query);
      }

      return text.includes(query) || note.includes(query) || file.path.toLowerCase().includes(query);
    });
  }

  async renderAllAnnotations(contentEl, currentToken) {
    const summaryEl = contentEl.createDiv({ cls: "hl-annotation-summary" });
    summaryEl.setText("\u6b63\u5728\u626b\u63cf\u7b14\u8bb0\u5e93\u4e2d\u7684\u9ad8\u4eae\u6807\u6ce8...");

    let entries = [];
    try {
      entries = await this.getAllAnnotationEntries((done, total) => {
        if (currentToken === this.renderToken && (done % 50 === 0 || done === total)) {
          summaryEl.setText(`\u6b63\u5728\u626b\u63cf\u7b14\u8bb0\u5e93\u4e2d\u7684\u9ad8\u4eae\u6807\u6ce8... ${done}/${total}`);
        }
      });
    } catch (error) {
      console.error("Highlight Annotation scan all failed", error);
      summaryEl.setText("\u626b\u63cf\u5168\u5e93\u9ad8\u4eae\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u63a7\u5236\u53f0\u9519\u8bef\u3002");
      return;
    }
    if (currentToken !== this.renderToken) {
      return;
    }

    const filteredEntries = this.filterAnnotationEntries(entries);
    const annotatedCount = entries.filter(({ annotation }) => annotation.note).length;
    const commentCount = entries.reduce(
      (total, { annotation }) => total + normalizeExternalComments(annotation.comments).length,
      0
    );
    summaryEl.setText(
      `\u5168\u5e93\u5171 ${entries.length} \u6761\u9ad8\u4eae\uff0c${annotatedCount} \u6761\u5e26\u6279\u6ce8\uff0c\u6279\u6ce8 ${commentCount} \u6761\uff0c\u5f53\u524d\u663e\u793a ${filteredEntries.length} \u6761`
    );

    if (!entries.length) {
      this.renderEmptyState(contentEl, "\u5f53\u524d\u7b14\u8bb0\u5e93\u8fd8\u6ca1\u6709\u9ad8\u4eae\u6807\u6ce8\u3002");
      return;
    }

    if (!filteredEntries.length) {
      this.renderEmptyState(contentEl, "\u6ca1\u6709\u627e\u5230\u7b26\u5408\u641c\u7d22\u6761\u4ef6\u7684\u6807\u6ce8\u3002");
      return;
    }

    const listEl = contentEl.createDiv({ cls: "hl-annotation-list" });
    filteredEntries.forEach(({ file, annotation }) => {
      this.renderAnnotationCard(listEl, file, annotation, { showPath: true });
    });

    this.restoreListPosition(listEl);
  }

  async getAllAnnotationEntries(onProgress = null) {
    const results = [];
    const files = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.plugin.shouldIgnoreFile(file));
    const total = files.length;
    let done = 0;

    for (const file of files) {
      try {
        const content = await this.plugin.getFileContent(file);
        const annotations = (await this.plugin.getMergedAnnotations(file, content)).filter(
          (annotation) => !shouldSkipSystemHighlight(annotation)
        );
        if (!annotations.length) {
          done += 1;
          onProgress?.(done, total);
          continue;
        }

        annotations.forEach((annotation) => {
          results.push({
            file,
            annotation
          });
        });
      } catch (error) {
        console.warn(`Highlight Annotation skipped ${file.path}`, error);
      } finally {
        done += 1;
        onProgress?.(done, total);
      }
    }

    return results.sort((left, right) => {
      const pathCompare = left.file.path.localeCompare(right.file.path);
      if (pathCompare) {
        return pathCompare;
      }

      return left.annotation.line - right.annotation.line;
    });
  }

  renderEmptyState(contentEl, message) {
    const emptyEl = contentEl.createDiv({ cls: "hl-annotation-empty" });
    emptyEl.setText(message);
  }
}

class FlashcardReviewModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.cards = [];
    this.currentIndex = 0;
    this.showAnswer = false;
    this.selectedGroup = "all";
    this.showingAllCards = false;
  }

  async onOpen() {
    this.contentEl.addClass("hl-flashcard-modal");
    await this.reloadCards();
  }

  async reloadCards() {
    this.cards = await this.plugin.getDueFlashcards(this.selectedGroup);
    this.currentIndex = 0;
    this.showAnswer = false;
    this.showingAllCards = false;
    this.render();
  }

  async showAllCards() {
    this.cards = await this.plugin.getAllFlashcards(this.selectedGroup);
    this.currentIndex = 0;
    this.showAnswer = false;
    this.showingAllCards = true;
    this.render();
  }

  goToPreviousCard() {
    if (this.currentIndex <= 0) {
      return;
    }

    this.currentIndex -= 1;
    this.showAnswer = false;
    this.render();
  }

  goToNextCard() {
    if (this.currentIndex >= this.cards.length - 1) {
      return;
    }

    this.currentIndex += 1;
    this.showAnswer = false;
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hl-flashcard-view");

    const headerEl = contentEl.createDiv({ cls: "hl-flashcard-header" });
    headerEl.createEl("h3", { text: "\u9ad8\u4eae\u95ea\u5361" });

    const actionsEl = headerEl.createDiv({ cls: "hl-flashcard-header-actions" });
    const groupSelect = actionsEl.createEl("select", {
      cls: "hl-flashcard-group-select"
    });
    this.plugin.getFlashcardGroups().forEach((group) => {
      const optionEl = groupSelect.createEl("option", {
        value: group.id,
        text: group.label
      });
      optionEl.selected = group.id === this.selectedGroup;
    });
    groupSelect.addEventListener("change", async (event) => {
      this.selectedGroup = event.target.value;
      await this.reloadCards();
    });

    const syncButton = actionsEl.createEl("button", {
      cls: "clickable-icon",
      text: "\u540c\u6b65"
    });
    syncButton.addEventListener("click", async () => {
      await this.plugin.syncFlashcards();
      await this.reloadCards();
    });

    const allButton = actionsEl.createEl("button", {
      cls: "clickable-icon",
      text: "\u5168\u90e8"
    });
    allButton.addEventListener("click", async () => {
      await this.showAllCards();
    });

    const stats = this.plugin.getFlashcardStats(this.selectedGroup);
    this.renderStats(contentEl, stats);

    if (!this.cards.length) {
      const emptyEl = contentEl.createDiv({ cls: "hl-flashcard-empty" });
      emptyEl.setText("\u5f53\u524d\u5206\u7ec4\u6ca1\u6709\u5230\u671f\u95ea\u5361\u3002\u53ef\u4ee5\u70b9\u201c\u540c\u6b65\u201d\u626b\u63cf\u5168\u5e93\u9ad8\u4eae\u3002");
      return;
    }

    const card = this.cards[this.currentIndex];
    const progressEl = contentEl.createDiv({ cls: "hl-flashcard-progress" });
    progressEl.setText(
      `${this.currentIndex + 1} / ${this.cards.length} · ${this.showingAllCards ? "\u5168\u90e8\u5361" : "\u5230\u671f\u5361"}`
    );

    const cardEl = contentEl.createDiv({ cls: "hl-flashcard-card" });
    cardEl.createDiv({
      cls: "hl-flashcard-question",
      text: card.text
    });

    const sourceEl = cardEl.createDiv({ cls: "hl-flashcard-source" });
    const groupsText = card.groups?.length ? ` #${card.groups.join(" #")}` : "";
    sourceEl.setText(`${card.filePath} · L${card.line}${groupsText}`);

    if (this.showAnswer) {
      const answerEl = cardEl.createDiv({ cls: "hl-flashcard-answer" });
      answerEl.setText(card.note || "\u8fd9\u5f20\u5361\u6ca1\u6709\u6279\u6ce8\uff0c\u53ef\u5c06\u9ad8\u4eae\u5185\u5bb9\u76f4\u63a5\u4f5c\u4e3a\u56de\u5fc6\u5bf9\u8c61\u3002");
    }

    const navEl = contentEl.createDiv({ cls: "hl-flashcard-nav" });
    const previousButton = navEl.createEl("button", {
      cls: "hl-flashcard-nav-button",
      text: "\u4e0a\u4e00\u4e2a"
    });
    previousButton.disabled = this.currentIndex <= 0;
    previousButton.addEventListener("click", () => this.goToPreviousCard());

    const nextButton = navEl.createEl("button", {
      cls: "hl-flashcard-nav-button",
      text: "\u4e0b\u4e00\u4e2a"
    });
    nextButton.disabled = this.currentIndex >= this.cards.length - 1;
    nextButton.addEventListener("click", () => this.goToNextCard());

    const controlsEl = contentEl.createDiv({ cls: "hl-flashcard-controls" });
    if (!this.showAnswer) {
      const showButton = controlsEl.createEl("button", {
        cls: "mod-cta",
        text: "\u663e\u793a\u7b54\u6848"
      });
      showButton.addEventListener("click", () => {
        this.showAnswer = true;
        this.render();
      });
      return;
    }

    [
      { rating: 1, label: "Again" },
      { rating: 2, label: "Hard" },
      { rating: 3, label: "Good" },
      { rating: 4, label: "Easy" }
    ].forEach((option) => {
      const button = controlsEl.createEl("button", {
        cls: `hl-flashcard-rating is-${option.rating}`,
        text: option.label
      });
      button.addEventListener("click", async () => {
        await this.plugin.reviewFlashcard(card, option.rating);
        this.cards.splice(this.currentIndex, 1);
        if (this.currentIndex >= this.cards.length) {
          this.currentIndex = Math.max(0, this.cards.length - 1);
        }
        this.showAnswer = false;
        this.render();
      });
    });
  }

  renderStats(contentEl, stats) {
    const statsEl = contentEl.createDiv({ cls: "hl-flashcard-stats" });
    [
      { label: "\u603b\u6570", value: stats.total },
      { label: "\u5230\u671f", value: stats.due },
      { label: "\u65b0\u5361", value: stats.newCards },
      { label: "\u5df2\u5b66", value: stats.learned },
      { label: "\u4eca\u65e5", value: stats.reviewedToday },
      { label: "\u4fdd\u7559\u7387", value: `${stats.retentionRate.toFixed(1)}%` }
    ].forEach((item) => {
      const itemEl = statsEl.createDiv({ cls: "hl-flashcard-stat" });
      itemEl.createDiv({ cls: "hl-flashcard-stat-value", text: String(item.value) });
      itemEl.createDiv({ cls: "hl-flashcard-stat-label", text: item.label });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class HighlightAnnotationPlugin extends Plugin {
  async onload() {
    this.currentFile = this.app.workspace.getActiveFile() ?? null;
    this.settings = await this.loadSettings();
    this.flashcardState = this.getFlashcardStateFromData(this.settings.rawData);
    const shouldSaveMigratedSettings = this.settings.rawData?.ai?.apiKey;
    delete this.settings.rawData;
    if (shouldSaveMigratedSettings) {
      await this.saveSettings();
    }

    this.addSettingTab(new HighlightAnnotationSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_ANNOTATION_LIST,
      (leaf) => new AnnotationListView(leaf, this)
    );

    this.registerMarkdownPostProcessor((element, context) => {
      this.decorateRenderedAnnotations(element, context);
    });

    this.registerEditorExtension(hiddenAnnotationCommentExtension);
    this.registerDomEvent(document, "mouseover", hideAnnotationCommentsInDocument);
    this.registerDomEvent(document, "click", (event) => this.handleHighlightClick(event));
    this.registerDomEvent(document, "pointerover", (event) => this.handleHighlightHoverStart(event));
    this.registerDomEvent(document, "pointerout", (event) => this.handleHighlightHoverEnd(event));
    this.registerDomEvent(document, "scroll", () => this.hideFloatingTooltips(), true);
    this.registerDomEvent(document, "keydown", () => this.hideFloatingTooltips());
    this.registerInterval(window.setInterval(hideAnnotationCommentsInDocument, 200));
    registerAnnotationCommentObserver(this);

    this.addRibbonIcon(
      "highlighter",
      "\u6253\u5f00\u9ad8\u4eae\u5217\u8868",
      async () => {
        await this.activateAnnotationListView();
      }
    );

    this.addRibbonIcon(
      "brain",
      "\u6253\u5f00\u9ad8\u4eae\u95ea\u5361",
      async () => {
        await this.openFlashcardReviewModal();
      }
    );

    this.addCommand({
      id: "annotate-highlight-selection",
      name: "\u9ad8\u4eae\u9009\u4e2d\u6587\u672c\u5e76\u6dfb\u52a0\u6279\u6ce8",
      editorCallback: (editor) => {
        this.annotateSelection(editor);
      },
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.editor) {
          return false;
        }

        if (!checking) {
          this.annotateSelection(view.editor);
        }
        return true;
      }
    });

    this.addCommand({
      id: "edit-annotation-at-cursor",
      name: "\u7f16\u8f91\u5149\u6807\u6240\u5728\u5904\u6279\u6ce8",
      editorCallback: async (editor) => {
        await this.editAnnotationAtCursor(editor);
      },
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.editor) {
          return false;
        }

        if (!checking) {
          this.editAnnotationAtCursor(view.editor);
        }
        return true;
      }
    });

    this.addCommand({
      id: "ai-annotate-at-cursor",
      name: "\u7528 AI \u751f\u6210\u5149\u6807\u6240\u5728\u5904\u6279\u6ce8",
      editorCallback: (editor) => {
        this.aiAnnotateAtCursor(editor);
      },
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.editor) {
          return false;
        }

        if (!checking) {
          this.aiAnnotateAtCursor(view.editor);
        }
        return true;
      }
    });

    this.addCommand({
      id: "remove-annotation-at-cursor",
      name: "\u5220\u9664\u5149\u6807\u6240\u5728\u5904\u6279\u6ce8",
      editorCallback: (editor) => {
        this.deleteAnnotationAtCursor(editor);
      },
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.editor) {
          return false;
        }

        if (!checking) {
          this.deleteAnnotationAtCursor(view.editor);
        }
        return true;
      }
    });

    this.addCommand({
      id: "open-annotation-sidebar",
      name: "\u6253\u5f00\u53f3\u4fa7\u680f\u9ad8\u4eae\u5217\u8868",
      callback: async () => {
        await this.activateAnnotationListView();
      }
    });

    this.addCommand({
      id: "migrate-legacy-annotations-in-current-note",
      name: "\u5c06\u5f53\u524d\u7b14\u8bb0\u7684\u65e7 HTML \u6279\u6ce8\u8fc1\u79fb\u5230\u5916\u7f6e JSON",
      callback: async () => {
        await this.migrateLegacyAnnotationsInCurrentFile();
      }
    });

    this.addCommand({
      id: "migrate-inline-annotations-to-external-storage",
      name: "\u5c06\u5f53\u524d\u7b14\u8bb0\u7684\u5185\u8054\u6279\u6ce8\u8fc1\u79fb\u5230\u5916\u7f6e JSON",
      callback: async () => {
        await this.migrateInlineAnnotationsToExternalStorage();
      }
    });

    this.addCommand({
      id: "migrate-all-inline-annotations-to-external-storage",
      name: "\u5c06\u5168\u5e93\u5185\u8054\u6279\u6ce8\u8fc1\u79fb\u5230\u5916\u7f6e JSON",
      callback: async () => {
        await this.migrateAllInlineAnnotationsToExternalStorage();
      }
    });

    this.addCommand({
      id: "sync-highlight-flashcards",
      name: "\u626b\u63cf\u5168\u5e93\u9ad8\u4eae\u5e76\u540c\u6b65\u95ea\u5361",
      callback: async () => {
        await this.syncFlashcards();
      }
    });

    this.addCommand({
      id: "open-highlight-flashcards",
      name: "\u4ee5\u5f39\u7a97\u6253\u5f00\u9ad8\u4eae\u95ea\u5361\u590d\u4e60",
      callback: async () => {
        await this.openFlashcardReviewModal();
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (editor.getSelection()) {
          menu.addItem((item) => {
            item
              .setTitle("\u9ad8\u4eae\u5e76\u6dfb\u52a0\u6279\u6ce8")
              .setIcon("highlighter")
              .onClick(() => this.annotateSelection(editor));
          });

          if (isLikelyEnglishWord(editor.getSelection())) {
            menu.addItem((item) => {
              item
                .setTitle("\u7528 AI \u7ffb\u8bd1\u82f1\u6587\u5355\u8bcd")
                .setIcon("languages")
                .onClick(() => this.translateSelectedWord(editor));
            });
          }
        }

        if (editor.getSelection() || this.findAnnotationAtOffset(editor.getValue(), editor.posToOffset(editor.getCursor()))) {
          menu.addItem((item) => {
            item
              .setTitle("\u7f16\u8f91\u5f53\u524d\u6279\u6ce8")
              .setIcon("pencil")
              .onClick(() => this.editAnnotationAtCursor(editor));
          });

          menu.addItem((item) => {
            item
              .setTitle("\u7528 AI \u751f\u6210\u6279\u6ce8")
              .setIcon("sparkles")
              .onClick(() => this.aiAnnotateAtCursor(editor));
          });

          menu.addItem((item) => {
            item
              .setTitle("\u5220\u9664\u5f53\u524d\u6279\u6ce8")
              .setIcon("trash")
              .onClick(() => this.deleteAnnotationAtCursor(editor));
          });
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.updateCurrentFile(file ?? null);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file) {
          this.updateCurrentFile(view.file);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        this.handleEditorChange(editor, info);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.currentFile || file.path === this.currentFile.path) {
          this.handleCurrentFileContentPotentiallyChanged();
        }
      })
    );

    this.app.workspace.onLayoutReady(async () => {
      this.app.workspace.detachLeavesOfType(LEGACY_VIEW_TYPE_FLASHCARD_REVIEW);
      await this.activateAnnotationListView();
      this.refreshAnnotationViews();
      hideAnnotationCommentsInDocument();
    });
  }

  onunload() {
    if (this.annotationViewRefreshTimer) {
      window.clearTimeout(this.annotationViewRefreshTimer);
      this.annotationViewRefreshTimer = null;
    }
    this.hideFloatingTooltips();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ANNOTATION_LIST);
    this.app.workspace.detachLeavesOfType(LEGACY_VIEW_TYPE_FLASHCARD_REVIEW);
  }

  decorateRenderedAnnotations(element, context) {
    hideRenderedAnnotationComments(element);

    const sectionInfo = context.getSectionInfo?.(element);
    const sectionText = sectionInfo?.text ?? "";
    if (!sectionText) {
      return;
    }

    const annotations = parseAnnotations(sectionText).filter(
      (annotation) => annotation.kind === "markdown"
    );
    if (!annotations.length) {
      return;
    }

    const marks = Array.from(element.querySelectorAll("mark"));
    let markIndex = 0;

    annotations.forEach((annotation) => {
      while (markIndex < marks.length) {
        const candidate = marks[markIndex++];
        if (candidate.classList.contains(MARK_CLASS)) {
          continue;
        }

        if (normalizeText(candidate.textContent ?? "") !== normalizeText(annotation.text)) {
          continue;
        }

        candidate.classList.add(MARK_CLASS);
        break;
      }
    });
  }

  updateCurrentFile(file) {
    const previousPath = this.currentFile?.path ?? null;
    const nextPath = file?.path ?? null;
    const fileChanged = previousPath !== nextPath;

    this.currentFile = file;
    if (fileChanged) {
      this.currentFileSwitchedAt = Date.now();
    }
    if (file) {
      this.rememberCurrentHighlightSignature();
    } else {
      this.currentHighlightSignature = "";
    }

    if (!fileChanged) {
      return;
    }

    if (Date.now() < this.suppressCurrentFileRefreshUntil) {
      return;
    }

    this.refreshAnnotationViews();
    this.scheduleAnnotationViewRefresh(FILE_SWITCH_EDITOR_STALE_GUARD_MS);
  }

  getCurrentFile() {
    return this.app.workspace.getActiveFile() ?? this.currentFile ?? null;
  }

  rememberCurrentHighlightSignature() {
    const view = this.getActiveMarkdownView();
    if (view?.file?.path === this.currentFile?.path && view.editor) {
      this.currentHighlightSignature = getHighlightSignature(view.editor.getValue());
    }
  }

  handleEditorChange(editor, info) {
    const file = info?.file ?? this.getCurrentFile();
    if (!file || this.currentFile?.path !== file.path) {
      return;
    }

    const nextSignature = getHighlightSignature(editor.getValue());
    if (this.currentHighlightSignature === undefined) {
      this.currentHighlightSignature = nextSignature;
      return;
    }

    if (nextSignature === this.currentHighlightSignature) {
      return;
    }

    this.currentHighlightSignature = nextSignature;
    this.scheduleAnnotationViewRefresh();
  }

  async handleCurrentFileContentPotentiallyChanged() {
    const file = this.getCurrentFile();
    if (!file) {
      return;
    }

    const content = await this.getFileContent(file);
    const nextSignature = getHighlightSignature(content);
    if (this.currentHighlightSignature === undefined) {
      this.currentHighlightSignature = nextSignature;
      return;
    }

    if (nextSignature === this.currentHighlightSignature) {
      return;
    }

    this.currentHighlightSignature = nextSignature;
    this.scheduleAnnotationViewRefresh(800);
  }

  shouldIgnoreFile(file) {
    const patterns = normalizeIgnorePatterns(this.settings?.ignorePatterns);
    return patterns.some((pattern) => matchesIgnorePattern(file.path, pattern));
  }

  getHoverFileForElement(element) {
    const leafContent = element.closest(".workspace-leaf-content");
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const leaf = leaves.find((candidate) => candidate.view?.containerEl === leafContent);
    return leaf?.view?.file ?? this.getCurrentFile();
  }

  clearAnnotationHoverTimer() {
    if (this.annotationHoverTimer) {
      window.clearTimeout(this.annotationHoverTimer);
      this.annotationHoverTimer = null;
    }
  }

  handleHighlightHoverStart(event) {
    const highlightEl = findHighlightHoverElement(event.target);
    if (!highlightEl) {
      return;
    }

    this.clearAnnotationHoverTimer();
    this.hideAnnotationHoverTooltip();
    const token = {};
    this.annotationHoverToken = token;
    this.annotationHoverTarget = highlightEl;
    this.annotationHoverTimer = window.setTimeout(async () => {
      if (this.annotationHoverToken !== token || !highlightEl.isConnected) {
        return;
      }

      await this.showAnnotationHoverTooltip(highlightEl);
    }, HOVER_TOOLTIP_DELAY_MS);
  }

  handleHighlightHoverEnd(event) {
    const highlightEl = findHighlightHoverElement(event.target);
    if (!highlightEl) {
      return;
    }

    if (event.relatedTarget instanceof Node && highlightEl.contains(event.relatedTarget)) {
      return;
    }

    this.clearAnnotationHoverTimer();
    this.hideAnnotationHoverTooltip();
  }

  async handleHighlightClick(event) {
    const highlightEl = findHighlightHoverElement(event.target);
    if (!highlightEl) {
      return;
    }

    const annotation = await this.getAnnotationForElement(highlightEl);
    if (!annotation) {
      return;
    }

    const file = this.getHoverFileForElement(highlightEl);
    if (!file) {
      return;
    }

    await this.selectAnnotationInViews(file, annotation);
  }

  async getAnnotationForElement(highlightEl) {
    const file = this.getHoverFileForElement(highlightEl);
    if (!file) {
      return null;
    }

    const text = normalizeHighlightText(highlightEl.textContent ?? "");
    if (!text) {
      return null;
    }

    const content = await this.getFileContent(file);
    const annotations = await this.getMergedAnnotations(file, content);
    return (
      annotations.find(
        (annotation) => normalizeHighlightText(annotation.text) === text
      ) ?? null
    );
  }

  async getAnnotationForHoverElement(highlightEl) {
    const annotation = await this.getAnnotationForElement(highlightEl);
    return annotation?.note ? annotation : null;
  }

  async selectAnnotationInViews(file, annotation) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_LIST)[0];
    if (!leaf) {
      leaf = await this.activateAnnotationListView();
    }

    if (leaf?.view && typeof leaf.view.selectAndRevealAnnotation === "function") {
      await leaf.view.selectAndRevealAnnotation(file, annotation);
    }
  }

  async showAnnotationHoverTooltip(highlightEl) {
    const annotation = await this.getAnnotationForHoverElement(highlightEl);
    if (!annotation?.note || this.annotationHoverTarget !== highlightEl) {
      return;
    }

    this.hideAnnotationHoverTooltip();
    const tooltipEl = document.body.createDiv({ cls: "hl-annotation-hover-tooltip" });
    tooltipEl.setAttr("role", "tooltip");
    tooltipEl.createDiv({ cls: "hl-annotation-hover-title", text: annotation.text });
    const comments = normalizeExternalComments(annotation.comments);
    if (comments.length > 1) {
      comments.forEach((comment, index) => {
        const commentEl = tooltipEl.createDiv({ cls: "hl-annotation-hover-comment" });
        commentEl.createDiv({
          cls: "hl-annotation-hover-comment-index",
          text: `#${index + 1}`
        });
        commentEl.createDiv({ cls: "hl-annotation-hover-note", text: comment.content });
      });
    } else {
      tooltipEl.createDiv({ cls: "hl-annotation-hover-note", text: annotation.note });
    }
    this.annotationHoverTooltipEl = tooltipEl;
    this.positionAnnotationHoverTooltip(highlightEl, tooltipEl);
  }

  positionAnnotationHoverTooltip(targetEl, tooltipEl) {
    const targetRect = targetEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const margin = 10;
    const maxLeft = window.innerWidth - tooltipRect.width - margin;
    const left = clamp(targetRect.left, margin, Math.max(margin, maxLeft));
    const bottomTop = targetRect.bottom + margin;
    const top =
      bottomTop + tooltipRect.height <= window.innerHeight - margin
        ? bottomTop
        : Math.max(margin, targetRect.top - tooltipRect.height - margin);

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  hideAnnotationHoverTooltip() {
    this.clearAnnotationHoverTimer();
    this.annotationHoverToken = null;
    this.annotationHoverTarget = null;
    this.annotationHoverTooltipEl?.remove();
    this.annotationHoverTooltipEl = null;
  }

  hideWordTranslationTooltip() {
    this.wordTranslationTooltipEl?.remove();
    this.wordTranslationTooltipEl = null;
  }

  hideFloatingTooltips() {
    this.hideAnnotationHoverTooltip();
    this.hideWordTranslationTooltip();
  }

  getEditorSelectionRect(editor) {
    try {
      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width || rect.height) {
          return rect;
        }
      }
    } catch (_error) {
      // Fall back to CodeMirror coordinates.
    }

    const cursor = editor.getCursor("to");
    const coords = editor.coordsAtPos?.(cursor, "local") ?? editor.coordsAtPos?.(cursor);
    if (!coords) {
      return new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
    }

    return new DOMRect(coords.left, coords.top, Math.max(1, coords.right - coords.left), Math.max(1, coords.bottom - coords.top));
  }

  showWordTranslationTooltip(anchorRect, entry, savedState) {
    this.hideWordTranslationTooltip();
    const tooltipEl = document.body.createDiv({ cls: "hl-word-translation-tooltip" });
    tooltipEl.setAttr("role", "tooltip");
    tooltipEl.createDiv({ cls: "hl-word-translation-title", text: entry.word });
    tooltipEl.createDiv({ cls: "hl-word-translation-meaning", text: entry.meaning || "\u672a\u8fd4\u56de\u91ca\u4e49" });
    if (entry.example) {
      tooltipEl.createDiv({ cls: "hl-word-translation-example", text: entry.example });
    }
    if (entry.exampleTranslation) {
      tooltipEl.createDiv({ cls: "hl-word-translation-example-translation", text: entry.exampleTranslation });
    }
    tooltipEl.createDiv({
      cls: "hl-word-translation-status",
      text: savedState === "saved"
        ? "\u5df2\u4fdd\u5b58\u5230\u5355\u8bcd\u672c"
        : savedState === "exists"
          ? "\u5355\u8bcd\u672c\u5df2\u5b58\u5728"
          : "\u672a\u4fdd\u5b58"
    });

    this.wordTranslationTooltipEl = tooltipEl;
    this.positionAnnotationHoverTooltip({ getBoundingClientRect: () => anchorRect }, tooltipEl);
  }

  getActiveMarkdownView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView) ?? null;
  }

  async getFileContent(file) {
    const activeView = this.getActiveMarkdownView();
    const fileSwitchAge = Date.now() - (this.currentFileSwitchedAt ?? 0);
    if (fileSwitchAge >= 0 && fileSwitchAge < FILE_SWITCH_EDITOR_STALE_GUARD_MS) {
      return this.app.vault.cachedRead(file);
    }

    if (activeView?.file?.path === file.path && activeView.editor) {
      return activeView.editor.getValue();
    }

    return this.app.vault.cachedRead(file);
  }

  refreshAnnotationViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_LIST).forEach((leaf) => {
      if (typeof leaf.view.refresh === "function") {
        leaf.view.refresh();
      }
    });
  }

  scheduleAnnotationViewRefresh(delay = 600) {
    if (this.annotationViewRefreshTimer) {
      window.clearTimeout(this.annotationViewRefreshTimer);
    }

    this.annotationViewRefreshTimer = window.setTimeout(() => {
      this.annotationViewRefreshTimer = null;
      this.refreshAnnotationViews();
    }, delay);
  }

  async activateAnnotationListView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_LIST)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_ANNOTATION_LIST,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openFlashcardReviewModal() {
    new FlashcardReviewModal(this.app, this).open();
  }

  async loadSettings() {
    const data = await this.loadData();
    const ai = {
      ...DEFAULT_AI_SETTINGS,
      ...(data?.ai ?? {})
    };

    if (!ai.apiKeySecretId && data?.ai?.apiKey) {
      ai.apiKeySecretId = DEFAULT_AI_API_KEY_SECRET_ID;
      await this.app.secretStorage.setSecret(ai.apiKeySecretId, data.ai.apiKey);
      new Notice("Highlight Annotation: AI API Key \u5df2\u8fc1\u79fb\u5230 Obsidian \u5bc6\u94a5\u5b58\u50a8");
    }

    delete ai.apiKey;

    return {
      ai,
      openSourceOnDeleteHighlight:
        data?.openSourceOnDeleteHighlight ?? DEFAULT_GENERAL_SETTINGS.openSourceOnDeleteHighlight,
      saveWordTranslations: data?.saveWordTranslations ?? DEFAULT_GENERAL_SETTINGS.saveWordTranslations,
      wordBookPath: data?.wordBookPath ?? DEFAULT_GENERAL_SETTINGS.wordBookPath,
      ignorePatterns: normalizeIgnorePatterns(data?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS),
      rawData: data ?? {}
    };
  }

  clearExternalCache(filePath = null) {
    if (!filePath) {
      this.externalFileMapping = null;
      this.externalHighlightCache = new Map();
      return;
    }

    this.externalHighlightCache?.delete(filePath);
  }

  async ensureExternalStorage() {
    for (const dir of [EXTERNAL_STORAGE_DIR, EXTERNAL_HIGHLIGHTS_DIR, EXTERNAL_METADATA_DIR]) {
      try {
        await this.app.vault.adapter.mkdir(dir);
      } catch (_error) {
        // Existing directories are fine.
      }
    }
  }

  async loadExternalFileMapping() {
    if (this.externalFileMapping) {
      return this.externalFileMapping;
    }

    await this.ensureExternalStorage();
    try {
      const raw = await this.app.vault.adapter.read(EXTERNAL_FILE_MAPPING_PATH);
      const data = parseJsonText(raw);
      this.externalFileMapping = data?.mapping && typeof data.mapping === "object" ? data.mapping : {};
      return this.externalFileMapping;
    } catch (_error) {
      this.externalFileMapping = {};
      return this.externalFileMapping;
    }
  }

  async saveExternalFileMapping(mapping) {
    await this.ensureExternalStorage();
    const payload = JSON.stringify(
      {
        version: "2.0",
        mapping,
        lastUpdated: Date.now()
      },
      null,
      2
    );

    this.externalMappingWriteQueue = (this.externalMappingWriteQueue ?? Promise.resolve()).then(
      async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await this.app.vault.adapter.write(EXTERNAL_FILE_MAPPING_PATH, payload);
            return;
          } catch (error) {
            if (!String(error?.message ?? error).includes("EBUSY") || attempt === 4) {
              throw error;
            }
            await sleep(120 * (attempt + 1));
          }
        }
      }
    );

    await this.externalMappingWriteQueue;
    this.externalFileMapping = mapping;
  }

  async getExternalStoragePath(filePath, create = true) {
    const mapping = await this.loadExternalFileMapping();
    if (!mapping[filePath]) {
      if (!create) {
        return null;
      }
      mapping[filePath] = toSafeExternalFileName(filePath);
      await this.saveExternalFileMapping(mapping);
    }

    return `${EXTERNAL_HIGHLIGHTS_DIR}/${mapping[filePath]}`;
  }

  async loadExternalHighlightData(filePath, options = {}) {
    const create = options.create ?? false;
    this.externalHighlightCache ??= new Map();
    if (!create && this.externalHighlightCache.has(filePath)) {
      return this.externalHighlightCache.get(filePath);
    }

    const storagePath = await this.getExternalStoragePath(filePath, create);
    if (!storagePath) {
      const empty = {
        version: "2.0",
        lastModified: Date.now(),
        highlights: {}
      };
      this.externalHighlightCache.set(filePath, empty);
      return empty;
    }

    try {
      const raw = await this.app.vault.adapter.read(storagePath);
      const data = parseJsonText(raw);
      const normalized = {
        version: data?.version ?? "2.0",
        lastModified: data?.lastModified ?? Date.now(),
        highlights: data?.highlights ?? {}
      };
      this.externalHighlightCache.set(filePath, normalized);
      return normalized;
    } catch (_error) {
      const empty = {
        version: "2.0",
        lastModified: Date.now(),
        highlights: {}
      };
      this.externalHighlightCache.set(filePath, empty);
      return empty;
    }
  }

  async saveExternalHighlightData(filePath, data) {
    const storagePath = await this.getExternalStoragePath(filePath, true);
    await this.ensureExternalStorage();
    await this.app.vault.adapter.write(
      storagePath,
      JSON.stringify(
        {
          version: "2.0",
          lastModified: Date.now(),
          highlights: data.highlights ?? {}
        },
        null,
        2
      )
    );
    this.externalHighlightCache ??= new Map();
    this.externalHighlightCache.set(filePath, {
      version: "2.0",
      lastModified: Date.now(),
      highlights: data.highlights ?? {}
    });
  }

  getExternalEntryForAnnotation(annotation, externalHighlights) {
    const direct = externalHighlights[annotation.externalId];
    return (
      direct ??
      Object.values(externalHighlights).find(
        (entry) =>
          entry.text === annotation.text &&
          Math.abs((entry.position ?? 0) - annotation.start) < 20
      ) ??
      null
    );
  }

  getExternalCommentsForAnnotation(annotation, externalHighlights) {
    const matched = this.getExternalEntryForAnnotation(annotation, externalHighlights);
    return normalizeExternalComments(matched?.comments);
  }

  async getMergedAnnotations(file, content) {
    const annotations = parseAnnotations(content);
    const data = await this.loadExternalHighlightData(file.path);

    return annotations.map((annotation) => {
      const externalId = createExternalId(file.path, annotation.start, annotation.text);
      const externalComments = this.getExternalCommentsForAnnotation(
        { ...annotation, externalId },
        data.highlights
      );
      const inlineComments = annotation.note
        ? [
            {
              id: "inline-comment",
              content: annotation.note,
              created: Date.now(),
              updated: Date.now()
            }
          ]
        : [];
      const comments = externalComments.length ? externalComments : inlineComments;
      const note = getCommentsText(comments);
      return {
        ...annotation,
        externalId,
        filePath: file.path,
        comments,
        note,
        storage: externalComments.length ? "external" : annotation.note ? "inline" : "highlight"
      };
    });
  }

  async saveExternalAnnotationComments(file, annotation, comments) {
    const data = await this.loadExternalHighlightData(file.path, { create: true });
    const now = Date.now();
    const id = annotation.externalId ?? createExternalId(file.path, annotation.start, annotation.text);
    const existing = data.highlights[id] ?? {};
    const normalizedComments = normalizeExternalComments(comments);

    data.highlights[id] = {
      ...existing,
      text: annotation.text,
      position: annotation.start,
      created: existing.created ?? now,
      updated: now,
      backgroundColor: existing.backgroundColor ?? "",
      comments: normalizedComments
    };

    await this.saveExternalHighlightData(file.path, data);
  }

  async appendExternalAnnotationComment(file, annotation, note) {
    const data = await this.loadExternalHighlightData(file.path, { create: true });
    const now = Date.now();
    const id = annotation.externalId ?? createExternalId(file.path, annotation.start, annotation.text);
    const existing = data.highlights[id] ?? {};
    const comments = normalizeExternalComments(existing.comments);

    comments.push({
      id: `comment-${now}-${Math.random().toString(36).slice(2, 8)}`,
      content: note,
      created: now,
      updated: now
    });

    await this.saveExternalAnnotationComments(file, annotation, comments);
  }

  async upsertExternalAnnotation(file, annotation, note) {
    const comments = normalizeExternalComments(annotation.comments);
    if (comments.length) {
      const now = Date.now();
      comments[comments.length - 1] = {
        ...comments[comments.length - 1],
        content: note,
        updated: now
      };
      await this.saveExternalAnnotationComments(file, annotation, comments);
      return;
    }

    await this.appendExternalAnnotationComment(file, annotation, note);
  }

  async updateExternalAnnotationComment(file, annotation, commentId, note) {
    const comments = normalizeExternalComments(annotation.comments);
    const now = Date.now();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            content: note,
            updated: now
          }
        : comment
    );

    await this.saveExternalAnnotationComments(file, annotation, nextComments);
  }

  async deleteExternalAnnotationComment(file, annotation, commentId = null) {
    if (!commentId) {
      await this.deleteExternalAnnotation(file, annotation);
      return;
    }

    const comments = normalizeExternalComments(annotation.comments).filter(
      (comment) => comment.id !== commentId
    );
    await this.saveExternalAnnotationComments(file, annotation, comments);
  }

  async deleteExternalAnnotation(file, annotation) {
    const data = await this.loadExternalHighlightData(file.path, { create: true });
    const id = annotation.externalId ?? createExternalId(file.path, annotation.start, annotation.text);
    delete data.highlights[id];
    await this.saveExternalHighlightData(file.path, data);
  }

  getFlashcardStateFromData(data) {
    return {
      cards: data?.cards ?? {},
      lastSyncedAt: data?.lastSyncedAt ?? null
    };
  }

  async saveSettings() {
    const { apiKey, ...aiSettings } = this.settings.ai ?? {};
    await this.saveData({
      cards: this.flashcardState?.cards ?? {},
      lastSyncedAt: this.flashcardState?.lastSyncedAt ?? null,
      ai: aiSettings,
      openSourceOnDeleteHighlight: this.settings.openSourceOnDeleteHighlight,
      saveWordTranslations: this.settings.saveWordTranslations,
      wordBookPath: this.settings.wordBookPath,
      ignorePatterns: normalizeIgnorePatterns(this.settings.ignorePatterns)
    });
  }

  async saveFlashcardState() {
    await this.saveSettings();
  }

  getAiOptions() {
    return {
      enabled: this.isAiAnnotationConfigured(),
      generate: (selectedText, currentNote) => this.generateAiAnnotation(selectedText, currentNote)
    };
  }

  isAiAnnotationConfigured() {
    const ai = this.settings?.ai ?? {};
    return Boolean(ai.enabled && ai.apiUrl && ai.apiKeySecretId && ai.model);
  }

  async getAiApiKey() {
    const secretId = this.settings?.ai?.apiKeySecretId;
    if (!secretId) {
      return "";
    }

    return (await this.app.secretStorage.getSecret(secretId)) ?? "";
  }

  buildAiPrompt(selectedText, currentNote = "") {
    const template = this.settings.ai.prompt || DEFAULT_AI_SETTINGS.prompt;
    return template
      .replace(/\{\{text\}\}/g, selectedText)
      .replace(/\{\{currentNote\}\}/g, currentNote);
  }

  async generateAiAnnotation(selectedText, currentNote = "") {
    if (!this.isAiAnnotationConfigured()) {
      throw new Error("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u914d\u7f6e AI \u6279\u6ce8");
    }

    const ai = this.settings.ai;
    const apiKey = await this.getAiApiKey();
    if (!apiKey) {
      throw new Error("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u9009\u62e9\u6216\u65b0\u5efa AI API Key");
    }

    const response = await requestUrl({
      url: ai.apiUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: ai.temperature,
        messages: [
          {
            role: "system",
            content: "\u4f60\u662f\u4e00\u4e2a\u5e2e\u52a9\u7528\u6237\u7406\u89e3 Obsidian \u9ad8\u4eae\u5185\u5bb9\u7684\u7b80\u6d01\u6279\u6ce8\u52a9\u624b\u3002\u53ea\u8f93\u51fa\u6279\u6ce8\u672c\u8eab\u3002"
          },
          {
            role: "user",
            content: this.buildAiPrompt(selectedText, currentNote)
          }
        ]
      }),
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(`AI \u8bf7\u6c42\u5931\u8d25\uff1a${message}`);
    }

    const content = response.json?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("AI \u6ca1\u6709\u8fd4\u56de\u6279\u6ce8\u5185\u5bb9");
    }

    return content;
  }

  async requestAiChat(messages, temperature = this.settings.ai.temperature) {
    if (!this.isAiAnnotationConfigured()) {
      throw new Error("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u914d\u7f6e AI");
    }

    const ai = this.settings.ai;
    const apiKey = await this.getAiApiKey();
    if (!apiKey) {
      throw new Error("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u9009\u62e9\u6216\u65b0\u5efa AI API Key");
    }

    const response = await requestUrl({
      url: ai.apiUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: ai.model,
        temperature,
        messages
      }),
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(`AI \u8bf7\u6c42\u5931\u8d25\uff1a${message}`);
    }

    const content = response.json?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("AI \u6ca1\u6709\u8fd4\u56de\u5185\u5bb9");
    }

    return content;
  }

  async generateWordTranslation(word) {
    const prompt = [
      "\u8bf7\u628a\u82f1\u6587\u5355\u8bcd\u6216\u77ed\u8bed\u89e3\u91ca\u4e3a\u4e2d\u6587\uff0c\u5e76\u7ed9\u51fa\u4e00\u4e2a\u81ea\u7136\u7684\u82f1\u6587\u4f8b\u53e5\u548c\u4e2d\u6587\u7ffb\u8bd1\u3002",
      "\u53ea\u8fd4\u56de JSON\uff0c\u4e0d\u8981 Markdown \u4ee3\u7801\u5757\uff0c\u683c\u5f0f\uff1a",
      "{\"word\":\"...\",\"meaning\":\"...\",\"example\":\"...\",\"exampleTranslation\":\"...\"}",
      `\u5355\u8bcd\uff1a${word}`
    ].join("\n");

    const content = await this.requestAiChat(
      [
        {
          role: "system",
          content: "\u4f60\u662f\u4e00\u4e2a\u7b80\u6d01\u51c6\u786e\u7684\u82f1\u8bed\u5355\u8bcd\u52a9\u624b\u3002"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      0.2
    );

    try {
      const parsed = JSON.parse(stripMarkdownFence(content));
      return {
        word: normalizeWordText(parsed.word) || word,
        meaning: String(parsed.meaning ?? "").trim(),
        example: String(parsed.example ?? "").trim(),
        exampleTranslation: String(parsed.exampleTranslation ?? "").trim()
      };
    } catch (_error) {
      return {
        word,
        meaning: content,
        example: "",
        exampleTranslation: ""
      };
    }
  }

  formatWordBookEntry(entry) {
    return `==${entry.word}==`;
  }

  formatWordTranslationComment(entry) {
    const lines = [`\u91ca\u4e49\uff1a${entry.meaning || "\u672a\u8fd4\u56de"}`];
    if (entry.example) {
      lines.push(`\u4f8b\u53e5\uff1a${entry.example}`);
    }

    if (entry.exampleTranslation) {
      lines.push(`\u4f8b\u53e5\u7ffb\u8bd1\uff1a${entry.exampleTranslation}`);
    }

    return lines.join("\n");
  }

  async ensureVaultFile(path, initialContent = "") {
    const normalizedPath = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing) {
      if (!(existing instanceof TFile)) {
        throw new Error(`\u8bcd\u672c\u8def\u5f84\u4e0d\u662f Markdown \u6587\u4ef6\uff1a${normalizedPath}`);
      }
      return existing;
    }

    const parts = normalizedPath.split("/");
    parts.pop();
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        await this.app.vault.createFolder(currentPath);
      }
    }

    return this.app.vault.create(normalizedPath, initialContent);
  }

  async appendWordTranslation(entry) {
    const path = this.settings.wordBookPath || DEFAULT_GENERAL_SETTINGS.wordBookPath;
    const file = await this.ensureVaultFile(path, "#word\n\n");
    const content = await this.app.vault.read(file);
    const duplicatePattern = new RegExp(`(^|\\n)==\\s*${entry.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*==`, "i");
    const existingMatch = duplicatePattern.exec(content);

    let nextContent = content;
    let position = existingMatch ? existingMatch.index + existingMatch[1].length + 2 : -1;
    if (!existingMatch) {
      const separator = content.endsWith("\n\n") || content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
      nextContent = `${content}${separator}${this.formatWordBookEntry(entry)}\n`;
      await this.app.vault.modify(file, nextContent);
      const highlightPosition = nextContent.lastIndexOf(`==${entry.word}==`);
      position = highlightPosition >= 0 ? highlightPosition + 2 : nextContent.lastIndexOf(entry.word);
    }

    const annotation = {
      externalId: createExternalId(file.path, position, entry.word),
      start: position,
      text: entry.word
    };
    if (existingMatch) {
      const data = await this.loadExternalHighlightData(file.path, { create: true });
      const existingEntry = this.getExternalEntryForAnnotation(annotation, data.highlights);
      await this.saveExternalAnnotationComments(
        file,
        annotation,
        [
          {
            ...(normalizeExternalComments(existingEntry?.comments)[0] ?? {}),
            content: this.formatWordTranslationComment(entry)
          }
        ]
      );
    } else {
      await this.appendExternalAnnotationComment(file, annotation, this.formatWordTranslationComment(entry));
    }
    this.clearExternalCache(file.path);
    return !existingMatch;
  }

  async syncFlashcards() {
    const files = this.app.vault.getMarkdownFiles();
    const nextCards = {};
    let count = 0;

    for (const file of files) {
      if (this.shouldIgnoreFile(file)) {
        continue;
      }

      const content = await this.app.vault.cachedRead(file);
      const groups = this.getFileFlashcardGroups(file);
      const annotations = (await this.getMergedAnnotations(file, content)).filter(
        (annotation) => !shouldSkipFlashcardAnnotation(annotation)
      );

      annotations.forEach((annotation) => {
        const id = createCardId(file.path, annotation.line, annotation.text);
        const existing = this.flashcardState.cards[id] ?? {};
        nextCards[id] = {
          ...existing,
          id,
          text: annotation.text,
          note: annotation.note,
          groups,
          filePath: file.path,
          line: annotation.line,
          sourceStart: annotation.start,
          sourceEnd: annotation.end,
          due: existing.due ?? Date.now(),
          stability: existing.stability ?? null,
          difficulty: existing.difficulty ?? null,
          reps: existing.reps ?? 0,
          lapses: existing.lapses ?? 0,
          lastReview: existing.lastReview ?? null,
          updatedAt: Date.now()
        };
        count += 1;
      });
    }

    this.flashcardState.cards = nextCards;
    this.flashcardState.lastSyncedAt = Date.now();
    await this.saveFlashcardState();
    this.refreshFlashcardViews();
    new Notice(`\u5df2\u540c\u6b65 ${count} \u5f20\u9ad8\u4eae\u95ea\u5361`);
  }

  getFileFlashcardGroups(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = new Set(getPathFlashcardGroups(file.path));

    cache?.tags?.forEach((tag) => {
      const normalized = normalizeFlashcardGroup(tag.tag);
      if (normalized) {
        tags.add(normalized);
      }
    });

    const frontmatterTags = cache?.frontmatter?.tags;
    const values = Array.isArray(frontmatterTags)
      ? frontmatterTags
      : typeof frontmatterTags === "string"
        ? frontmatterTags.split(/[,\s]+/)
        : [];

    values.forEach((tag) => {
      const normalized = normalizeFlashcardGroup(String(tag));
      if (normalized) {
        tags.add(normalized);
      }
    });

    return Array.from(tags).sort();
  }

  getFlashcardGroups() {
    const groups = new Map();
    Object.values(this.flashcardState.cards ?? {}).forEach((card) => {
      (card.groups ?? []).forEach((group) => {
        groups.set(group, (groups.get(group) ?? 0) + 1);
      });
    });

    const result = [
      { id: "all", label: this.getFlashcardGroupLabel("all") },
      { id: "__ungrouped", label: this.getFlashcardGroupLabel("__ungrouped") }
    ];

    Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([group]) => {
        result.push({
          id: group,
          label: this.getFlashcardGroupLabel(group)
        });
      });

    return result;
  }

  getFlashcardGroupLabel(group) {
    const name = group === "all" ? "\u5168\u90e8" : group === "__ungrouped" ? "\u672a\u5206\u7ec4" : group;
    const stats = this.getFlashcardStats(group);
    return `${name} · ${stats.due}/${stats.total}`;
  }

  getFlashcardStats(group = "all") {
    const cards = Object.values(this.flashcardState.cards ?? {}).filter((card) =>
      matchesFlashcardGroup(card, group)
    );
    const now = Date.now();
    const learnedCards = cards.filter((card) => (card.reps ?? 0) > 0);
    const reviewedTodayCards = cards.filter(isReviewedToday);
    const totalReviews = learnedCards.reduce((sum, card) => sum + (card.reps ?? 0), 0);
    const totalLapses = learnedCards.reduce((sum, card) => sum + (card.lapses ?? 0), 0);
    const retentionRate = totalReviews ? ((totalReviews - totalLapses) / totalReviews) * 100 : 100;

    return {
      total: cards.length,
      due: cards.filter((card) => (card.due ?? 0) <= now).length,
      newCards: cards.filter((card) => !(card.reps ?? 0)).length,
      learned: learnedCards.length,
      reviewedToday: reviewedTodayCards.length,
      retentionRate: clamp(retentionRate, 0, 100)
    };
  }

  getSortedFlashcards(cards) {
    return cards.sort((left, right) => {
      const leftDue = left.due ?? 0;
      const rightDue = right.due ?? 0;
      if (leftDue !== rightDue) {
        return leftDue - rightDue;
      }
      return left.filePath.localeCompare(right.filePath);
    });
  }

  async getDueFlashcards(group = "all") {
    if (!this.flashcardState.lastSyncedAt) {
      await this.syncFlashcards();
    }

    const now = Date.now();
    return this.getSortedFlashcards(
      Object.values(this.flashcardState.cards).filter(
        (card) => (card.due ?? 0) <= now && matchesFlashcardGroup(card, group)
      )
    );
  }

  async getAllFlashcards(group = "all") {
    if (!this.flashcardState.lastSyncedAt) {
      await this.syncFlashcards();
    }

    return this.getSortedFlashcards(
      Object.values(this.flashcardState.cards).filter((card) => matchesFlashcardGroup(card, group))
    );
  }

  async reviewFlashcard(card, rating) {
    const now = new Date();
    const state = this.flashcardState.cards[card.id];
    if (!state) {
      return;
    }

    const elapsedDays = state.lastReview ? daysBetween(new Date(state.lastReview), now) : 0;
    const retrievability = getRetrievability(elapsedDays, state.stability);

    let stability;
    let difficulty;
    let intervalDays;
    let lapses = state.lapses ?? 0;

    if (!state.reps) {
      stability = initialStability(rating);
      difficulty = initialDifficulty(rating);
      intervalDays = rating === 1 ? 1 : rating === 2 ? 3 : rating === 3 ? 7 : 14;
      if (rating === 1) {
        lapses += 1;
      }
    } else {
      difficulty = nextDifficulty(state.difficulty ?? initialDifficulty(rating), rating);
      if (rating === 1) {
        stability = nextForgetStability(
          difficulty,
          state.stability ?? initialStability(1),
          retrievability
        );
        intervalDays = 1;
        lapses += 1;
      } else {
        stability = nextRecallStability(
          difficulty,
          state.stability ?? initialStability(rating),
          retrievability,
          rating
        );
        if (rating === 2) {
          intervalDays = Math.max(1, Math.min(nextInterval(stability), 4));
        } else {
          intervalDays = nextInterval(stability);
        }
      }
    }

    this.flashcardState.cards[card.id] = {
      ...state,
      difficulty,
      stability,
      due: addDays(now, intervalDays).getTime(),
      reps: (state.reps ?? 0) + 1,
      lapses,
      lastReview: now.getTime()
    };

    await this.saveFlashcardState();
    this.refreshFlashcardViews();
  }

  refreshFlashcardViews() {
    this.app.workspace.detachLeavesOfType(LEGACY_VIEW_TYPE_FLASHCARD_REVIEW);
  }

  parseSelection(selection) {
    return (
      parseMarkdownAnnotationSelection(selection) ||
      parseHtmlAnnotationSelection(selection) ||
      parsePlainHighlightSelection(selection)
    );
  }

  sanitizeNote(note) {
    return note.replace(/%%/g, "% %").trim();
  }

  buildMarkdownAnnotation(text, note) {
    const sanitizedNote = this.sanitizeNote(note);
    if (sanitizedNote.includes("\n")) {
      return `==${text}== %%${ANNOTATION_PREFIX}\n${sanitizedNote}\n%%`;
    }

    return `==${text}== %%${ANNOTATION_PREFIX} ${sanitizedNote}%%`;
  }

  getHighlightTextRange(annotation) {
    const rawTextStart = annotation.raw?.indexOf(annotation.text) ?? -1;
    if (rawTextStart < 0) {
      return {
        start: annotation.start,
        end: annotation.start
      };
    }

    const start = annotation.start + rawTextStart;
    return {
      start,
      end: start + annotation.text.length
    };
  }

  buildPlainHighlight(text) {
    return `==${text}==`;
  }

  annotateSelection(editor) {
    const selection = editor.getSelection();
    if (!selection || !selection.trim()) {
      new Notice("\u8bf7\u5148\u9009\u4e2d\u8981\u6279\u6ce8\u7684\u6587\u5b57");
      return;
    }

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const parsed = this.parseSelection(selection);
    const displayText = parsed ? parsed.text : selection;
    const initialNote = parsed ? parsed.note : "";

    new AnnotationModal(this.app, displayText, initialNote, async (note) => {
      const file = this.getCurrentFile();
      const markup = this.buildPlainHighlight(displayText);
      editor.replaceRange(markup, from, to);
      if (file) {
        const start = editor.posToOffset(from);
        await this.appendExternalAnnotationComment(
          file,
          {
            start,
            text: displayText
          },
          note
        );
      }
      this.refreshAnnotationViews();
      new Notice("\u5df2\u4fdd\u5b58\u6279\u6ce8");
    }, this.getAiOptions()).open();
  }

  async editAnnotationAtCursor(editor) {
    const context = await this.getAnnotationContext(editor);
    if (!context) {
      new Notice("\u5f53\u524d\u5149\u6807\u4e0d\u5728\u6279\u6ce8\u5185");
      return;
    }

    new AnnotationModal(this.app, context.text, context.note, async (note) => {
      const file = this.getCurrentFile();
      if (file) {
        const comments = normalizeExternalComments(context.comments);
        if (comments.length) {
          await this.updateExternalAnnotationComment(file, context, comments[comments.length - 1].id, note);
        } else {
          await this.appendExternalAnnotationComment(file, context, note);
        }
      }
      this.refreshAnnotationViews();
      new Notice("\u6279\u6ce8\u5df2\u66f4\u65b0");
    }, this.getAiOptions()).open();
  }

  async aiAnnotateAtCursor(editor) {
    const context = await this.getAnnotationContext(editor);
    if (!context) {
      new Notice("\u5f53\u524d\u5149\u6807\u4e0d\u5728\u6279\u6ce8\u5185");
      return;
    }

    if (!this.isAiAnnotationConfigured()) {
      new Notice("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u914d\u7f6e AI \u6279\u6ce8");
      return;
    }

    const notice = new Notice("AI \u6279\u6ce8\u751f\u6210\u4e2d...", 0);
    try {
      const note = await this.generateAiAnnotation(context.text, context.note);
      const file = this.getCurrentFile();
      if (file) {
        await this.appendExternalAnnotationComment(file, context, note);
      }
      const highlightRange = this.getHighlightTextRange(context);
      editor.setSelection(
        editor.offsetToPos(highlightRange.start),
        editor.offsetToPos(highlightRange.end)
      );
      editor.setCursor(editor.offsetToPos(highlightRange.start));
      this.refreshAnnotationViews();
      window.setTimeout(hideAnnotationCommentsInDocument, 0);
      new Notice("AI \u6279\u6ce8\u5df2\u6dfb\u52a0");
    } catch (error) {
      console.error("Highlight Annotation AI cursor annotation error", error);
      new Notice(error?.message || "AI \u6279\u6ce8\u751f\u6210\u5931\u8d25");
    } finally {
      notice.hide();
    }
  }

  async translateSelectedWord(editor) {
    const word = normalizeWordText(editor.getSelection());
    if (!isLikelyEnglishWord(word)) {
      new Notice("\u8bf7\u5148\u9009\u4e2d\u82f1\u6587\u5355\u8bcd\u6216\u77ed\u8bed");
      return;
    }

    const anchorRect = this.getEditorSelectionRect(editor);
    const notice = new Notice(`AI \u6b63\u5728\u7ffb\u8bd1\uff1a${word}`, 0);
    try {
      const entry = await this.generateWordTranslation(word);
      let savedState = "off";

      if (this.settings.saveWordTranslations) {
        const added = await this.appendWordTranslation(entry);
        savedState = added ? "saved" : "exists";
      }

      this.showWordTranslationTooltip(anchorRect, entry, savedState);
    } catch (error) {
      console.error("Highlight Annotation word translation error", error);
      new Notice(error?.message || "AI \u5355\u8bcd\u7ffb\u8bd1\u5931\u8d25");
    } finally {
      notice.hide();
    }
  }

  async deleteAnnotationAtCursor(editor) {
    const context = await this.getAnnotationContext(editor);
    if (!context) {
      new Notice("\u5f53\u524d\u5149\u6807\u4e0d\u5728\u6279\u6ce8\u5185");
      return;
    }

    new ConfirmModal(
      this.app,
      "\u5220\u9664\u6279\u6ce8",
      "\u5220\u9664\u540e\u4f1a\u4fdd\u7559\u9ad8\u4eae\uff0c\u53ea\u79fb\u9664\u6279\u6ce8\u5185\u5bb9\u3002",
      async () => {
        const file = this.getCurrentFile();
        if (file) {
          await this.deleteExternalAnnotation(file, context);
        }
        this.refreshAnnotationViews();
        new Notice("\u6279\u6ce8\u5df2\u5220\u9664");
      }
    ).open();
  }

  async getAnnotationContext(editor) {
    const content = editor.getValue();
    const selection = editor.getSelection();
    const file = this.getCurrentFile();

    if (selection) {
      const parsedSelection = this.parseSelection(selection);
      if (parsedSelection && parsedSelection.kind !== "highlight") {
        const fromOffset = editor.posToOffset(editor.getCursor("from"));
        const base = {
          ...parsedSelection,
          start: fromOffset,
          end: fromOffset + selection.length
        };
        return file ? (await this.getMergedAnnotations(file, content)).find(
          (annotation) => annotation.start === base.start && annotation.text === base.text
        ) ?? base : base;
      }
    }

    const cursorOffset = editor.posToOffset(editor.getCursor());
    if (file) {
      return (
        (await this.getMergedAnnotations(file, content)).find(
          (annotation) => cursorOffset >= annotation.start && cursorOffset <= annotation.end
        ) ?? null
      );
    }

    return this.findAnnotationAtOffset(content, cursorOffset);
  }

  findAnnotationAtOffset(content, offset) {
    return (
      parseAnnotations(content).find(
        (annotation) => offset >= annotation.start && offset <= annotation.end
      ) ?? null
    );
  }

  findMatchingAnnotation(content, target) {
    const annotations = parseAnnotations(content);
    return (
      annotations.find(
        (annotation) =>
          annotation.start === target.start &&
          annotation.end === target.end &&
          annotation.line === target.line &&
          annotation.text === target.text
      ) ??
      annotations.find(
        (annotation) =>
          annotation.start === target.start &&
          annotation.kind === target.kind &&
          annotation.text === target.text &&
          annotation.note === target.note
      ) ??
      annotations.find(
        (annotation) =>
          annotation.kind === target.kind &&
          annotation.text === target.text &&
          annotation.note === target.note &&
          annotation.line === target.line
      ) ??
      annotations.find(
        (annotation) =>
          annotation.text === target.text &&
          annotation.note === target.note &&
          annotation.line === target.line
      ) ??
      null
    );
  }

  async findMatchingMergedAnnotation(file, content, target) {
    const fallback = this.findMatchingAnnotation(content, target);
    const annotations = await this.getMergedAnnotations(file, content);
    return (
      annotations.find(
        (annotation) =>
          annotation.start === target.start &&
          annotation.end === target.end &&
          annotation.line === target.line &&
          annotation.text === target.text
      ) ??
      annotations.find(
        (annotation) =>
          fallback &&
          annotation.start === fallback.start &&
          annotation.end === fallback.end &&
          annotation.text === fallback.text
      ) ??
      fallback
    );
  }

  async getMarkdownLeaf() {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === "markdown") {
      return activeLeaf;
    }

    return this.app.workspace.getLeavesOfType("markdown")[0] ?? this.app.workspace.getLeaf(true);
  }

  async revealAnnotation(file, target) {
    const leaf = await this.getMarkdownLeaf();
    this.suppressCurrentFileRefreshUntil = Date.now() + 1200;
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      return;
    }

    const latest = this.findMatchingAnnotation(view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u5bf9\u5e94\u7684\u6279\u6ce8");
      return;
    }

    const from = view.editor.offsetToPos(latest.start);
    const to = view.editor.offsetToPos(latest.end);
    view.editor.setSelection(from, to);
    view.editor.setCursor(from);
    view.editor.focus();
  }

  async addAnnotationCommentInFile(file, target, initialNote = "") {
    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u6dfb\u52a0\u6279\u6ce8\u7684\u9ad8\u4eae");
      return;
    }

    new AnnotationModal(this.app, latest.text, initialNote, async (note) => {
      await this.appendExternalAnnotationComment(file, latest, note);
      this.refreshAnnotationViews();
      new Notice("\u6279\u6ce8\u5df2\u6dfb\u52a0");
    }, this.getAiOptions()).open();
  }

  async editAnnotationCommentInFile(file, target, comment) {
    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u7f16\u8f91\u7684\u6279\u6ce8");
      return;
    }

    new AnnotationModal(this.app, latest.text, comment.content, async (note) => {
      await this.updateExternalAnnotationComment(file, latest, comment.id, note);
      this.refreshAnnotationViews();
      new Notice("\u6279\u6ce8\u5df2\u66f4\u65b0");
    }, this.getAiOptions()).open();
  }

  async editAnnotationInFile(file, target) {
    const comments = normalizeExternalComments(target.comments);
    if (comments.length) {
      await this.editAnnotationCommentInFile(file, target, comments[comments.length - 1]);
      return;
    }

    await this.addAnnotationCommentInFile(file, target, target.note ?? "");
  }

  async aiAnnotateInFile(file, target) {
    if (!this.isAiAnnotationConfigured()) {
      new Notice("\u8bf7\u5148\u5728\u63d2\u4ef6\u8bbe\u7f6e\u4e2d\u914d\u7f6e AI \u6279\u6ce8");
      return;
    }

    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u751f\u6210\u6279\u6ce8\u7684\u9ad8\u4eae");
      return;
    }

    const notice = new Notice("AI \u6279\u6ce8\u751f\u6210\u4e2d...", 0);
    try {
      const note = await this.generateAiAnnotation(latest.text, target.note ?? latest.note);
      await this.appendExternalAnnotationComment(file, latest, note);
      const highlightRange = this.getHighlightTextRange(latest);
      view.editor.setSelection(
        view.editor.offsetToPos(highlightRange.start),
        view.editor.offsetToPos(highlightRange.end)
      );
      view.editor.setCursor(view.editor.offsetToPos(highlightRange.start));
      this.refreshAnnotationViews();
      window.setTimeout(hideAnnotationCommentsInDocument, 0);
      new Notice("AI \u6279\u6ce8\u5df2\u6dfb\u52a0");
    } catch (error) {
      console.error("Highlight Annotation AI file annotation error", error);
      new Notice(error?.message || "AI \u6279\u6ce8\u751f\u6210\u5931\u8d25");
    } finally {
      notice.hide();
    }
  }

  async deleteAnnotationCommentInFile(file, target, comment) {
    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u6279\u6ce8");
      return;
    }

    new ConfirmModal(
      this.app,
      "\u5220\u9664\u8fd9\u6761\u6279\u6ce8",
      "\u5220\u9664\u540e\u4f1a\u4fdd\u7559\u540c\u4e00\u9ad8\u4eae\u4e0b\u7684\u5176\u4ed6\u6279\u6ce8\u3002",
      async () => {
        await this.deleteExternalAnnotationComment(file, latest, comment.id);
        this.refreshAnnotationViews();
        new Notice("\u6279\u6ce8\u5df2\u5220\u9664");
      }
    ).open();
  }

  async deleteAnnotationInFile(file, target) {
    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u6279\u6ce8");
      return;
    }

    new ConfirmModal(
      this.app,
      "\u6e05\u7a7a\u6279\u6ce8",
      "\u6e05\u7a7a\u540e\u4f1a\u4fdd\u7559\u9ad8\u4eae\uff0c\u53ea\u79fb\u9664\u8fd9\u6761\u9ad8\u4eae\u4e0b\u7684\u5168\u90e8\u6279\u6ce8\u3002",
      async () => {
        await this.deleteExternalAnnotation(file, latest);
        this.refreshAnnotationViews();
        new Notice("\u6279\u6ce8\u5df2\u6e05\u7a7a");
      }
    ).open();
  }

  async deleteHighlightInFile(file, target) {
    if (!this.settings.openSourceOnDeleteHighlight) {
      await this.deleteHighlightInFileSilently(file, target);
      return;
    }

    const leaf = await this.getMarkdownLeaf();
    await leaf.openFile(file, { active: true });
    this.app.workspace.setActiveLeaf(leaf, true, true);

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("\u5f53\u524d\u65e0\u6cd5\u6253\u5f00\u53ef\u7f16\u8f91\u89c6\u56fe");
      return;
    }

    const latest = await this.findMatchingMergedAnnotation(file, view.editor.getValue(), target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u9ad8\u4eae");
      return;
    }

    new ConfirmModal(
      this.app,
      "\u5220\u9664\u9ad8\u4eae",
      "\u5220\u9664\u540e\u4f1a\u5c06 ==\u9ad8\u4eae== \u8fd8\u539f\u4e3a\u666e\u901a\u6587\u672c\uff0c\u5e76\u5220\u9664\u8fd9\u6761\u9ad8\u4eae\u7684\u5168\u90e8\u6279\u6ce8\u3002",
      async () => {
        const latestContent = view.editor.getValue();
        const current = await this.findMatchingMergedAnnotation(file, latestContent, latest);
        if (!current) {
          new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u9ad8\u4eae");
          return;
        }

        const range = this.getHighlightTextRange(current);
        const from = view.editor.offsetToPos(current.start);
        const to = view.editor.offsetToPos(current.end);
        const cursor = view.editor.offsetToPos(range.start);
        view.editor.replaceRange(current.text, from, to);
        view.editor.setCursor(cursor);
        view.editor.focus();
        await this.deleteExternalAnnotation(file, current);
        this.clearExternalCache(file.path);
        this.refreshAnnotationViews();
        new Notice("\u9ad8\u4eae\u548c\u6279\u6ce8\u5df2\u5220\u9664");
      }
    ).open();
  }

  async deleteHighlightInFileSilently(file, target) {
    const content = await this.app.vault.read(file);
    const latest = await this.findMatchingMergedAnnotation(file, content, target);
    if (!latest) {
      new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u9ad8\u4eae");
      return;
    }

    new ConfirmModal(
      this.app,
      "\u5220\u9664\u9ad8\u4eae",
      `\u5c06\u5728\u540e\u53f0\u4fee\u6539 ${file.path}\uff0c\u628a ==\u9ad8\u4eae== \u8fd8\u539f\u4e3a\u666e\u901a\u6587\u672c\uff0c\u5e76\u5220\u9664\u8fd9\u6761\u9ad8\u4eae\u7684\u5168\u90e8\u6279\u6ce8\u3002`,
      async () => {
        const latestContent = await this.app.vault.read(file);
        const current = await this.findMatchingMergedAnnotation(file, latestContent, latest);
        if (!current) {
          new Notice("\u6ca1\u627e\u5230\u53ef\u5220\u9664\u7684\u9ad8\u4eae");
          return;
        }

        const nextContent = `${latestContent.slice(0, current.start)}${current.text}${latestContent.slice(current.end)}`;
        await this.app.vault.modify(file, nextContent);
        await this.deleteExternalAnnotation(file, current);
        this.clearExternalCache(file.path);
        this.currentHighlightSignature = getHighlightSignature(nextContent);
        this.refreshAnnotationViews();
        new Notice("\u9ad8\u4eae\u548c\u6279\u6ce8\u5df2\u5220\u9664");
      }
    ).open();
  }

  async migrateLegacyAnnotationsInCurrentFile() {
    const view = this.getActiveMarkdownView();
    const file = this.getCurrentFile();
    if (!view?.editor || !file) {
      new Notice("\u8bf7\u5148\u6253\u5f00\u4e00\u7bc7\u53ef\u7f16\u8f91\u7684 Markdown \u7b14\u8bb0");
      return;
    }

    const content = view.editor.getValue();
    const legacyAnnotations = parseAnnotations(content).filter(
      (annotation) => annotation.kind === "html"
    );

    if (!legacyAnnotations.length) {
      new Notice("\u5f53\u524d\u7b14\u8bb0\u6ca1\u6709\u9700\u8981\u8fc1\u79fb\u7684 HTML \u6279\u6ce8");
      return;
    }

    const externalAnnotations = [];
    const migratedContent = content.replace(getHtmlRegex(), (_match, note, text) => {
      const plain = this.buildPlainHighlight(unescapeHtml(text));
      externalAnnotations.push({
        text: unescapeHtml(text),
        note: unescapeHtml(note).trim()
      });
      return plain;
    });

    let searchFrom = 0;
    for (const annotation of externalAnnotations) {
      const raw = this.buildPlainHighlight(annotation.text);
      const start = migratedContent.indexOf(raw, searchFrom);
      if (start < 0) {
        continue;
      }
      await this.upsertExternalAnnotation(
        file,
        {
          start,
          end: start + raw.length,
          text: annotation.text
        },
        annotation.note
      );
      searchFrom = start + raw.length;
    }

    view.editor.setValue(migratedContent);
    this.refreshAnnotationViews();
    new Notice(`\u5df2\u8fc1\u79fb ${legacyAnnotations.length} \u6761\u65e7\u6279\u6ce8\u5230\u5916\u7f6e JSON`);
  }

  async migrateInlineAnnotationsToExternalStorage() {
    const view = this.getActiveMarkdownView();
    const file = this.getCurrentFile();
    if (!view?.editor || !file) {
      new Notice("\u8bf7\u5148\u6253\u5f00\u4e00\u7bc7\u53ef\u7f16\u8f91\u7684 Markdown \u7b14\u8bb0");
      return;
    }

    const content = view.editor.getValue();
    const migration = migrateInlineAnnotationContent(content);
    const annotations = migration.annotations;

    if (!annotations.length) {
      new Notice("\u5f53\u524d\u7b14\u8bb0\u6ca1\u6709\u9700\u8981\u8fc1\u79fb\u7684\u5185\u8054\u6279\u6ce8");
      return;
    }

    for (const annotation of annotations) {
      await this.upsertExternalAnnotation(file, annotation, annotation.note);
    }

    view.editor.setValue(migration.content);
    this.refreshAnnotationViews();
    hideAnnotationCommentsInDocument();
    new Notice(`\u5df2\u8fc1\u79fb ${annotations.length} \u6761\u6279\u6ce8\u5230\u5916\u7f6e JSON`);
  }

  async migrateAllInlineAnnotationsToExternalStorage() {
    const files = this.app.vault.getMarkdownFiles();
    let changedFiles = 0;
    let migratedCount = 0;

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (!content.includes("%%hl-annotation:")) {
        continue;
      }

      const migration = migrateInlineAnnotationContent(content);
      if (!migration.annotations.length || migration.content === content) {
        continue;
      }

      for (const annotation of migration.annotations) {
        await this.upsertExternalAnnotation(file, annotation, annotation.note);
      }

      await this.app.vault.modify(file, migration.content);
      changedFiles += 1;
      migratedCount += migration.annotations.length;
    }

    this.refreshAnnotationViews();
    hideAnnotationCommentsInDocument();
    new Notice(`\u5df2\u8fc1\u79fb ${migratedCount} \u6761\u6279\u6ce8\uff0c\u6e05\u7406 ${changedFiles} \u4e2a\u6587\u4ef6`);
  }
};
