export type BookValues = {
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
};

type BookField = keyof BookValues;
type ValidationError = {
  ok: false;
  error: "invalid_book_input";
  message: string;
  field?: BookField;
};

const FIELD_RULES = [
  { key: "title", label: "タイトル", maxLength: 200 },
  { key: "author", label: "作者名", maxLength: 120 },
  { key: "finishedOn", label: "読了日", maxLength: 10 },
  { key: "photoUrl", label: "写真URL", maxLength: 2048 },
  { key: "memo", label: "メモ", maxLength: 5000 },
] as const;

const BOOK_FIELDS = new Set<string>(FIELD_RULES.map(({ key }) => key));

function invalid(message: string, field?: BookField): ValidationError {
  return { ok: false, error: "invalid_book_input", message, ...(field ? { field } : {}) };
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isValidPhotoUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateBookInput(input: unknown):
  | { ok: true; value: BookValues }
  | ValidationError {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalid("書籍情報はJSONオブジェクトで送信してください。");
  }

  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !BOOK_FIELDS.has(key))) {
    return invalid("対応していない入力項目があります。");
  }

  const value: BookValues = {
    title: null,
    author: null,
    finishedOn: null,
    photoUrl: null,
    memo: null,
  };

  for (const { key, label, maxLength } of FIELD_RULES) {
    const fieldValue = raw[key];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (typeof fieldValue !== "string") {
      return invalid(`${label}は文字列で入力してください。`, key);
    }
    const trimmed = fieldValue.trim();
    if ([...trimmed].length > maxLength) {
      return invalid(`${label}は${maxLength}文字以内で入力してください。`, key);
    }
    value[key] = trimmed || null;
  }

  if (value.finishedOn && !isValidDate(value.finishedOn)) {
    return invalid("読了日はYYYY-MM-DD形式の実在する日付を入力してください。", "finishedOn");
  }
  if (value.photoUrl && !isValidPhotoUrl(value.photoUrl)) {
    return invalid("写真URLはhttp://またはhttps://で始まる有効なURLを入力してください。", "photoUrl");
  }
  if (!value.title && !value.author && !value.finishedOn && !value.memo) {
    return invalid("タイトル・作者名・読了日・メモのいずれか1項目を入力してください。");
  }

  return { ok: true, value };
}
