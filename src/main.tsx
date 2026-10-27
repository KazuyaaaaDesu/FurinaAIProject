import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import PetStageHost from "./PetStageHost";

const searchParams = new URLSearchParams(window.location.search);
const isAvatar =
  searchParams.get("avatar") === "1" ||
  searchParams.get("debugMotions") === "1" ||
  searchParams.get("toolbar") === "1";

createRoot(document.getElementById("root")!).render(
  isAvatar ? <PetStageHost /> : <App />
);

