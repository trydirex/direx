// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { isPublicUrl } from "./domain/public-url";

test.each(["https://direx.example.com", "https://app.trydirex.com/x", "https://8.8.8.8", "https://172.32.0.1", "https://[2001:db8::1]"])("%s is public", (url) => {
  expect(isPublicUrl(url)).toBe(true);
});

test.each([
  "http://direx.example.com",
  "https://localhost:3000",
  "https://direx.localhost",
  "https://nas.local",
  "https://box.home.arpa",
  "https://intranet",
  "https://127.0.0.1",
  "https://10.0.0.5",
  "https://172.16.4.4",
  "https://192.168.1.10",
  "https://169.254.1.1",
  "https://100.64.0.1",
  "https://[::1]",
  "https://[fd00::1]",
  "https://[fe80::1]",
  "not a url",
])("%s is not public", (url) => {
  expect(isPublicUrl(url)).toBe(false);
});
