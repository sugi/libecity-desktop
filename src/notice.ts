import { classifyUrl, SITE_ORIGIN } from "./url-policy";

// A notice document from users/{uid}/notices. Documents written years apart
// carry different field sets, so everything past the type is optional.
export type NoticeTimestamp = { toDate: () => Date };

export type Notice = {
  documentId: string;
  type: string;
  created_at?: NoticeTimestamp;
  room_id?: string;
  room_name?: string;
  message_id?: string;
  message?: string;
  user_name?: string;
  user_id?: string;
  from_user_id?: string;
  to_all_from_user_id?: string;
  follower_uid?: string;
  count?: number;
  original_title?: string;
  other_url?: string;
  other_link_title?: string;
  other_live_name?: string;
  event_id?: string;
  event_host_id?: string;
  tweet_id?: string;
  reply_tweet_id?: string;
  parent_tweet_path?: string;
  point_amount?: number;
  point_key?: string;
  point_expire_at_time?: NoticeTimestamp;
  fiveforce_id?: string;
};

export function noticeDate(n: Notice): Date | undefined {
  try {
    return n.created_at?.toDate();
  } catch {
    return undefined;
  }
}

const tweetId = (path?: string) => (path ?? "").replace("tweets/", "");

// Ported from the site's own Notice.url getter - see
// docs/reference/libecity-notice-model.js. Unknown types return undefined
// rather than throwing, so a type added on the server cannot break the
// listener.
function noticePath(n: Notice): string | undefined {
  const room = n.room_id ?? "";
  switch (n.type) {
    case "mention":
    case "reaction":
    case "to_all":
    case "dm_mention":
    case "official_dm_mention":
      return `/room_list?room_id=${room}&comment_id=${n.message_id ?? ""}`;
    case "usercommunity":
    case "usercommunity_approved":
    case "usercommunity_admin":
    case "usercommunity_delete_warning":
    case "usercommunity_delete_completed":
    case "dm":
    case "official_dm":
    case "meet_up_room":
    case "meet_up_capacity_reached":
      return `/room_list?room_id=${room}`;
    case "unicorn":
    case "unicorn_alert":
      return "/mypage/top";
    case "followed":
      return `/user_profile/${n.follower_uid ?? ""}`;
    case "event_calendar":
    case "event_calendar_remind":
      return n.event_id && n.event_host_id
        ? `/mypage/event_calendar?event=${n.event_host_id}-${n.event_id}`
        : "/mypage/event_calendar";
    case "reaction_tweet":
      return n.tweet_id
        ? `/tweet/my?reaction_tweet_id=${n.tweet_id}`
        : `/tweet/my?reaction_reply_tweet_id=${n.reply_tweet_id ?? ""}`;
    case "reply_tweet":
      return `/tweet/my?reply_tweet_id=${tweetId(n.parent_tweet_path)}`;
    case "reply_tweet_reply":
      return (
        `/tweet/my?reply_tweet_reply_parent_id=${tweetId(n.parent_tweet_path)}` +
        `&reply_tweet_id=${n.reply_tweet_id ?? ""}`
      );
    case "quote_tweet":
      return `/tweet/all?tweet_id=${n.tweet_id ?? ""}`;
    case "payment_failure":
      return "/mypage/member_credit";
    case "point_receive":
    case "point_receive_anonymous":
    case "point_receive_ms":
    case "point_near_expiry":
    case "point_expired":
    case "point_admin_cancel":
      return "/mypage/points";
    case "point_reaction":
      return n.point_key
        ? `/mypage/point_histories?point_key=${n.point_key}`
        : "/mypage/point_histories";
    case "point_exchange_failed":
    case "point_exchange_failed_account_name_incorrect":
      return "/mypage/payment_accounts";
    case "fiveforce_recommend":
      return "/mypage/fiveforces";
    case "fiveforce_new_content":
      return n.fiveforce_id
        ? `/mypage/fiveforces?id=${n.fiveforce_id}`
        : "/mypage/fiveforces";
    case "money_quiz_monthly_remind":
    case "money_quiz_everyday_remind":
      return "/mypage/fiveforces?is_open_money_quiz=true";
    default:
      // Live, micro-service and recruit notices all carry their own link, and
      // it is frequently off-site.
      return n.other_url || undefined;
  }
}

export function noticeUrl(n: Notice): string | undefined {
  const path = noticePath(n);
  if (!path) return undefined;
  if (classifyUrl(path) !== "reject") return path;
  // Rejected. A relative path (from every switch branch above) never parses
  // as a URL at all, so it's still safe to root under our own site. Anything
  // that *does* parse - an other_url carrying a scheme the policy disallows,
  // e.g. javascript: - must not be stitched onto https://libecity.com.
  try {
    new URL(path);
    return undefined;
  } catch {
    return `${SITE_ORIGIN}${path}`;
  }
}

// noticeTypeCategoryMap from the site bundle, inverted. The categories are the
// same ones city.notice.getCategories reports.
const CATEGORY_OF_TYPE: Record<string, string> = {};
const TYPES_BY_CATEGORY: Record<string, string[]> = {
  message: ["reaction", "mention", "to_all"],
  tweet: ["reaction_tweet", "reply_tweet", "reply_tweet_reply", "quote_tweet"],
  official_dm: ["official_dm", "official_dm_mention"],
  dm: ["dm_mention", "dm"],
  follow: ["followed"],
  usercommunity: [
    "usercommunity",
    "usercommunity_approved",
    "usercommunity_admin",
    "usercommunity_delete_warning",
    "usercommunity_delete_completed",
    "meet_up_capacity_reached",
  ],
  event: ["event_calendar", "event_calendar_remind", "meet_up_room"],
  live: [
    "youtube_live",
    "creators_live",
    "beginners_live",
    "other_live",
    "school_lecture_live",
    "school_camp_live",
    "school_elementary_live",
    "school_junior_live",
    "school_high_live",
    "school_university_live",
    "school_adult_live",
    "school_lower_elementary_live",
    "school_middle_elementary_live",
    "school_upper_elementary_live",
    "classmate_room_event",
  ],
  point: [
    "point_receive",
    "point_receive_anonymous",
    "point_expired",
    "point_exchange_failed",
    "point_exchange_failed_account_name_incorrect",
    "point_near_expiry",
    "point_reaction",
    "point_receive_ms",
    "point_admin_cancel",
  ],
  micro_service: [
    "skill",
    "works",
    "space",
    "meets",
    "farmers",
    "furima",
    "map",
    "ichiba",
    "library",
    "job",
    "virtual_office",
  ],
  recruit: ["recruit"],
  other: [
    "payment_failure",
    "unicorn",
    "unicorn_alert",
    "fiveforce_recommend",
    "fiveforce_new_content",
    "money_quiz_monthly_remind",
    "money_quiz_everyday_remind",
  ],
};
for (const [category, types] of Object.entries(TYPES_BY_CATEGORY)) {
  for (const type of types) CATEGORY_OF_TYPE[type] = category;
}

export function noticeCategory(type: string): string | undefined {
  return CATEGORY_OF_TYPE[type];
}

// One delivery can carry a burst. Show the newest, oldest first, and say how
// many were left out rather than firing a dozen toasts.
export function capNotices(
  notices: Notice[],
  cap = 5
): { fire: Notice[]; collapsed: number } {
  const sorted = [...notices].sort(
    (a, b) => (noticeDate(a)?.getTime() ?? 0) - (noticeDate(b)?.getTime() ?? 0)
  );
  if (sorted.length <= cap) return { fire: sorted, collapsed: 0 };
  return { fire: sorted.slice(sorted.length - cap), collapsed: sorted.length - cap };
}
