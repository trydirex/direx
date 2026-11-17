// SPDX-License-Identifier: AGPL-3.0-only
// Astryx's providers for the app: the neutral theme in light mode (dark waits for its own plan), links
// that move through TanStack Router instead of reloading the page, and the layer host toasts render in.
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Theme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

const external = (href: string) => /^([a-z][a-z\d+.-]*:|\/\/)/i.test(href);

/** The link every Astryx component renders. A plain left click on a same-site link is handed to the
    router; a modified or middle click, a `target`, or another site stays a browser link. */
export function RouterLink({ href, onClick, ...rest }: ComponentProps<"a">) {
  const router = useRouter();
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plain || !href || rest.target || external(href)) return;
    event.preventDefault();
    void router.navigate({ href });
  };
  return <a href={href} onClick={click} {...rest} />;
}

export function AstryxProvider({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme} mode="light">
      <LinkProvider component={RouterLink}>
        <LayerProvider>{children}</LayerProvider>
      </LinkProvider>
    </Theme>
  );
}
