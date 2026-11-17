// SPDX-License-Identifier: AGPL-3.0-only
// Toasts: Astryx's, shown with the `toast.add({ title, description })` our screens and actions already
// call, from components or not. <Toaster> (in the shell, and in tests) hands Astryx's show function over.
import { useEffect, type ReactNode } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { Button } from "@/components/Button";

type Options = { title: ReactNode; description?: ReactNode; actionProps?: { children: string; onClick: () => void } };
let show: ReturnType<typeof useToast> | undefined;

export const toast = {
  add(o: Options) {
    show?.({
      body: o.description ? (
        <span>
          <strong className="font-semibold">{o.title}</strong> {o.description}
        </span>
      ) : (
        o.title
      ),
      endContent: o.actionProps && (
        <Button size="sm" variant="ghost" onClick={o.actionProps.onClick}>
          {o.actionProps.children}
        </Button>
      ),
    });
  },
};

export function Toaster({ children }: { children?: ReactNode }) {
  const s = useToast();
  useEffect(() => {
    show = s;
    return () => {
      if (show === s) show = undefined;
    };
  }, [s]);
  return <>{children}</>;
}
