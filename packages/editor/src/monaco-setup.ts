import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let configured = false;

/**
 * Wire Monaco to the locally bundled build (no CDN) and register the Crystal
 * theme. Idempotent; call before rendering any editor.
 */
export function setupMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });

  monaco.editor.defineTheme("crystal-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5d6577", fontStyle: "italic" },
      { token: "keyword", foreground: "9d8cfc" },
      { token: "string", foreground: "7de3f4" },
      { token: "number", foreground: "fbbf24" },
      { token: "type", foreground: "34d399" },
      { token: "function", foreground: "60a5fa" },
    ],
    colors: {
      "editor.background": "#0a0c11",
      "editor.foreground": "#e7eaf3",
      "editor.lineHighlightBackground": "#10131a",
      "editor.selectionBackground": "#8b7cf640",
      "editorLineNumber.foreground": "#3d4354",
      "editorLineNumber.activeForeground": "#99a1b3",
      "editorIndentGuide.background1": "#1d222e",
      "editorWidget.background": "#161a23",
      "editorWidget.border": "#232936",
      "editorSuggestWidget.background": "#161a23",
      "editorSuggestWidget.selectedBackground": "#8b7cf630",
      "editorCursor.foreground": "#9d8cfc",
      "scrollbarSlider.background": "#31394966",
      "scrollbarSlider.hoverBackground": "#31394999",
    },
  });

  // TS/JS defaults: single-file smartness without a project.
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
}

export { monaco };
