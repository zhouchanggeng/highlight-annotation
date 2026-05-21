const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const pluginPath = path.join(__dirname, "..", "main.js");
const source = `${fs.readFileSync(pluginPath, "utf8")}

module.exports.__test = {
  parseAnnotations
};
`;

const testModule = new Module(pluginPath, module);
testModule.filename = pluginPath;
testModule.paths = Module._nodeModulePaths(path.dirname(pluginPath));

const originalLoad = Module._load;
Module._load = (request, parent, isMain) => {
  if (request === "obsidian") {
    class Base {}
    return {
      ItemView: Base,
      MarkdownView: Base,
      Modal: Base,
      Notice: Base,
      Plugin: Base,
      PluginSettingTab: Base,
      SecretComponent: Base,
      Setting: Base,
      TFile: Base,
      normalizePath: (value) => value,
      requestUrl: async () => ({ json: {} })
    };
  }

  if (request === "@codemirror/view") {
    return {
      Decoration: {
        replace: () => ({ range: (start, end) => ({ start, end }) }),
        mark: () => ({ range: (start, end) => ({ start, end }) })
      },
      ViewPlugin: {
        fromClass: () => ({})
      }
    };
  }

  return originalLoad(request, parent, isMain);
};

try {
  testModule._compile(source, pluginPath);
} finally {
  Module._load = originalLoad;
}

const { parseAnnotations } = testModule.exports.__test;
const HighlightAnnotationPlugin = testModule.exports;

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("does not treat Cubox URL padding as the start of a highlight", () => {
  const content = [
    "created:: 2026-05-19T08:23:31.579+0800",
    "source:: https://mp.weixin.qq.com/s?__biz=MzkxNQ==&mid=2247542635&idx=1&sn=ad55e51d180021d2f92e32daa030f144",
    "tags:: cubox inbox",
    "",
    "# 万字长文，基于Qwen多模态大模型，智慧城市积水识别智能体实战！",
    "## 摘要",
    "知识详解",
    "",
    "## 高亮划线",
    "- ==Prompt 是与大模型交互的核心，精心设计的 Prompt 能显著提升输出质量。==",
    "  - Time: 2026-05-20T16:06:48.335+0800"
  ].join("\n");

  const annotations = parseAnnotations(content);

  assert.equal(annotations.length, 1);
  assert.equal(
    annotations[0].text,
    "Prompt 是与大模型交互的核心，精心设计的 Prompt 能显著提升输出质量。"
  );
  assert.equal(annotations[0].line, 10);
});

test("keeps ordinary inline highlights", () => {
  const content = "这是一段 ==正常高亮==，后面还有文字。";

  const annotations = parseAnnotations(content);

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].text, "正常高亮");
  assert.equal(annotations[0].kind, "highlight");
});

test("reads from vault instead of a stale active editor immediately after switching files", async () => {
  const file = { path: "Inbox/cubox/current.md" };
  const plugin = Object.create(HighlightAnnotationPlugin.prototype);
  plugin.currentFile = file;
  plugin.currentFileSwitchedAt = Date.now();
  plugin.getActiveMarkdownView = () => ({
    file,
    editor: {
      getValue: () => "==前一篇文章的高亮=="
    }
  });
  plugin.app = {
    vault: {
      cachedRead: async () => "==当前文章的高亮=="
    }
  };

  const content = await plugin.getFileContent(file);

  assert.equal(content, "==当前文章的高亮==");
});

test("reads unsaved active editor content after file switching has settled", async () => {
  const file = { path: "Inbox/cubox/current.md" };
  const plugin = Object.create(HighlightAnnotationPlugin.prototype);
  plugin.currentFile = file;
  plugin.currentFileSwitchedAt = Date.now() - 1000;
  plugin.getActiveMarkdownView = () => ({
    file,
    editor: {
      getValue: () => "==编辑器里未保存的新高亮=="
    }
  });
  plugin.app = {
    vault: {
      cachedRead: async () => "==磁盘上的旧高亮=="
    }
  };

  const content = await plugin.getFileContent(file);

  assert.equal(content, "==编辑器里未保存的新高亮==");
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
})();
