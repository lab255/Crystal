import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Crystal } from "@crystal/sdk";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crystal />
  </StrictMode>,
);
