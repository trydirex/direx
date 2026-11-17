// SPDX-License-Identifier: AGPL-3.0-only
// The words of an opt-out and of a quoted-mail header, per language. A phrase only ever says yes:
// anything not caught here goes on to the model or a person, so a phrase that could mean something
// else is left out. The non-English lists need a fluent speaker's review before they count as tested.
//
// The English list and the bare replies are adapted from Harvey's OPT_OUT_PATTERNS and BARE_OPT_OUTS
// (github.com/ethanplusai/harvey, MIT, Copyright (c) 2026 Ethan Rogers; its notice is in
// THIRD_PARTY_NOTICES.md). They were taken before 2026-11-03, while Harvey was MIT. It is AGPL from
// 0.4.0, so nothing newer may be copied from it.

export type ReplyLanguage = {
  code: string;
  /** Found anywhere in what the sender wrote. */
  phrases: string[];
  /** Counts only as the whole reply. */
  bare: string[];
  /** Tested on the text just before a phrase: a negation here means it isn't a request. */
  notBefore?: RegExp;
  /** The same for just after a phrase, for languages that negate at the end. */
  notAfter?: RegExp;
  /** The line a mail client writes above quoted mail. */
  quoteHeader: RegExp;
  /** Subjects an out-of-office reply uses. */
  autoSubjects: string[];
};

// The negation must reach the phrase: "not interested, please remove me" still asks to stop.
const words = (negations: string) => new RegExp(`(?<!\\p{L})(?:${negations})(?:\\s+[^\\s,.;:!?，。；！？]+){0,3}\\s*$`, "u");
const header = (start: string, end: string) => new RegExp(`${start}[^\\n]{0,200}(?:\\n[^\\n]{0,100})?${end}`, "iu");

export const REPLY_LANGUAGES: readonly ReplyLanguage[] = [
  {
    code: "en",
    phrases: ["unsubscribe", "opt out", "opt-out", "remove me", "take me off", "stop emailing", "stop contacting", "stop sending", "do not contact", "do not email", "don't contact", "don't email", "never contact", "delete my info", "delete my data", "no more emails"],
    bare: ["stop", "remove", "no thanks", "no thank you"],
    notBefore: words("don't|do not|not|never|won't|wouldn't"),
    // "Remove me from the meeting invite" asks about a meeting, not the list.
    notAfter: /^ from (?:the |this |that |your )?(?:meeting|calendar|invite)\b/u,
    quoteHeader: header("(?<!\\p{L})On\\s", "\\swrote:"),
    autoSubjects: ["out of office", "automatic reply", "auto-reply", "autoreply", "away from the office"],
  },
  {
    code: "fr",
    phrases: ["désabonner", "désabonnement", "désinscrire", "désinscription", "retirez-moi", "supprimez-moi", "enlevez-moi", "ne me contactez plus", "arrêtez de m'envoyer", "ne plus recevoir", "supprimez mes données"],
    bare: ["stop"],
    notBefore: words("ne pas|pas|jamais"),
    // "Retirez-moi de l'invitation à la réunion" asks about a meeting, not the list.
    notAfter: /^ d(?:e|u) (?:la |l'|cette |votre |ma )?(?:réunion|invitation|visio|agenda|calendrier)/u,
    quoteHeader: header("(?<!\\p{L})Le\\s", "\\sa\\s+écrit\\s?:"),
    autoSubjects: ["réponse automatique", "absence du bureau", "absent du bureau"],
  },
  {
    code: "de",
    phrases: ["abmelden", "abbestellen", "mich austragen", "tragen sie mich", "entfernen sie mich", "nehmen sie mich aus", "kontaktieren sie mich nicht mehr", "schreiben sie mir nicht mehr", "keine e-mails mehr", "keine weiteren e-mails", "löschen sie meine daten"],
    bare: ["stop", "stopp"],
    notBefore: words("nicht|nie"),
    // "Entfernen Sie mich aus der Besprechungseinladung" asks about a meeting, not the list.
    notAfter: /^ (?:aus |von )?(?:der |dem |diesem |dieser |ihrer |ihrem )?[\p{L}-]*(?:einladung|besprechung|termin|meeting|kalender)(?!\p{L})/u,
    quoteHeader: header("(?<!\\p{L})Am\\s", "\\sschrieb[^\\n]{0,100}:"),
    autoSubjects: ["abwesenheit", "automatische antwort", "außer haus"],
  },
  {
    code: "es",
    phrases: ["darme de baja", "dame de baja", "denme de baja", "dar de baja", "elimíname", "eliminarme", "quítenme", "no me contacten", "no me contactes", "dejen de enviar", "deja de enviar", "no quiero recibir", "borren mis datos"],
    bare: ["baja", "stop"],
    notBefore: words("no|nunca"),
    quoteHeader: header("(?<!\\p{L})El\\s", "\\sescribió:"),
    autoSubjects: ["respuesta automática", "fuera de la oficina"],
  },
  {
    code: "pt",
    phrases: ["descadastrar", "descadastre", "cancelar inscrição", "cancelar subscrição", "remova-me", "remover-me", "me remova", "me tire da", "pare de enviar", "parem de enviar", "não me contate", "não entre em contato", "não quero receber", "não me envie"],
    bare: ["sair", "stop"],
    notBefore: words("não|nunca"),
    // "Me removam do convite da reunião" asks about a meeting, not the list. "me remova" also matches
    // the plural "me removam", so the rest may start with its last letter.
    notAfter: /^m? d[oa] (?:convite|reunião|evento|agenda|calendário)/u,
    quoteHeader: header("(?<!\\p{L})Em\\s", "\\sescreveu:"),
    autoSubjects: ["resposta automática", "fora do escritório"],
  },
  {
    code: "zh",
    phrases: ["退订", "退訂", "取消订阅", "取消訂閱", "别再发", "別再發", "不要再发", "不要再發", "请勿联系", "請勿聯繫", "不要联系我", "不要聯繫我", "移除我", "删除我的", "刪除我的"],
    bare: ["td"],
    // "千万别给我退订": the negation can come before "for me" rather than right before the phrase.
    notBefore: /(?:不要|不用|无需|無需|别|別)(?:给我|給我|帮我|幫我)?$/u,
    quoteHeader: header("(?:^|\\n)", "(?:写道|寫道)[:：]"),
    autoSubjects: ["自动回复", "自動回覆", "不在办公室", "不在辦公室"],
  },
  {
    code: "ja",
    phrases: ["配信停止", "配信解除", "購読解除", "登録解除", "連絡しないで", "送らないで", "送信しないで", "メール不要"],
    bare: ["停止"],
    notAfter: /^(?:しないで|しなくて|は不要|はしない)/u,
    quoteHeader: header("(?:^|\\n)", "(?:は書きました|のメッセージ)[:：]"),
    autoSubjects: ["自動応答", "自動返信", "不在通知"],
  },
  {
    code: "ko",
    phrases: ["수신거부", "수신 거부", "구독취소", "구독 취소", "연락하지 마", "보내지 마", "그만 보내", "명단에서 제외"],
    bare: ["그만"],
    notAfter: /^(?:하지|는 하지)/u,
    quoteHeader: header("(?:^|\\n)", "님이 작성:"),
    autoSubjects: ["자동 회신", "자동회신", "부재중"],
  },
  {
    code: "pl",
    // Not "proszę usunąć" alone: it is "please remove" anything, such as a colleague or an attachment.
    phrases: ["wypisz mnie", "wypisać", "wypisanie", "usuńcie mnie", "usuń mnie", "nie kontaktujcie się", "nie wysyłajcie", "przestańcie wysyłać", "rezygnuję z subskrypcji", "nie życzę sobie"],
    bare: ["stop", "wypisz"],
    notBefore: words("nie|nigdy"),
    // "Usuńcie mnie z zaproszenia na spotkanie" asks about a meeting, not the list.
    notAfter: /^ z (?:zaproszenia|spotkania|kalendarza)/u,
    quoteHeader: header("(?:^|\\n)", "(?:napisał|napisała|napisał\\(a\\)|pisze):"),
    autoSubjects: ["odpowiedź automatyczna", "poza biurem"],
  },
];

/** Quoted mail with no ">" marks under these: all that follows is someone else's text. */
export const ORIGINAL_MESSAGE = /-{2,}\s*(?:original message|forwarded message|message d'origine|ursprüngliche nachricht|mensaje original|mensagem original|原始邮件|原始郵件|元のメッセージ|원본 메시지|oryginalna wiadomość)\s*-{2,}/iu;
