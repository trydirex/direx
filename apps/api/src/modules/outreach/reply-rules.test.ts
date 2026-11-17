// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "vitest";
import { autoSubject, autoSubmitted, optOutPhrase, ownWords } from "./domain/reply-rules";

const FOOTER = "--\nAcme Ltd\n1 Main St\nUnsubscribe: https://app.example.com/api/unsubscribe/w1/abc123";
const OUR_MAIL = `Hi Dana, a short note about Acme.\n\n${FOOTER}`;
const marked = OUR_MAIL.split("\n").map((l) => `> ${l}`).join("\n");

describe("what the sender wrote", () => {
  test("a marked quote and its header go, with our footer", () => {
    expect(ownWords(`Sounds great\n\nOn Mon, Nov 2, 2026 at 10:00 AM Sam <sam@acme.com> wrote:\n${marked}`)).toBe("Sounds great");
  });

  test("a header wrapped over two lines still counts", () => {
    expect(ownWords(`Sounds great\n\nOn Mon, Nov 2, 2026 at 10:00 AM Sam Smith <sam@acme.com>\nwrote:\n${marked}`)).toBe("Sounds great");
  });

  test("words under a marked quote are kept", () => {
    expect(ownWords(`On Mon, Nov 2, 2026 Sam wrote:\n${marked}\n\nPlease remove me`)).toBe("Please remove me");
  });

  test("a quote with no marks is cut whole", () => {
    expect(ownWords(`Sounds great\nOn Mon, Nov 2, 2026 Sam wrote:\n${OUR_MAIL}`)).toBe("Sounds great");
    expect(ownWords(`Sounds great\n\n-----Original Message-----\nFrom: Sam\n${OUR_MAIL}`)).toBe("Sounds great");
  });

  test("our footer without a link, pasted back unquoted, isn't the sender asking to stop", () => {
    const linkless = '--\nAcme Ltd\n1 Main St\nReply "stop" and I won\'t email you again.';
    expect(ownWords(`Sounds great\n\n${linkless}`)).toBe("Sounds great");
    expect(ownWords(`Sounds great\n\n${linkless.replace(/"/g, "\u201c").replace("won't", "won\u2019t")}`)).toBe("Sounds great");
    expect(optOutPhrase(ownWords(`Sounds great\n\n${linkless}`))).toBeNull();
    // Near miss: the sender's own "stop" is still theirs.
    expect(ownWords(`stop\n\n${linkless}`)).toBe("stop");
  });

  test("HTML flattened to one line loses the quote and the footer", () => {
    expect(ownWords(`Sounds great On Mon, Nov 2, 2026 Sam wrote: ${OUR_MAIL.replace(/\n/g, " ")}`)).toBe("Sounds great");
  });

  test("our footer pasted bare is cut, and a mobile signature goes", () => {
    expect(ownWords(`Sounds great\nSent from my iPhone\n${FOOTER}`)).toBe("Sounds great");
  });

  test("only a quote leaves nothing said", () => {
    expect(ownWords(`On Mon, Nov 2, 2026 Sam wrote:\n${marked}`)).toBe("");
  });

  test.each([
    ["fr", "Le lun. 2 nov. 2026, Sam <sam@acme.com> a écrit :"],
    ["de", "Am Mo., 2. Nov. 2026 um 10:00 Uhr schrieb Sam <sam@acme.com>:"],
    ["es", "El lun, 2 nov 2026 a las 10:00, Sam escribió:"],
    ["pt", "Em seg., 2 de nov. de 2026 às 10:00, Sam escreveu:"],
    ["zh", "Sam <sam@acme.com> 于2026年11月2日周一 10:00写道："],
    ["ja", "2026年11月2日(月) 10:00 Sam <sam@acme.com>:のメッセージ:"],
    ["ko", "2026년 11월 2일 (월) 오전 10:00, Sam님이 작성:"],
    ["pl", "pon., 2 lis 2026 o 10:00 Sam <sam@acme.com> napisał(a):"],
  ])("a friendly %s reply over our quoted footer says no opt-out", (_lang, line) => {
    const words = ownWords(`Friendly words\n\n${line}\n${marked}`);
    expect(words).toBe("Friendly words");
    expect(optOutPhrase(words)).toBeNull();
  });
});

describe("plainly asking to stop", () => {
  test.each([
    "Please remove me from your list",
    "UNSUBSCRIBE",
    "Stop emailing me.",
    "please take me off this",
    "Do not contact me again",
    "don’t email me",
    "Stop",
    "Stop!",
    "No thanks.",
    "Merci de me désinscrire",
    "Bitte abmelden",
    "Bitte nehmen Sie mich aus dem Verteiler",
    "Quiero darme de baja",
    "Por favor, quero descadastrar",
    "请退订",
    "請勿聯繫我",
    "配信停止をお願いします",
    "수신거부 합니다",
    "Proszę wypisz mnie",
    "Not interested, please remove me",
    "Not for me. Unsubscribe",
    "Never heard of you; stop emailing me",
  ])("%s", (reply) => {
    expect(optOutPhrase(reply)).not.toBeNull();
  });

  test.each([
    "Sounds great, let's talk",
    "Don't unsubscribe me, I like these",
    "Please don't remove me",
    "Could you remove the second paragraph?",
    "Stop by our booth at the show",
    "I will stop at your office on Monday",
    "No thanks needed!",
    "Nicht abmelden bitte",
    "No quiero darme de baja",
    "不要退订",
    "配信停止しないでください",
    "구독 취소하지 마세요",
    "Nie wypisanie, tylko pytanie",
    "resubscribe to the newsletter",
    "",
  ])("not: %s", (reply) => {
    expect(optOutPhrase(reply)).toBeNull();
  });
});

describe("automatic mail", () => {
  test("the header decides, and no means a person wrote it", () => {
    expect(autoSubmitted("auto-replied")).toBe(true);
    expect(autoSubmitted("no")).toBe(false);
    expect(autoSubmitted(" No ")).toBe(false);
    expect(autoSubmitted("")).toBe(false);
    expect(autoSubmitted(null)).toBe(false);
  });

  test("subjects in each language", () => {
    for (const s of ["Automatic reply: hello", "Abwesenheit: Hallo", "Réponse automatique", "自动回复", "자동 회신", "Odpowiedź automatyczna"]) expect(autoSubject(s)).toBe(true);
    expect(autoSubject("Re: your note")).toBe(false);
  });
});

test("leaving a meeting invite isn't leaving the list, but the list still is", () => {
  expect(optOutPhrase("Remove me from the meeting invite, I'll join the next one.")).toBeNull();
  expect(optOutPhrase("Please remove me from your calendar invite.")).toBeNull();
  expect(optOutPhrase("Remove me from your list.")).toBe("remove me");
  expect(optOutPhrase("Remove me from the meeting invite and remove me from your list.")).toBe("remove me");
  expect(optOutPhrase("Take me off the invite list.")).toBe("take me off");
});

test("the same holds in French, German, Portuguese and Polish", () => {
  expect(optOutPhrase("Retirez-moi de l'invitation à la réunion, je viendrai à la suivante.")).toBeNull();
  expect(optOutPhrase("Retirez-moi de votre liste.")).toBe("retirez-moi");
  expect(optOutPhrase("Entfernen Sie mich aus der Besprechungseinladung, ich komme zur nächsten.")).toBeNull();
  expect(optOutPhrase("Entfernen Sie mich von Ihrer Liste.")).toBe("entfernen sie mich");
  expect(optOutPhrase("Me removam do convite da reunião, vou na próxima.")).toBeNull();
  expect(optOutPhrase("Me remova da sua lista.")).toBe("me remova");
  expect(optOutPhrase("Usuńcie mnie z zaproszenia na spotkanie, będę na następnym.")).toBeNull();
  expect(optOutPhrase("Usuńcie mnie z listy.")).toBe("usuńcie mnie");
});

test("a negation a word or two before the phrase still counts in Chinese, and Polish 'please remove' alone is not a request", () => {
  expect(optOutPhrase("千万别给我退订，我挺喜欢你们的内容。")).toBeNull();
  expect(optOutPhrase("不要联系我，帮我退订。")).toBe("退订");
  expect(optOutPhrase("Proszę usunąć mojego kolegę Tomka, odszedł z firmy.")).toBeNull();
});
