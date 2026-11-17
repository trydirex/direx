// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./styles.css";
import { queryClient } from "./api/query";
import { router } from "./router";
import { meQuery, reloadOnRestore, workspacesQuery } from "./shell/session";

// Who is signed in and their Workspaces load together, before the router asks for either.
void queryClient.prefetchQuery(meQuery);
void queryClient.prefetchQuery(workspacesQuery);
reloadOnRestore();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
