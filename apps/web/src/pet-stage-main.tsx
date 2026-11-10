import React from "react";
import { createRoot } from "react-dom/client";
import PetStageHost from "./PetStageHost";
import "./index.css";

document.body.classList.add("avatar-mode");
createRoot(document.getElementById("pet-stage-root")!).render(<React.StrictMode><PetStageHost /></React.StrictMode>);

