// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./tokens.css";
import { AstryxProvider } from "../components/astryx";
import { AstryxSpike } from "./Astryx";
import { Tokens } from "./Tokens";

createRoot(document.getElementById("root")!).render(
  <AstryxProvider>
    <Tokens />
    <AstryxSpike />
  </AstryxProvider>,
);
