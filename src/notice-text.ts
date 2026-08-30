import { noticeCategory, noticeDate, type Notice } from "./notice";

// Category labels, as the bell shows them - except recruit and other, this
// project's own coinages, because the site's bundle had no findable label
// for either.
export const TYPE_LABELS: Record<string, string> = {
  message: "メッセージ",
  tweet: "つぶやき",
  official_dm: "運営DM",
  dm: "DM",
  follow: "フォロー",
  usercommunity: "コミュニティ",
  event: "イベント",
  live: "ライブ",
  point: "ポイント",
  micro_service: "サービス",
  recruit: "募集",
  other: "お知らせ",
};

const decodeHtmlEntities = (s: string) =>
  s
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const compressRuledLines = (s: string) => s.replace(/━{2,}/g, "━");

// The stored message is chat HTML. Strip the quote blocks, the membership
// badges and the markup, then squeeze the whitespace.
const convertToNoticePreview = (s: string): string => {
  if (!s) return "";
  return s
    .replace(/<div[^>]*><ul[^>]*class="[^"]*\bto_all\b[^"]*"[\s\S]*?<\/ul><\/div>/g, "")
    .replace(/<div[^>]*><ul[^>]*class="[^"]*\bto_userinfo\b[^"]*"[\s\S]*?<\/ul><\/div>/g, "")
    .replace(
      /(\(👨‍🎓新入生会員\)|\(🐧ペンギン会員\)|\(🐬イルカ会員\)|\(🐼パンダ会員\)|\(🐯トラ会員\))/g,
      ""
    )
    .replace(/(&nbsp;Re<span class="badge">返信元<\/span>)/g, "[Re] ")
    .replace(/(data-content="[^"]+")/g, " ")
    .replace(/(<\/?[^>]+>)|([^<]+)/g, (m, tag, text) => (tag ? " " : text || m))
    .replace(/(&nbsp;)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// The site counts a character as two "bytes" when escape() would widen it,
// which is exactly the >255 code points.
const truncateByBytes = (s: string, limit: number, suffix = "") => {
  let width = 0;
  let out = "";
  for (const ch of s.split("")) {
    width += ch.charCodeAt(0) < 256 ? 1 : 2;
    if (width > limit) return out + suffix;
    out += ch;
  }
  return s;
};

const messagePreview = (s: string, limit = 108) =>
  truncateByBytes(convertToNoticePreview(s), limit, "...");

const two = (n: number) => String(n).padStart(2, "0");
const monthDay = (d: Date) => `${two(d.getMonth() + 1)}/${two(d.getDate())}`;
const kanjiDate = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
const kanjiDatePadded = (d: Date) =>
  `${d.getFullYear()}年${two(d.getMonth() + 1)}月${two(d.getDate())}日`;

const communityDeleteDate = (d: Date) => {
  const then = new Date(d.getTime());
  then.setDate(then.getDate() + 30);
  return kanjiDatePadded(then);
};

// room and user are never populated on documents read straight from Firestore,
// so the room name is whatever the flat field carries.
const roomName = (n: Notice) => n.room_name || "-";

const dated = (n: Notice, fallback: string, fmt: (d: Date) => string) => {
  const d = noticeDate(n);
  return d ? fmt(d) : fallback;
};

const expiry = (n: Notice) => {
  let d: Date | undefined;
  try {
    d = n.point_expire_at_time?.toDate();
  } catch {
    d = undefined;
  }
  return d ? kanjiDate(d) : "";
};

// Ported from the site's Notice.title getter. Where it throws for an unknown
// type, this falls back to the notice's own message, or - if it has none -
// to "新しいお知らせがあります", also our own coinage, not the site's,
// because the daemon must not die over a new one.
export function noticeTitle(n: Notice): string {
  if (n.original_title) return n.original_title;
  const who = n.user_name ?? "";
  switch (n.type) {
    case "mention":
    case "dm_mention":
    case "official_dm_mention":
      return `${who}さんからメッセージが届いています！`;
    case "to_all":
      return `${who}さんから全体宛てメッセージが届いています！`;
    case "reaction":
      return `本日、メッセージにリアクションがありました（合計${n.count ?? 0}件）`;
    case "reaction_tweet":
      return `本日、つぶやきにリアクションがありました（合計${n.count ?? 0}件）`;
    case "usercommunity":
      return `-への参加申請が${n.count ?? 0}件届いています！`;
    case "usercommunity_approved":
      return "-への参加申請が承認されました。";
    case "usercommunity_admin":
      return "-の管理者に設定されました。";
    case "usercommunity_delete_warning":
      return `【削除予告】${roomName(n)}は、${dated(n, "-", communityDeleteDate)}までに新規投稿がないと自動で削除されます`;
    case "usercommunity_delete_completed":
      return `【削除完了】${n.room_name || "-"}の自動削除が完了しました`;
    case "dm":
    case "official_dm":
      return `${who}さんからDM申請が届いています！`;
    case "unicorn":
    case "unicorn_alert":
    case "skill":
    case "works":
    case "space":
    case "meets":
    case "farmers":
    case "furima":
    case "map":
    case "library":
    case "event_calendar":
    case "event_calendar_remind":
      return n.message ?? "";
    case "youtube_live":
      return `【${dated(n, "--/--", monthDay)}】🦁 学長ライブが始まりました！`;
    case "creators_live":
      return `【${dated(n, "--/--", monthDay)}】クリエイターズライブが始まりました！`;
    case "beginners_live":
      return `【${dated(n, "--/--", monthDay)}】リベシティ使い方ライブが始まりました！`;
    case "other_live":
      return `【${dated(n, "--/--", monthDay)}】${n.other_live_name ?? ""}`;
    case "followed":
      return `${who}さんからフォローされました！`;
    case "meet_up_room":
      return "-さんが[-]のイベントを登録しました！";
    case "meet_up_capacity_reached":
      return "【受付終了】-は、定員に達したため受付終了しました";
    case "reply_tweet":
      return `あなたのつぶやきに${who}さんから返信がありました。`;
    case "reply_tweet_reply":
      return `あなたが返信したつぶやきに${who}さんから返信がありました。`;
    case "quote_tweet":
      return `${who}さんがあなたのつぶやきを引用しました！`;
    case "payment_failure":
      return "応援会員の更新に失敗しました";
    case "point_receive":
      return `${who === "リベシティ" ? who : `${who}さん`}から${(n.point_amount ?? 0).toLocaleString()}pt届きました🎁`;
    case "point_receive_anonymous":
      return `匿名で${(n.point_amount ?? 0).toLocaleString()}pt届きました🎁`;
    case "point_near_expiry":
      return "保有ポイントの有効期限が近づいています";
    case "point_expired":
      return "保有ポイントの有効期限が切れました";
    case "point_admin_cancel":
      return "ポイント付与を取り消しました";
    case "point_exchange_failed":
      return `【換金失敗】口座情報に誤りがあったため、ポイントを返却しました（有効期限：${expiry(n)}）`;
    case "point_exchange_failed_account_name_incorrect":
      return `【換金失敗】口座名義に誤りがあったため、ポイントを返却しました（有効期限：${expiry(n)}）`;
    case "point_reaction":
      return `${who}さんへ贈ったポイントに、ありがとう！が届きました`;
    case "job":
      return "リベシティジョブサーチからお知らせが届きました";
    case "ichiba":
      return "リベシティ市場からお知らせが届きました";
    case "fiveforce_recommend":
      return "宿題リスト、まだやってないんちゃう？今日が一番若い日！今すぐ始めてみよか^^";
    case "fiveforce_new_content":
      return "宿題リストに新しい宿題が追加されました！";
    case "money_quiz_monthly_remind":
      return "正解するとリベポイントGET！お金の知識が身につく4択クイズに回答してみましょう💡";
    case "money_quiz_everyday_remind":
      return "今日のクイズ、もう挑戦しましたか？";
    case "school_elementary_live":
    case "school_junior_live":
    case "school_high_live":
    case "school_university_live":
    case "school_adult_live":
      return "オンラインスクールが始まりました！";
    case "classmate_room_event":
      return "同期チャットのメンバー交流会が始まりました！";
    case "recruit":
      return n.message ?? "";
    default:
      return n.message || "新しいお知らせがあります";
  }
}

// Ported from Notice.appNoticeBody: the message types get the sender and a
// preview of what they actually said, everything else reuses the title.
export function noticeBody(n: Notice): string {
  if (n.original_title) return compressRuledLines(n.original_title);
  switch (n.type) {
    case "mention":
    case "dm_mention":
    case "official_dm_mention":
    case "to_all": {
      const who = compressRuledLines(n.user_name ?? "");
      const preview = decodeHtmlEntities(
        messagePreview(compressRuledLines(n.message ?? ""), 50)
      );
      if (preview) return `${who}さん：${preview}`;
      return n.type === "to_all"
        ? `${who}さんから全体宛てメッセージが届いています！`
        : `${who}さんからメッセージが届いています！`;
    }
    default:
      return compressRuledLines(noticeTitle(n));
  }
}

export function notificationTitle(n: Notice): string {
  const category = noticeCategory(n.type);
  const label = category ? TYPE_LABELS[category] : undefined;
  return label ? `リベシティ - ${label}` : "リベシティ";
}
