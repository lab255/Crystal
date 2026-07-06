import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

export function mount(container: HTMLElement): void {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

const el = document.getElementById("root");
if (el) {
  mount(el);
}
