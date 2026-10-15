import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Avatar from "./Avatar";

const searchParams = new URLSearchParams(window.location.search);
const isAvatar =
  searchParams.get("avatar") === "1" ||
  searchParams.get("debugMotions") === "1";

createRoot(document.getElementById("root")!).render(
  isAvatar ? <Avatar /> : <App />
);