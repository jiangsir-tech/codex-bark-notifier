import { basename } from "node:path";

export const TASK_NAME_CHARACTER_LIMIT = 16;
export const CONVERSATION_NAME_CHARACTER_LIMIT = 30;
export const ANSWER_SUMMARY_CHARACTER_LIMIT = 46;

const BIDI_CONTROL_PATTERN = /\p{Bidi_Control}+/gu;
const REMOTE_URL_PATTERN =
  /\b(?!(?:file|vscode|smb|afp):)[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`,;，。！？；、]+/giu;
const HIGH_SIGNAL_LOCAL_PATH_PATTERNS = [
  /\b(?:file|vscode|smb|afp):/iu,
  /(?:^|[^\p{L}\p{N}_/.])[A-Za-z]:[\\/]/u,
  /(?:^|[^\p{L}\p{N}_.\/\\])\\\\/u,
  /(?:^|[^\p{L}\p{N}_/.])\/\/[^/\s]+[\\/]/u,
  /(?:^|[^\p{L}\p{N}_/.])(?:~(?:[A-Za-z0-9._-]+)?|\$HOME|\$\{HOME\}|%USERPROFILE%)[\\/]/iu,
  /(?:^|[^\p{L}\p{N}_./])\/(?:Users|home|private|var|tmp|Volumes|opt|etc|usr|Applications|Library|System|mnt|srv|run|data|work|workspace|root)(?:[\\/]|$)/iu,
  /(?:^|[^\p{L}\p{N}_.\\/])\\(?:Users|home|private|var|tmp|Volumes|data|work|workspace|root)(?:[\\/]|$)/iu,
  /%(?:25){0,2}(?:2f|5c)(?:Users|home|private|var|tmp|Volumes|data|work|workspace|root)(?:[\\/]|%(?:25){0,2}(?:2f|5c)|$)/iu,
];
const DELIMITED_POSIX_PATH_PATTERN =
  /(?:^|[^\p{L}\p{N}_/.])\/+(?=[^\s/])/u;

function stripBidiControls(value) {
  return String(value ?? "").replace(BIDI_CONTROL_PATTERN, "");
}

function decodeForPathDetection(value) {
  let candidate = String(value ?? "");
  for (let round = 0; round < 3; round += 1) {
    const decoded = candidate.replace(
      /%([0-9a-f]{2})/giu,
      (_match, hexadecimal) =>
        String.fromCharCode(Number.parseInt(hexadecimal, 16)),
    );
    if (decoded === candidate) {
      break;
    }
    candidate = decoded;
  }
  return candidate;
}

function containsHighSignalLocalPath(value) {
  const candidate = String(value ?? "");
  const decodedCandidate = decodeForPathDetection(candidate);
  return HIGH_SIGNAL_LOCAL_PATH_PATTERNS.some(
    (pattern) =>
      pattern.test(candidate) ||
      (decodedCandidate !== candidate && pattern.test(decodedCandidate)),
  );
}

function containsDelimitedPosixPath(value) {
  const candidate = String(value ?? "");
  const decodedCandidate = decodeForPathDetection(candidate);
  return (
    DELIMITED_POSIX_PATH_PATTERN.test(candidate) ||
    (decodedCandidate !== candidate &&
      DELIMITED_POSIX_PATH_PATTERN.test(decodedCandidate))
  );
}

function unmatchedClosingDelimiterIndex(value) {
  const expectedClosers = [];
  const closerFor = { "(": ")", "[": "]", "{": "}" };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (closerFor[character]) {
      expectedClosers.push(closerFor[character]);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (expectedClosers.at(-1) !== character) {
        return index;
      }
      expectedClosers.pop();
    }
  }
  return value.length;
}

function parametersContainLocalPath(parameters) {
  for (const [name, value] of parameters) {
    if (
      /(?:file|path|dir|directory|cwd|root|target)/iu.test(name) &&
      (containsHighSignalLocalPath(value) ||
        containsDelimitedPosixPath(value))
    ) {
      return true;
    }
  }
  return false;
}

function remoteUrlContainsLocalPath(url) {
  if (parametersContainLocalPath(url.searchParams)) {
    return true;
  }

  const hashParameters = new URLSearchParams(
    url.hash.replace(/^#\??/u, ""),
  );
  return parametersContainLocalPath(hashParameters);
}

function containsAbsoluteLocalPath(value) {
  let remoteUrlHasLocalPath = false;
  const withoutSafeRemoteUrls = String(value ?? "").replace(
    REMOTE_URL_PATTERN,
    (urlText) => {
      const urlEnd = unmatchedClosingDelimiterIndex(urlText);
      const urlCandidate = urlText.slice(0, urlEnd);
      const trailingText = urlText.slice(urlEnd);
      try {
        const url = new URL(urlCandidate);
        if (remoteUrlContainsLocalPath(url)) {
          remoteUrlHasLocalPath = true;
        }
        return ` ${trailingText}`;
      } catch {
        return urlText;
      }
    },
  );

  return (
    remoteUrlHasLocalPath ||
    containsHighSignalLocalPath(withoutSafeRemoteUrls) ||
    containsDelimitedPosixPath(withoutSafeRemoteUrls)
  );
}

function safeBasename(cwd, fallback) {
  const candidate = stripBidiControls(basename(cwd || "")).trim();
  return candidate && !containsAbsoluteLocalPath(candidate)
    ? candidate
    : fallback;
}

export function sanitizeNotificationText(rawText, fallback = "") {
  const candidate = stripBidiControls(rawText);
  if (!containsAbsoluteLocalPath(candidate)) {
    return candidate;
  }
  const safeFallback = stripBidiControls(fallback);
  return containsAbsoluteLocalPath(safeFallback) ? "" : safeFallback;
}

export function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

export function payloadIds(payload) {
  return {
    threadId: String(
      payload?.["thread-id"] ??
        payload?.thread_id ??
        payload?.session_id ??
        "",
    ),
    turnId: String(payload?.["turn-id"] ?? payload?.turn_id ?? ""),
  };
}

export function truncateText(rawText, characterLimit, fallback) {
  const safeFallback = stripBidiControls(fallback);
  const candidate =
    stripBidiControls(rawText)
      .replace(/\s+/gu, " ")
      .trim() || safeFallback;
  const characters = Array.from(candidate);
  return characters.length > characterLimit
    ? `${characters.slice(0, characterLimit).join("")}…`
    : candidate;
}

export function shortenConversationName(rawText, cwd = "") {
  const fallback = safeBasename(cwd, "未命名对话");
  const cleanedText = stripBidiControls(rawText)
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<image\b[\s\S]*?<\/image>/giu, " ")
    .replace(
      /#{1,6}\s*Files mentioned by the user\s*:[\s\S]*?#{1,6}\s*My request for Codex\s*:/giu,
      " ",
    )
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/giu, " ");

  const lines = cleanedText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/u.test(line))
    .filter((line) => !containsAbsoluteLocalPath(line))
    .filter((line) => !/^\/\S+/u.test(line))
    .filter((line) => !/:\s*(?:\/\S+|[A-Za-z]:\\)/u.test(line))
    .filter(
      (line) =>
        !/^(?:#\s*)?(?:Files mentioned|environment_context|INSTRUCTIONS|AGENTS\.md instructions)\b/iu.test(
          line,
        ),
    )
    .filter((line) => !/^(?:##?\s*)?(?:My request for Codex)\s*:?\s*$/iu.test(line));

  let candidate =
    lines.find((line) => /[\p{Script=Han}A-Za-z0-9]/u.test(line)) ??
    fallback;

  candidate = candidate
    .replace(/^[-*#>\d.、)\s]+/u, "")
    .replace(/^(?:(?:请你?|麻烦你?|你帮我|帮我|我想要)\s*)+/u, "")
    .split(/[。！？?!：:]/u)[0]
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!candidate) {
    candidate = fallback;
  }

  return truncateText(
    candidate,
    CONVERSATION_NAME_CHARACTER_LIMIT,
    fallback,
  );
}

function redactSensitiveSummaryValues(value) {
  return String(value ?? "")
    .replace(
      /((?:api[-_ ]?key|device[-_ ]?key|access[-_ ]?token|authorization|bearer|token|secret|password|passcode|密钥|令牌|密码|验证码)\s*[:=：]\s*)([^\s,，;；]+)/giu,
      "$1[已隐藏]",
    )
    .replace(/\b[A-Za-z0-9_-]{28,}\b/gu, "[已隐藏]");
}

const GENERIC_SUMMARY_PATTERN =
  /^(?:(?:已|已经)?(?:完成|处理|修复|优化|更新)(?:了|完成|好了)?|(?:已|已经)?帮你(?:操作|处理|修复|优化|更新)?(?:完成|好了)|(?:已|已经)按(?:你的)?(?:方案|建议)(?:处理|操作|修复|优化|修改|更新)?(?:完成|好了)|我(?:赞成|同意)|赞成|同意|是的|对的|没错|确实|不客气|可以|没问题|明白了?|理解(?:了)?|收到|好哒?|你说得对|你抓到(?:重点|关键)(?:了)?)[，,。.!！:：；;]*$/u;
const SUMMARY_INTRODUCTION_PATTERN =
  /^(?:以下|下面|具体|详情|结果|最终结果|主要(?:结果|改动|变化|内容)|操作步骤|处理过程|现在(?:的)?(?:通知)?逻辑)(?:是|如下)?[，,。.!！:：；;]*$|^(?:(?:更)?(?:严谨|准确|具体|简单|直白|通俗)地说|换句话说|总的来说|简而言之)[，,。.!！:：；;]*$/u;
const SUMMARY_LABEL_PATTERN =
  /^(?:简要结论|结论|验证结果|处理结果|最终结果|结果|当前状态)\s*[：:]\s*/u;
const SUMMARY_HISTORICAL_CONTEXT_PATTERN =
  /^(?:此前|之前|先前|起初|最初|一开始|earlier\b|previously\b)/iu;
const SUMMARY_REQUEST_RESTATEMENT_PATTERN =
  /^(?:你(?:想要|希望|关心|询问)(?:的是)?|你的(?:意思|目标|需求|问题)(?:是)?)[：:]/u;
const SUMMARY_STRUCTURE_PATTERN =
  /^(?:结论|结果|说明)(?:分(?:为)?|有)?(?:[一二两三四五六七八九十\d]+)?(?:层|点|部分|方面)[，,。.!！:：；;]*$/u;
const SUMMARY_TRANSITION_PREFIX_PATTERN =
  /^(?:(?:更)?(?:严谨|准确|具体|简单|直白|通俗)地说|换句话说|总的来说|简而言之)[，,。.!！:：；;\s]*/u;
const SUMMARY_SUCCESS_PREFIX_PATTERN =
  /^(?:很好[，,]\s*)?(?:验证|测试)(?:已经|已)?成功[：:，,\s]*/u;

function summarySegments(value) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .flatMap(
      (line) =>
        line.match(/[^。！？!?；;]+(?:[。！？!?；;]+|$)/gu) ?? [],
    );
}

function answerSummarySegments(value) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .flatMap(
      (line) => line.match(/[^。！？!?]+(?:[。！？!?]+|$)/gu) ?? [],
    );
}

function stripListMarker(value) {
  return String(value ?? "").replace(
    /^(?:[-*+>•]\s*|\d+[)、]\s*|\d+\.(?!\d)\s*)/u,
    "",
  );
}

function truncateSummaryText(rawText, fallback) {
  const safeFallback = stripBidiControls(fallback);
  const candidate =
    stripBidiControls(rawText)
      .replace(/\s+/gu, " ")
      .trim() || safeFallback;
  const characters = Array.from(candidate);
  if (characters.length <= ANSWER_SUMMARY_CHARACTER_LIMIT) {
    return candidate.replace(/[，,；;：:]+$/u, "。");
  }

  const visiblePrefix = characters
    .slice(0, ANSWER_SUMMARY_CHARACTER_LIMIT)
    .join("");
  const minimumBoundary = Math.ceil(ANSWER_SUMMARY_CHARACTER_LIMIT * 0.55);
  let boundary = -1;
  for (const punctuation of ["。", "！", "？", "；", ";", "，", ","]) {
    const index = visiblePrefix.lastIndexOf(punctuation);
    if (index >= minimumBoundary) {
      boundary = Math.max(boundary, index);
    }
  }

  if (boundary >= minimumBoundary) {
    return visiblePrefix
      .slice(0, boundary + 1)
      .replace(/[，,；;：:]+$/u, "。");
  }

  const latinWordCharacterPattern =
    /[\p{Script=Latin}\p{M}\p{N}._+\-'’]/u;
  const limit = ANSWER_SUMMARY_CHARACTER_LIMIT;
  if (
    latinWordCharacterPattern.test(characters[limit - 1] ?? "") &&
    latinWordCharacterPattern.test(characters[limit] ?? "")
  ) {
    let wordBoundary = limit;
    while (
      wordBoundary > 0 &&
      latinWordCharacterPattern.test(characters[wordBoundary - 1])
    ) {
      wordBoundary -= 1;
    }
    const wordSafePrefix = characters
      .slice(0, wordBoundary)
      .join("")
      .trimEnd();
    if (wordSafePrefix) {
      return `${wordSafePrefix}…`;
    }
  }

  return `${visiblePrefix}…`;
}

export function shortenAssistantSummary(rawText, fallback = "未生成摘要") {
  const safeFallback = truncateText(
    sanitizeNotificationText(fallback, "未生成摘要"),
    CONVERSATION_NAME_CHARACTER_LIMIT,
    "未生成摘要",
  );
  const cleanedText = stripBidiControls(rawText)
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<image\b[\s\S]*?<\/image>/giu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\bhttps?:\/\/[^\s<>"'`,;，。！？；、]+/giu, " ")
    .replace(/::(?:code-comment|created-thread)\{[^}\n]*\}/gu, " ");

  const candidates = answerSummarySegments(cleanedText)
    .map((segment) =>
      redactSensitiveSummaryValues(
        stripListMarker(segment.trim())
          .replace(/^#{1,6}\s*/u, "")
          .replace(
            /^(?:好的|可以|明白了?|理解(?:了)?|没问题|收到|好哒?|当然|行)[，,。!！\s]+/u,
            "",
          )
          .replace(SUMMARY_SUCCESS_PREFIX_PATTERN, "")
          .replace(SUMMARY_TRANSITION_PREFIX_PATTERN, "")
          .replace(SUMMARY_LABEL_PATTERN, "")
          .replace(/[*_`~]/gu, "")
          .replace(/\s+/gu, " ")
          .trim(),
      ),
    )
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/u.test(line))
    .filter((line) => !containsAbsoluteLocalPath(line))
    .filter(
      (line) =>
        !/^(?:总结|简要总结|结果|最终结果|主要结果|完成情况|验证结果|下一步|说明)\s*[：:]?$/u.test(
          line,
        ),
    )
    .filter((line) => /[\p{Script=Han}A-Za-z0-9]/u.test(line));

  const candidate =
    candidates.find(
      (line) =>
        !GENERIC_SUMMARY_PATTERN.test(line) &&
        !SUMMARY_INTRODUCTION_PATTERN.test(line) &&
        !SUMMARY_HISTORICAL_CONTEXT_PATTERN.test(line) &&
        !SUMMARY_REQUEST_RESTATEMENT_PATTERN.test(line) &&
        !SUMMARY_STRUCTURE_PATTERN.test(line),
    ) ??
    candidates[0] ??
    safeFallback;
  const sanitizedCandidate = sanitizeNotificationText(
    candidate,
    safeFallback,
  );

  return truncateSummaryText(sanitizedCandidate, safeFallback);
}

export function conversationNameFromPayload(payload) {
  const messages = Array.isArray(payload?.["input-messages"])
    ? payload["input-messages"]
    : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    const text =
      typeof item === "string"
        ? item
        : typeof item?.text === "string"
          ? item.text
          : typeof item?.content === "string"
            ? item.content
            : "";
    if (text.trim()) {
      return shortenConversationName(text, payload?.cwd);
    }
  }

  return shortenConversationName("", payload?.cwd);
}

export function normalizeTaskName(rawText, cwd = "") {
  const fallback = safeBasename(cwd, "未命名任务");
  const cleanedText = stripBidiControls(rawText);
  const candidate = containsAbsoluteLocalPath(cleanedText)
    ? ""
    : cleanedText
        .replace(/[\[\]]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
  return truncateText(candidate, TASK_NAME_CHARACTER_LIMIT, fallback);
}

export function textFromUserMessage(record) {
  const payload = record?.payload ?? record;

  if (payload?.type === "user_message" && typeof payload?.message === "string") {
    return payload.message;
  }

  if (payload?.type !== "message" || payload?.role !== "user") {
    return "";
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (!Array.isArray(payload.content)) {
    return "";
  }

  return payload.content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      return typeof item?.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function textFromAssistantMessage(record) {
  const payload = record?.payload ?? record;

  if (
    payload?.type === "task_complete" &&
    typeof payload?.last_agent_message === "string"
  ) {
    return payload.last_agent_message;
  }
  return "";
}

function textForStatusClassification(rawText) {
  return stripBidiControls(rawText)
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ")
    .replace(/^(?: {4}|\t).+$/gmu, " ")
    .replace(/`[^`\r\n]*`/gu, " ")
    .replace(/!?\[[^\]\r\n]*\]\([^)\r\n]*\)/gu, " ")
    .replace(/“[^”\r\n]*”/gu, " ")
    .replace(/‘[^’\r\n]*’/gu, " ")
    .replace(/「[^」\r\n]*」/gu, " ")
    .replace(/『[^』\r\n]*』/gu, " ")
    .replace(/"[^"\r\n]*"/gu, " ")
    .replace(/::(?:code-comment|created-thread)\{[^}\n]*\}/gu, " ")
    .replace(/^\s*>\s?.*$/gmu, " ")
    .replace(
      /(?:^|[\r\n])\s*(?:[-*+]\s*)?(?:例如|比如|示例|反例|测试文本)\s*[：:].*$/gmu,
      " ",
    );
}

function withoutResolvedStatusPhrases(value) {
  return String(value ?? "")
    .replace(
      /(?:系统)?错误.{0,16}(?:已|已经)(?:修复|解决|排除)/gu,
      " ",
    )
    .replace(
      /(?:已|已经)(?:修复|解决|排除).{0,16}(?:系统)?错误/gu,
      " ",
    )
    .replace(
      /(?:安装|构建|编译|部署|验证|测试|配置|连接)?失败.{0,16}(?:已|已经|现已)(?:修复|解决|恢复|通过|完成)/gu,
      " ",
    )
    .replace(
      /(?:已|已经|现已)(?:修复|解决|恢复|通过|完成).{0,16}(?:安装|构建|编译|部署|验证|测试|配置|连接)?失败/gu,
      " ",
    )
    .replace(
      /(?:未|没有)(?:发现|出现)?(?:任何)?(?:错误|失败|异常|阻塞)/gu,
      " ",
    );
}

const STATUS_ERROR_PATTERN =
  /(?:无法完成|未能完成|没有完成|仍然失败|最终失败|测试未通过|配置失败|任务中断|系统错误|发生异常|连接失败|权限不足|被阻止|仍有.{0,12}错误|failed to|still failing|timed out|timeout|blocked)/iu;
const STATUS_DECISIVE_ERROR_PATTERN =
  /(?:无法完成|未能完成|没有完成|仍然失败|最终失败|测试未通过|任务中断|权限不足|被阻止|仍有.{0,12}错误|still failing|timed out|timeout|blocked)/iu;
const STATUS_FINAL_ERROR_PATTERN =
  /^(?:(?:安装|构建|编译|部署|验证|测试|配置|连接)?失败|系统错误|发生异常|failed to|error\b)/iu;
const STATUS_NEGATED_ACTION_CLAUSE_PATTERN =
  /^(?:请)?(?:你)?(?:不需要|无需|不用|不必|不再|不要|没必要)/u;
const STATUS_OPTIONAL_CONTEXT_CLAUSE_PATTERN =
  /^(?:(?:如果|若|如)(?:你)?(?:愿意|有需要|需要|想(?:要)?|方便|有空)(?:的话)?|你愿意的话|方便(?:的话)?|有空(?:的话)?|有问题|有需要|需要时|方便时|你可以)/u;
const STATUS_EXPLICIT_OPTIONAL_ENDING_PATTERN =
  /(?:本轮)?(?:无需|不用|不必|不需要)回复|也可以不(?:发|回复|告诉|操作|确认)|不(?:发|回复|告诉|操作|确认).{0,8}(?:也)?(?:可以|行)/u;
const STATUS_NO_USER_ACTION_PATTERN =
  /(?:(?:你)?(?:不需要|无需|不用|不必)(?:你)?(?:再)?(?:做|进行)?(?:任何)?(?:操作|确认|处理|执行|验收|测试|提供|上传|发送))/u;
const STATUS_NON_FEEDBACK_ACTION_PATTERN =
  /(?:确认|提供|上传|授权|点击|选择|操作|查看|打开|安装|下载|输入|填写|粘贴|发送|重启|执行|校准|验收|测试|实测|回放|按下?|截图|拍摄)/u;
const STATUS_DIRECT_REQUEST_CLAUSE_PATTERNS = [
  /^(?:(?:现在|接下来)?请(?:你)?|麻烦(?:你)?)(?:先|再|现在|接下来)?[^。！？!?；;\n]{0,64}(?:回复|确认|提供|上传|授权|点击|选择|操作|查看|打开|安装|下载|输入|填写|粘贴|发送|重启|告诉|执行|校准|验收|测试|实测|测(?:试)?|回放|按下?|截图|拍摄|做)/u,
  /^需要你(?:先|再|来|去)?[^。！？!?；;\n]{0,64}(?:回复|确认|提供|上传|授权|点击|选择|操作|查看|打开|安装|下载|输入|填写|粘贴|发送|重启|告诉|执行|校准|验收|测试|实测|测(?:试)?|回放|按下?|截图|拍摄|做)/u,
  /^(?:等待|等)你(?:确认|回复|操作|选择|提供|上传|授权|点击|按下?|测试|验收)/u,
  /^把[^。！？!?；;\n]{1,48}(?:告诉我|发给我|回复我)/u,
  /^(?:告诉我|回复我|发给我)/u,
  /^回复(?:\s|[：:]|$)/u,
  /^(?:只需|只需要)[^。！？!?；;\n]{0,48}(?:回复(?:我)?|告诉我|发给我|确认|上传|提供|操作)/u,
  /^(?:随后|然后|之后|接着|再|回来)(?:请)?(?:把[^。！？!?；;\n]{0,40})?(?:告诉我|发给我|回复我)/u,
  /^(?:(?:操作|测试|验证|试听|查看|选择|处理|设置|安装|下载|上传|修改|配置)?完成(?:以后|后)|(?:听|看|试|测试|验证|操作|处理|设置|修改)完|改完(?:保存)?|选好|确认好|准备好)(?:再|请|回来)?[^。！？!?；;\n]{0,40}(?:告诉我|发给我|回复(?:我)?)/u,
  /^[^。！？!?；;\n]{0,32}(?:以后|后)(?:再|请)?(?:回复(?:我)?|告诉我|发给我)/u,
  /^你(?:先|再)?[^，,。！？!?；;\n]{0,24}(?:听完|看完|试完|测试完|验证完|操作完|处理完|设置完|选好|确认好|准备好|完成后|完成以后)[^，,。！？!?；;\n]{0,24}(?:告诉我|发给我|回复我)/u,
  /^你(?:先|再|现在|接下来|只需|只需要|需要)[^。！？!?；;\n]{0,48}(?:点击|打开|选择|上传|下载|填写|输入|粘贴|授权|确认|回复|操作|重启|安装|发送|执行|校准|验收|测试|实测|回放|按下?|截图|拍摄)/u,
];
const STATUS_CONTINUATION_REQUEST_PATTERNS = [
  /(?:^|[，,；;：:\s])(?:有[^。！？!?；;\n]{0,32})?需要你确认(?:[^。！？!?；;\n]{0,48})/u,
  /(?:^|[，,；;：:\s])你确认[^。！？!?；;\n]{0,32}(?:的话|后)[^。！？!?；;\n]{0,48}我(?:就|会)/u,
  /(?:^|[，,；;：:\s])(?:下一步|接下来)(?![^。！？!?；;\n]{0,20}(?:我会|我将|系统会|自动))[^。！？!?；;\n]{0,64}(?:发给我|提供给我|上传给我|截图给我|回复|确认|提交给我)/u,
  /(?:^|[，,；;：:\s])(?:下一张(?:先|优先)?|最优先|优先)(?:请)?发(?!送)/u,
  /(?:完成(?:以后|后)|改完(?:保存)?后)[^。！？!?；;\n]{0,48}(?:回复(?:我)?|告诉我|发给我)/u,
];

function statusSentences(value) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .flatMap(
      (line) =>
        line.match(/[^。！？!?]+(?:[。！？!?]+|$)/gu) ?? [],
    )
    .map((sentence) =>
      stripListMarker(sentence.trim())
        .replace(/^#{1,6}\s*/u, "")
        .trim(),
    )
    .filter(Boolean);
}

function sentenceNeedsUserAction(sentence) {
  if (
    STATUS_EXPLICIT_OPTIONAL_ENDING_PATTERN.test(sentence) &&
    !STATUS_NON_FEEDBACK_ACTION_PATTERN.test(sentence)
  ) {
    return false;
  }

  const clauses = sentence
    .split(/[，,；;：:]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let optionalContext = false;

  for (const clause of clauses) {
    if (STATUS_NEGATED_ACTION_CLAUSE_PATTERN.test(clause)) {
      continue;
    }
    if (STATUS_OPTIONAL_CONTEXT_CLAUSE_PATTERN.test(clause)) {
      optionalContext = true;
      continue;
    }
    if (
      !optionalContext &&
      STATUS_DIRECT_REQUEST_CLAUSE_PATTERNS.some((pattern) =>
        pattern.test(clause),
      )
    ) {
      return true;
    }
  }

  return !optionalContext && /[？?]\s*$/u.test(sentence);
}

function hasRequiredUserAction(value) {
  return statusSentences(value).some(sentenceNeedsUserAction);
}

function hasContinuationRequest(value) {
  return statusSentences(value).some((sentence) => {
    if (
      STATUS_NEGATED_ACTION_CLAUSE_PATTERN.test(sentence) ||
      STATUS_EXPLICIT_OPTIONAL_ENDING_PATTERN.test(sentence)
    ) {
      return false;
    }
    return STATUS_CONTINUATION_REQUEST_PATTERNS.some((pattern) =>
      pattern.test(sentence),
    );
  });
}

function requiredActionCandidates(value) {
  return statusSentences(value).flatMap((sentence) => {
    const inheritedOptional =
      STATUS_OPTIONAL_CONTEXT_CLAUSE_PATTERN.test(sentence);
    const fragments = [
      {
        text: sentence,
        inheritedOptional: false,
        wholeSentence: true,
      },
    ];
    const clauses = sentence
      .split(/(?<!\d)[，,；;：:](?!\d)/u)
      .map((clause) => clause.trim())
      .filter(Boolean);
    if (clauses.length > 1) {
      fragments.push(
        ...clauses.map((text) => ({
          text,
          inheritedOptional,
          wholeSentence: false,
        })),
      );
    }
    return fragments;
  });
}

function requiredActionPriority(value, inheritedOptional = false) {
  const text = String(value ?? "");
  let priority = 0;

  if (
    /(?:回复我|告诉我|发给我|回复(?:\s|[“「『"'`：:]|$))/u.test(text)
  ) {
    priority += 100;
  }
  if (/需要你确认/u.test(text)) {
    priority += 70;
  }
  if (
    /你确认[^。！？!?；;\n]{0,32}(?:的话|后)[^。！？!?；;\n]{0,48}我(?:就|会)/u.test(
      text,
    )
  ) {
    priority += 90;
  }
  if (/(?:下一步|下一张|接下来|最优先|优先)/u.test(text)) {
    priority += 60;
  }
  if (/(?:^|[，,；;：:\s])(?:(?:现在|接下来)?请|麻烦)/u.test(text)) {
    priority += 50;
  }
  if (
    /(?:完成(?:以后|后)|改完(?:保存)?后|松开后|框选后|验收后)[^。！？!?；;\n]{0,48}(?:回复(?:我)?|告诉我|发给我)/u.test(
      text,
    )
  ) {
    priority += 55;
  }
  if (/(?:验收|实测|测试|回放|校准)/u.test(text)) {
    priority += 10;
  }
  if (/(?:截图|照片|文件|打码|PDF|链接|数字|名称|英文)/iu.test(text)) {
    priority += 5;
  }
  if (/[？?]\s*$/u.test(text)) {
    priority += 20;
  }
  if (
    inheritedOptional ||
    STATUS_OPTIONAL_CONTEXT_CLAUSE_PATTERN.test(text)
  ) {
    priority -= 80;
  }

  return priority;
}

function compactRequiredAction(value) {
  const text = String(value ?? "").trim();
  if (
    !/(?:回复我|告诉我|发给我|回复(?:\s|[“「『"'`：:]|$))/u.test(text)
  ) {
    return text;
  }

  return text.replace(
    /[，,；;]\s*(?:然后|随后|之后|接着)?我(?:会|将|就|再|继续)[^。！？!?]*[。！？!?：:]?\s*$/u,
    "。",
  );
}

function punctuateRequiredAction(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/[，,；;：:]+$/u, "");
  if (!text || /[。！？!?]$/u.test(text)) {
    return text;
  }
  return `${text}。`;
}

export function notificationBodyFromAssistantReply(
  rawText,
  status,
  fallback = "未生成摘要",
) {
  const label = typeof status === "string" ? status : status?.label;
  if (label !== "需要你回复") {
    return shortenAssistantSummary(rawText, fallback);
  }

  const safeFallback = shortenAssistantSummary("", fallback);
  const cleanedText = stripBidiControls(rawText)
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ")
    .replace(/<image\b[\s\S]*?<\/image>/giu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\bhttps?:\/\/[^\s<>"'`,;，。！？；、]+/giu, " ")
    .replace(/::(?:code-comment|created-thread)\{[^}\n]*\}/gu, " ");
  const candidates = requiredActionCandidates(cleanedText)
    .map(({ text, inheritedOptional, wholeSentence }) => ({
      inheritedOptional,
      wholeSentence,
      text: redactSensitiveSummaryValues(
        stripListMarker(text.trim())
          .replace(/^#{1,6}\s*/u, "")
          .replace(/[*_`~]/gu, "")
          .replace(/\s+/gu, " ")
          .trim(),
      ),
    }))
    .filter(({ text }) => Boolean(text))
    .filter(({ text }) => !containsAbsoluteLocalPath(text))
    .filter(({ text }) => {
      const classificationText = textForStatusClassification(text);
      return (
        hasRequiredUserAction(classificationText) ||
        hasContinuationRequest(classificationText)
      );
    })
    .map((candidate) => ({
      ...candidate,
      priority: requiredActionPriority(
        candidate.text,
        candidate.inheritedOptional,
      ) +
        (candidate.wholeSentence && /[？?]\s*$/u.test(candidate.text)
          ? 10
          : 0),
    }));
  const candidate = candidates.reduce((best, current) => {
    if (!best || current.priority > best.priority) {
      return current;
    }
    if (
      current.priority === best.priority &&
      Array.from(current.text).length < Array.from(best.text).length
    ) {
      return current;
    }
    return best;
  }, null)?.text;
  return candidate
    ? truncateSummaryText(
        sanitizeNotificationText(
          punctuateRequiredAction(compactRequiredAction(candidate)),
          safeFallback,
        ),
        safeFallback,
      )
    : shortenAssistantSummary(rawText, fallback);
}

export function classifyLastReply(lastReply) {
  const cleanedReply = textForStatusClassification(lastReply);
  const summary = textForStatusClassification(
    shortenAssistantSummary(cleanedReply, "未生成摘要"),
  );
  const endingSegments = summarySegments(cleanedReply)
    .map((segment) =>
      stripListMarker(segment.trim())
        .replace(/^#{1,6}\s*/u, "")
        .replace(/[*_~]/gu, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(-3);
  const decisiveEnding = endingSegments.join("\n");
  const finalSegment = endingSegments.at(-1) ?? "";

  const unresolvedSummary = withoutResolvedStatusPhrases(summary);
  const unresolvedEnding = withoutResolvedStatusPhrases(decisiveEnding);

  if (
    STATUS_ERROR_PATTERN.test(unresolvedSummary) ||
    STATUS_DECISIVE_ERROR_PATTERN.test(unresolvedEnding) ||
    STATUS_FINAL_ERROR_PATTERN.test(
      withoutResolvedStatusPhrases(finalSegment),
    )
  ) {
    return { icon: "⛔", label: "受阻或出错" };
  }

  if (STATUS_NO_USER_ACTION_PATTERN.test(finalSegment)) {
    return { icon: "✅", label: "本轮结束" };
  }

  if (
    hasRequiredUserAction(summary) ||
    hasRequiredUserAction(decisiveEnding) ||
    hasContinuationRequest(cleanedReply)
  ) {
    return { icon: "🔁", label: "需要你回复" };
  }

  return { icon: "✅", label: "本轮结束" };
}

export function completionDelayMilliseconds(payload) {
  const replyLength = Array.from(
    String(payload?.["last-assistant-message"] ?? ""),
  ).length;
  return Math.min(15_000, 5_000 + Math.floor(replyLength / 500) * 1_000);
}

export function formatNotification(status, taskName, bodyText) {
  const safeTaskName = truncateText(
    sanitizeNotificationText(taskName, "未命名任务"),
    TASK_NAME_CHARACTER_LIMIT,
    "未命名任务",
  );
  const safeBodyText = truncateText(
    sanitizeNotificationText(bodyText, "未生成摘要"),
    ANSWER_SUMMARY_CHARACTER_LIMIT,
    "未生成摘要",
  );
  return {
    title: `${status.icon} [${safeTaskName}]${status.label}`,
    body: `💬${safeBodyText}`,
  };
}
