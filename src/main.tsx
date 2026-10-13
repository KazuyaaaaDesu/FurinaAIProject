
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Avatar from "./Avatar";

const isAvatar = new URLSearchParams(window.location.search).get("avatar") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAvatar ? <Avatar /> : <App />}
  </StrictMode>,
);
